"""Reads the Pascal VOC, YOLO and CreateML files Seamtag wrote with LabelImg's own readers, and
writes the same boxes with LabelImg's own writers, which must give the same bytes.

    uv run --with labelImg==1.8.6 python tests/parity/labelimg_reads.py DIR EXPECTED.json

EXPECTED.json, written by e2e/labelimg.spec.ts, names each image's format and the boxes saved.
Works with LabelImg 1.8.6 and its master branch, which also writes CreateML's `verified`.
"""
import inspect
import json
import os.path as osp
import sys
import tempfile

from PyQt5.QtGui import QImage
from libs.create_ml_io import CreateMLReader, CreateMLWriter
from libs.labelFile import LabelFile
from libs.pascal_voc_io import PascalVocReader
from libs.yolo_io import YoloReader

# master writes and reads CreateML's verified mark; 1.8.6 reads every file as verified
VERIFIED_IN_CREATEML = "verified" in inspect.getsource(CreateMLWriter.write)


def corners(points):
    """A box as LabelImg holds one: the first corner, then round"""
    (x0, y0), (x1, y1) = points
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def whole(points):
    """The box LabelImg saves in VOC and YOLO, and reads back from them"""
    x0, y0, x1, y1 = LabelFile.convert_points_to_bnd_box(corners(points))
    return [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]


def check(name, got, want):
    if got != want:
        sys.exit(f"{name}: LabelImg reads\n  {got}\nwhere Seamtag saved\n  {want}")


def same_bytes(name, ours, theirs):
    with open(ours, "rb") as a, open(theirs, "rb") as b:
        mine, labelimg = a.read(), b.read()
    if not VERIFIED_IN_CREATEML and ours.endswith(".json"):
        # LabelImg 1.8.6 writes no verified key
        mine = mine.replace(b'"verified": false, ', b"").replace(b'"verified": true, ', b"")
    if mine != labelimg:
        sys.exit(f"{name}: LabelImg writes these boxes as\n  {labelimg!r}\nwhere Seamtag wrote\n  {mine!r}")


def main():
    folder, expected_file = sys.argv[1], sys.argv[2]
    with open(expected_file) as f:
        expected = json.load(f)
    print("LabelImg", "master" if VERIFIED_IN_CREATEML else "1.8.6")
    out = tempfile.mkdtemp()
    for image_name, want in expected.items():
        image = osp.join(folder, image_name)
        stem = osp.splitext(image_name)[0]
        fmt = want["format"]
        file = osp.join(folder, stem + {"voc": ".xml", "yolo": ".txt", "createml": ".json"}[fmt])
        if fmt == "voc":
            reader = PascalVocReader(file)
        elif fmt == "yolo":
            reader = YoloReader(file, QImage(image))
        else:
            reader = CreateMLReader(file, image)
        got = reader.get_shapes()
        if "labels" in want:
            # Drawn by hand: what matters is that it reads
            check(file, [s[0] for s in got], want["labels"])
            print(f"ok {osp.basename(file)}: {len(got)} boxes ({fmt}), read")
            continue
        shapes = [{"label": s["label"], "points": corners(s["points"]), "difficult": s["difficult"],
                   "line_color": None, "fill_color": None} for s in want["shapes"]]
        label_file = LabelFile()
        label_file.verified = want.get("verified", False)
        if fmt == "voc":
            check(file, [(s[0], s[1], s[4]) for s in got], [(s["label"], whole(s["points"]), s["difficult"]) for s in want["shapes"]])
            check(file + " verified", reader.verified, want["verified"])
            label_file.save_pascal_voc_format(osp.join(out, stem + ".xml"), shapes, image, None)
            same_bytes(file, file, osp.join(out, stem + ".xml"))
        elif fmt == "yolo":
            # YOLO keeps neither the difficult flag nor the verified mark
            check(file, [(s[0], s[1]) for s in got], [(s["label"], whole(s["points"])) for s in want["shapes"]])
            with open(osp.join(folder, "classes.txt")) as f:
                classes = f.read().strip("\n").split("\n")
            label_file.save_yolo_format(osp.join(out, stem + ".txt"), shapes, image, None, list(classes))
            same_bytes(file, file, osp.join(out, stem + ".txt"))
            same_bytes(file, osp.join(folder, "classes.txt"), osp.join(out, "classes.txt"))
        else:
            boxes = [(s[0], [tuple(round(v, 9) for v in p) for p in s[1]]) for s in got]
            sorted_box = lambda p: [(min(p[0][0], p[1][0]), min(p[0][1], p[1][1])), (max(p[0][0], p[1][0]), min(p[0][1], p[1][1])),
                                    (max(p[0][0], p[1][0]), max(p[0][1], p[1][1])), (min(p[0][0], p[1][0]), max(p[0][1], p[1][1]))]
            check(file, boxes, [(s["label"], [tuple(round(v, 9) for v in p) for p in sorted_box(s["points"])]) for s in want["shapes"]])
            if VERIFIED_IN_CREATEML:
                check(file + " verified", reader.verified, want["verified"])
            label_file.save_create_ml_format(osp.join(out, stem + ".json"), shapes, image, None, [])
            same_bytes(file, file, osp.join(out, stem + ".json"))
        print(f"ok {osp.basename(file)}: {len(got)} boxes ({fmt}), read and written as LabelImg does")


if __name__ == "__main__":
    main()
