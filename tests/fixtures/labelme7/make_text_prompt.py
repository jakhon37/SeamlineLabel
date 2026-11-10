"""Runs labelme 7's AI text prompt on a photo with osam's YOLO-World, for e2e/labelme7.spec.ts:
Seamtag must find the same boxes. Needs yoloworld:latest in ~/.cache/osam (640 MB), so it's run
by hand:

    uv run --no-project --with labelme==7.9.1 python make_text_prompt.py

Writes text_prompt.json beside this file.
"""
import importlib.metadata
import json
from pathlib import Path

import numpy as np
import PIL.Image
from labelme._automation._osam_session import OsamSession
from labelme._automation._text_detection import propose_shapes_from_texts

here = Path(__file__).resolve().parent
PHOTO = here.parent.parent / "data" / "raw" / "2011_000003.jpg"


def main():
    image = np.asarray(PIL.Image.open(PHOTO).convert("RGB"))
    out = {"labelme": importlib.metadata.version("labelme"), "osam": importlib.metadata.version("osam")}
    for texts in (["person"], ["person", "bottle"]):
        shapes = propose_shapes_from_texts(
            session=OsamSession(model_name="yoloworld:latest"),
            image=image,
            image_id="photo",
            texts=texts,
            shape_type="rectangle",
            existing_shapes=[],
            iou_threshold=0.5,
            score_threshold=0.1,
            image_size=(image.shape[1], image.shape[0]),
            polygon_detail=60,
        )
        out[",".join(texts)] = [
            {"label": s.label, "shape_type": s.shape_type, "points": np.asarray(s.points, dtype=np.float64).tolist(), "description": s.description}
            for s in shapes
        ]
    (here / "text_prompt.json").write_text(json.dumps(out) + "\n")


main()
