"""Writes pil_bilinear.json: a small random image and the SHA-256 of what Pillow's bilinear
resize makes of it at each size, which src/main/resize.ts must match to the bit.
Run: uv run --with numpy --with pillow python make_pil_bilinear.py"""
import hashlib
import json
from pathlib import Path

import numpy as np
import PIL
import PIL.Image

here = Path(__file__).parent
# Up, down, one side only, both pass orders Pillow picks between, and SAM2's 1024 x 1024. The
# last three are where Pillow 13's rule for the order differs from going by cost.
SIZES = [(64, 50), (11, 9), (37, 61), (100, 7), (5, 23), (11, 50), (200, 3), (3, 200), (60, 5),
         (20, 40), (40, 20), (1024, 1024), (36, 24), (38, 22), (40, 24), (47, 29), (4, 2)]

image = np.random.default_rng(7).integers(0, 256, size=(23, 37, 3), dtype=np.uint8)
hashes = {}
for w, h in SIZES:
    out = np.asarray(PIL.Image.fromarray(image).resize((w, h), resample=PIL.Image.BILINEAR))
    hashes[f"{w}x{h}"] = hashlib.sha256(out.tobytes()).hexdigest()

lines = [
    "{",
    f'  "pillow": "{PIL.__version__}",',
    f'  "width": {image.shape[1]},',
    f'  "height": {image.shape[0]},',
    f'  "pixels": {json.dumps(image.flatten().tolist(), separators=(",", ":"))},',
    '  "sha256": {',
    ",\n".join(f'    "{size}": "{digest}"' for size, digest in hashes.items()),
    "  }",
    "}",
]
(here / "pil_bilinear.json").write_text("\n".join(lines) + "\n")
