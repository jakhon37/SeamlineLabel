"""Writes tile.png, a small image of red and green noise, and tile.json, what Seamline's predict makes
of it with discs.onnx: the image is one tile, resized to the model's 64 x 64 with OpenCV's bilinear;
each pixel's class and confidence (the softmax's largest share, times 255, cut to a whole number) are
resized back with OpenCV's nearest and bilinear. The width, 98, is one where OpenCV's nearest takes
another pixel than x * 64 / 98 rounded down would (at x = 49).
make_discs.py's weights make a pixel of the resized tile red where 6 R - 3 G - 3 B > 382.5, and never
blue, as B is 0. The left side is a multiple of 3, so no pixel comes near enough to the line for
rounding in the model to move it across: the classes are exact. The confidences are worked out here
in float32, as PyTorch works them out, so another runtime may put a few of them 1 apart.
Run: uv run --offline --with numpy --with opencv-python-headless python make_tile.py"""
import json
from pathlib import Path

import cv2
import numpy as np

here = Path(__file__).parent
image = np.random.default_rng(5).integers(0, 256, size=(48, 98, 3), dtype=np.uint8)
image[:, :, 2] = 0
cv2.imwrite(str(here / "tile.png"), image[:, :, ::-1])
size = (image.shape[1], image.shape[0])

small = cv2.resize(image, (64, 64), interpolation=cv2.INTER_LINEAR)
r, g, b = (small[:, :, k].astype(int) for k in range(3))
red = 2 * (6 * r - 3 * g - 3 * b) > 765
labels = cv2.resize(red.astype(np.uint8), size, interpolation=cv2.INTER_NEAREST)

weights = np.array([[0, 0, 0], [6, -3, -3], [-3, -3, 6]], dtype=np.float32)
bias = np.array([0.5, -1, -1], dtype=np.float32)
scores = np.einsum("kc,hwc->khw", weights, small.astype(np.float32) / np.float32(255)) + bias[:, None, None]
best = np.float32(1) / np.exp(scores - scores.max(0)).sum(0, dtype=np.float32)
confidence = cv2.resize((best * 255).astype(np.uint8), size, interpolation=cv2.INTER_LINEAR)

(here / "tile.json").write_text(json.dumps({
    "opencv": cv2.__version__,
    "labels": ["".join(str(v) for v in row) for row in labels],
    "confidence": [row.tobytes().hex() for row in confidence],
}, indent=2) + "\n")
