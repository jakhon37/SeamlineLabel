"""Writes cv_linear.json: a small random image and the SHA-256 of what OpenCV's INTER_LINEAR resize
makes of it at each size, in colour and in grey, which src/main/resize.ts must match to the bit.
Seamline's predict resizes each tile so (albumentations' Resize calls cv2.resize).
Run: uv run --offline --with numpy --with opencv-python-headless python make_cv_linear.py"""
import hashlib
import json
from pathlib import Path

import cv2
import numpy as np

here = Path(__file__).parent
# Shrinking and growing, one side only, exact halving (which OpenCV averages 2 x 2 blocks for),
# halving one side only, other whole-number shrinks, a single pixel, a single row or column, and
# sizes Seamline's models take
SIZES = [(19, 13), (38, 13), (19, 26), (9, 6), (12, 13), (37, 25), (39, 27), (76, 52), (100, 7), (5, 60),
         (13, 19), (1, 1), (1, 26), (38, 1), (3, 2), (256, 256), (512, 512), (64, 64)]

image = np.random.default_rng(11).integers(0, 256, size=(26, 38, 3), dtype=np.uint8)
grey = np.ascontiguousarray(image[:, :, 0])


def hashes(pixels: np.ndarray) -> str:
    sizes = []
    for w, h in SIZES:
        out = cv2.resize(pixels, (w, h), interpolation=cv2.INTER_LINEAR)
        sizes.append(f'    "{w}x{h}": "{hashlib.sha256(out.tobytes()).hexdigest()}"')
    return ",\n".join(sizes)


lines = [
    "{",
    f'  "opencv": "{cv2.__version__}",',
    f'  "width": {image.shape[1]},',
    f'  "height": {image.shape[0]},',
    f'  "pixels": {json.dumps(image.flatten().tolist(), separators=(",", ":"))},',
    '  "rgb": {',
    hashes(image),
    "  },",
    '  "grey": {',
    hashes(grey),
    "  }",
    "}",
]
(here / "cv_linear.json").write_text("\n".join(lines) + "\n")
