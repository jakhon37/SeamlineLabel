"""Runs labelme 7's own code on test masks, detections, boxes and prompts, for
tests/unit/aishapes.test.ts: Seamtag must turn AI results into the same shapes.

    uv run --no-project --with labelme==7.9.1 python make_ai_shapes.py

Writes ai_shapes.json beside this file: each mask (rows of 0 and 1) with labelme's polygons
at several details, its circle and its rotated rectangle; greedy suppression and matching
against shapes already drawn; shapes of every output type; osam's non-maximum suppression;
and CLIP's tokens for some prompts.
"""
import importlib.metadata
import json
from pathlib import Path

import numpy as np
import osam.apis
from labelme._automation._geometry import compute_circle_from_mask
from labelme._automation._geometry import compute_oriented_rectangle_from_mask
from labelme._automation._geometry import compute_polygons_from_mask
from labelme._automation._shape_builders import Detection
from labelme._automation._shape_builders import shapes_from_detections
from labelme._automation._suppression import match_detections_to_existing_shapes
from labelme._automation._suppression import suppress_detections_greedy
from labelme._shape import Shape
from osam._models.yoloworld.clip import tokenize

rng = np.random.default_rng(0)


def disc(h, w, cy, cx, r):
    yy, xx = np.mgrid[:h, :w]
    return (yy - cy) ** 2 + (xx - cx) ** 2 <= r**2


def ellipse(h, w, cy, cx, a, b, degrees):
    yy, xx = np.mgrid[:h, :w]
    t = np.radians(degrees)
    u = (xx - cx) * np.cos(t) + (yy - cy) * np.sin(t)
    v = -(xx - cx) * np.sin(t) + (yy - cy) * np.cos(t)
    return (u / a) ** 2 + (v / b) ** 2 <= 1


def masks():
    out = {}
    out["disc"] = disc(60, 60, 30, 30, 20)
    out["ellipse"] = ellipse(80, 90, 40, 45, 34, 12, 30)
    lands = np.zeros((70, 90), bool)
    lands[5:40, 5:40] = True
    lands[50:52, 70:72] = True
    lands[45:51, 50:56] = True
    out["lands"] = lands
    out["ring"] = disc(64, 64, 32, 32, 26) & ~disc(64, 64, 32, 32, 10)
    corner = np.zeros((40, 50), bool)
    corner[:25, :8] = True
    corner[:8, :40] = True
    out["corner"] = corner
    noisy = disc(50, 50, 25, 25, 17)
    edge = disc(50, 50, 25, 25, 20) & ~disc(50, 50, 25, 25, 14)
    noisy[edge] = rng.random(edge.sum()) < 0.5
    out["noisy"] = noisy
    line = np.zeros((20, 20), bool)
    line[np.arange(3, 17), np.arange(3, 17)] = True
    out["line"] = line
    pixel = np.zeros((5, 5), bool)
    pixel[2, 2] = True
    out["pixel"] = pixel
    diagonal = np.zeros((12, 12), bool)
    diagonal[2:6, 2:6] = True
    diagonal[6:10, 6:10] = True
    out["diagonal"] = diagonal
    out["full"] = np.ones((9, 13), bool)
    out["empty"] = np.zeros((6, 6), bool)
    return out


def rows(mask):
    return ["".join("1" if v else "0" for v in row) for row in mask]


def floats(a):
    return None if a is None else np.asarray(a, dtype=np.float64).tolist()


def shape_json(s):
    return {
        "label": s.label,
        "shape_type": s.shape_type,
        "points": floats(s.points),
        "group_id": s.group_id,
        "description": s.description,
    }


def detection(mask, x, y, label=None, score=0.5):
    ys, xs = np.nonzero(mask)
    y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
    return Detection(
        bbox=(float(x + x0), float(y + y0), float(x + x1), float(y + y1)),
        mask=mask[y0 : y1 + 1, x0 : x1 + 1],
        label=label,
        score=score,
    )


def position(items, item):
    # Detections compare their arrays, so find them by identity
    return next(i for i, x in enumerate(items) if x is item)


def detection_json(d):
    return {
        "box": list(d.bbox),
        "rows": None if d.mask is None else rows(d.mask),
        "label": d.label,
        "score": d.score,
    }


def main():
    out = {"labelme": importlib.metadata.version("labelme"), "osam": importlib.metadata.version("osam")}

    out["masks"] = {}
    for name, mask in masks().items():
        entry = {"rows": rows(mask), "polygons": {}}
        for detail in (0, 30, 60, 85, 100):
            entry["polygons"][detail] = [floats(p) for p in compute_polygons_from_mask(mask=mask, detail=detail)]
        circle = compute_circle_from_mask(mask=mask)
        entry["circle"] = None if circle is None else [circle.cx, circle.cy, circle.radius]
        entry["oriented_rectangle"] = floats(compute_oriented_rectangle_from_mask(mask=mask))
        out["masks"][name] = entry

    m = masks()
    big = disc(40, 40, 20, 20, 18)
    small = disc(40, 40, 20, 20, 8)
    detections = [
        detection(big, 10, 10, "tree", 0.9),
        detection(small, 10, 10, "tree", 0.8),  # inside the first: contained
        detection(small, 10, 10, "bush", 0.7),  # another label: kept
        detection(big, 14, 12, "tree", 0.6),  # mostly the first
        detection(big, 60, 10, "tree", 0.5),  # elsewhere
    ]
    out["greedy"] = {
        "detections": [detection_json(d) for d in detections],
        "kept": {
            str(t): [position(detections, d) for d in suppress_detections_greedy(detections=detections, iou_threshold=t)]
            for t in (0.3, 0.5, 0.9)
        },
    }

    existing = [
        Shape(label="a", shape_type="rectangle", points=np.array([[11.0, 11.0], [47.0, 47.0]])),
        Shape(label="b", shape_type="polygon", points=np.array([[60.0, 10.0], [100.0, 12.0], [98.0, 50.0], [62.0, 48.0]])),
        Shape(label="c", shape_type="circle", points=np.array([[30.0, 80.0], [42.0, 80.0]])),
        Shape(label="d", shape_type="oriented_rectangle", points=np.array([[120.0, 10.0], [150.0, 20.0], [143.0, 41.0], [113.0, 31.0]])),
        Shape(label="e", shape_type="mask", points=np.array([[70.0, 70.0], [79.0, 79.0]]), mask=disc(10, 10, 5, 5, 4)),
        Shape(label="f", shape_type="line", points=np.array([[0.0, 0.0], [5.0, 5.0]])),
    ]
    queries = [
        detection(big, 10, 10),
        detection(disc(40, 40, 20, 20, 19), 60, 10),
        detection(disc(30, 30, 15, 15, 12), 15, 65),
        detection(ellipse(40, 45, 20, 22, 17, 9, 18), 110, 5),
        detection(disc(12, 12, 6, 6, 4), 69, 69),
        detection(disc(20, 20, 10, 10, 8), 200, 200),
    ]
    match = match_detections_to_existing_shapes(detections=queries, existing_shapes=existing)
    out["match"] = {
        "existing": [
            {"shape_type": s.shape_type, "points": floats(s.points), "label": s.label, "rows": None if s.mask is None else rows(s.mask)}
            for s in existing
        ],
        "detections": [detection_json(d) for d in queries],
        "fresh": [position(queries, d) for d in match.new_detections],
        "matched": [position(existing, s) for s in match.matching_shapes],
    }

    built = {}
    sources = [
        detection(m["lands"], 3, 4, "x"),
        detection(m["ellipse"], 0, 0, "y"),
        detection(m["ellipse"], -20, -15, "z"),  # partly outside a 100x100 image
        Detection(bbox=(5.0, 6.0, 25.0, 16.0), mask=None, label="box"),
    ]
    for shape_type in ("polygon", "mask", "rectangle", "circle", "oriented_rectangle"):
        built[shape_type] = [
            shape_json(s)
            for s in shapes_from_detections(detections=sources, shape_type=shape_type, image_size=(100, 100), polygon_detail=60)
        ]
    out["built"] = {"detections": [detection_json(d) for d in sources], "shapes": built}

    boxes = rng.uniform(0, 100, (40, 4)).astype(np.float32)
    boxes[:, 2:] = boxes[:, :2] + rng.uniform(5, 40, (40, 2)).astype(np.float32)
    scores = rng.uniform(0, 1, (40, 3)).astype(np.float32)
    out["nms"] = {"boxes": boxes.tolist(), "scores": scores.tolist(), "runs": []}
    for iou, score, most in ((0.5, 0.1, 100), (0.3, 0.5, 5), (1.0, 0.0, 1000), (0.5, 0.2, 8)):
        b, s, labels, indices = osam.apis.non_maximum_suppression(
            boxes=boxes, scores=scores, iou_threshold=iou, score_threshold=score, max_num_detections=most
        )
        out["nms"]["runs"].append(
            {"iou": iou, "score": score, "max": most, "indices": indices.tolist(), "labels": labels.tolist(), "scores": s.tolist()}
        )

    texts = ["dog", "a photo of a cat", "Traffic Light", "person's bag", "  multiple   spaces ", "café", "&amp; co",
             "123 apples", "visual", " ", "über-cool!!", "日本語", "🐶 dog", "hot-dog stand", "I'll go"]
    out["tokens"] = {t: [int(v) for v in tokenize(texts=[t], context_length=77)[0] if v] for t in texts}

    (Path(__file__).parent / "ai_shapes.json").write_text(json.dumps(out) + "\n")


main()
