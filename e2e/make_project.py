"""Synthetic project: labelled discs, plus one very large TIFF. Usage: make_project.py DIR"""
import json
import math
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw

Image.MAX_IMAGE_PIXELS = None
root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
random.seed(1)
for i in range(12):
    image = Image.new("RGB", (320, 240), (60, 70, 80))
    cx, cy, r = random.randint(70, 250), random.randint(70, 170), random.randint(30, 60)
    ImageDraw.Draw(image).ellipse((cx - r, cy - r, cx + r, cy + r), fill=(230, 180, 60))
    image.save(root / f"disc_{i:02d}.png")
    if i < 10:
        points = [
            [cx + r * math.cos(a / 16 * 6.283), cy + r * math.sin(a / 16 * 6.283)] for a in range(16)
        ]
        shape = {"label": "disc", "points": points, "shape_type": "polygon", "flags": {}}
        doc = {"version": "5.5.0", "flags": {}, "shapes": [shape], "imagePath": f"disc_{i:02d}.png",
               "imageData": None, "imageHeight": 240, "imageWidth": 320}
        (root / f"disc_{i:02d}.json").write_text(json.dumps(doc))
big = Image.effect_noise((6050, 12300), 40).convert("RGB")
ImageDraw.Draw(big).ellipse((2000, 5000, 4000, 7000), fill=(230, 180, 60))
big.save(root / "zz_large.tif", compression="tiff_lzw")
print((root / "zz_large.tif").stat().st_size // 1_000_000, "MB")
