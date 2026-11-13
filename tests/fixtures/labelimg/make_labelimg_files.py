"""Writes label files with LabelImg's own code, and what LabelImg reads back from them, for
tests/unit/formats.test.ts: Seamtag must write the same bytes and read the same boxes.

    uv run --no-project --python 3.12 --with labelImg==1.8.6 python make_labelimg_files.py 1.8.6
    uv run --no-project --python 3.12 --with 'labelImg @ git+https://github.com/HumanSignal/labelImg@b33f965' python make_labelimg_files.py master

1.8.6 is the last release. master (b33f965) differs in CreateML only: it writes and reads `verified`.
Each run fills a folder named after its argument; python_numbers.json holds Python's own
'%.6f' and round(), which LabelImg's YOLO files depend on.
"""
import json
import random
import shutil
import sys
from pathlib import Path

from PyQt5.QtGui import QImage
from libs.create_ml_io import CreateMLReader
from libs.labelFile import LabelFile
from libs.pascal_voc_io import PascalVocReader
from libs.yolo_io import YoloReader

here = Path(__file__).parent
out = here / sys.argv[1]
shutil.rmtree(out, ignore_errors=True)
for sub in ("voc", "yolo", "createml"):
    (out / sub).mkdir(parents=True)

# Boxes as LabelImg holds them: four corners from the first one clicked
CASES = [
    {"image": "cars.png", "size": [64, 48], "grey": False, "verified": True, "shapes": [
        ("car", [(10.6, 12.2), (40.9, 12.2), (40.9, 30.5), (10.6, 30.5)], False),
        # The whole image: saved from 1, and truncated
        ("a & <b>", [(0.0, 0.0), (64.0, 0.0), (64.0, 48.0), (0.0, 48.0)], True),
        # Drawn from the bottom right
        ("고양이", [(50.2, 40.7), (20.1, 40.7), (20.1, 5.3), (50.2, 5.3)], False),
        # YOLO's centre is 5/128 = 0.0390625, a half that Python rounds to even
        ("dog", [(2.0, 3.0), (3.0, 3.0), (3.0, 9.0), (2.0, 9.0)], False),
    ]},
    {"image": "grey.png", "size": [50, 40], "grey": True, "verified": False, "shapes": [
        ("cat", [(5.5, 6.5), (25.25, 6.5), (25.25, 33.75), (5.5, 33.75)], True),
    ]},
    {"image": "empty.png", "size": [32, 32], "grey": False, "verified": False, "shapes": []},
]
# LabelImg's predefined classes; new labels are added after them as boxes are saved
classes = ["dog", "cat"]


def image_of(case):
    w, h = case["size"]
    image = QImage(w, h, QImage.Format_Grayscale8 if case["grey"] else QImage.Format_RGB32)
    image.fill(0x80 if case["grey"] else 0x445566)
    return image


def read_back(shapes):
    return [{"label": label, "points": [list(p) for p in points], "difficult": bool(difficult)}
            for label, points, _line, _fill, difficult in shapes]


expected = []
for case in CASES:
    image = image_of(case)
    stem = case["image"].rsplit(".", 1)[0]
    # The image's path as LabelImg records it in Pascal VOC: made up here, so no one's folders show
    image_path = f"/data/images/{case['image']}"
    shapes = [{"label": label, "points": points, "difficult": difficult, "line_color": None, "fill_color": None}
              for label, points, difficult in case["shapes"]]
    label_file = LabelFile()
    label_file.verified = case["verified"]
    label_file.save_pascal_voc_format(str(out / "voc" / f"{stem}.xml"), shapes, image_path, image)
    label_file.save_yolo_format(str(out / "yolo" / f"{stem}.txt"), shapes, image_path, image, classes)
    label_file.save_create_ml_format(str(out / "createml" / f"{stem}.json"), shapes, image_path, image, classes)
    voc = PascalVocReader(str(out / "voc" / f"{stem}.xml"))
    yolo = YoloReader(str(out / "yolo" / f"{stem}.txt"), image)
    createml = CreateMLReader(str(out / "createml" / f"{stem}.json"), image_path)
    expected.append({
        "image": case["image"], "path": image_path, "size": case["size"], "depth": 1 if image.isGrayscale() else 3,
        "verified": case["verified"],
        # As Seamtag holds them: the first corner and the one across
        "shapes": [{"label": label, "points": [list(points[0]), list(points[2])], "difficult": difficult}
                   for label, points, difficult in case["shapes"]],
        # The classes YOLO knew after this image was saved
        "classes": list(classes),
        "read": {
            "voc": {"verified": voc.verified, "shapes": read_back(voc.get_shapes())},
            "yolo": {"verified": yolo.verified, "shapes": read_back(yolo.get_shapes())},
            "createml": {"verified": createml.verified, "shapes": read_back(createml.get_shapes())},
        },
    })

# A YOLO file as other tools write it: values that land on a half pixel, which Python rounds to even
hand = "0 0.515625 0.5 0.015625 0.1\n1 0.25 0.75 0.5 0.5\n"
(out / "yolo-hand").mkdir()
(out / "yolo-hand" / "classes.txt").write_text("dog\ncat\n")
(out / "yolo-hand" / "half.txt").write_text(hand)
hand_image = QImage(64, 40, QImage.Format_RGB32)
expected.append({"image": "half.png", "size": [64, 40], "read": {
    "yolo": {"shapes": read_back(YoloReader(str(out / "yolo-hand" / "half.txt"), hand_image).get_shapes())}}})

# classes.txt as editors that write a byte order mark save it, such as Windows Notepad before 2019:
# LabelImg reads the mark as part of the first class's name
(out / "yolo-bom").mkdir()
(out / "yolo-bom" / "classes.txt").write_text("\ufeffdog\ncat\n", encoding="utf-8")
(out / "yolo-bom" / "marked.txt").write_text(hand)
expected.append({"image": "marked.png", "size": [64, 40], "read": {
    "yolo": {"shapes": read_back(YoloReader(str(out / "yolo-bom" / "marked.txt"), hand_image).get_shapes())}}})

(out / "labelimg.json").write_text(json.dumps(expected, ensure_ascii=False, indent=1) + "\n")

# Python's '%.6f' and round(), with the halves where JavaScript's toFixed and Math.round differ
rng = random.Random(7)
fixed = [k / 128 for k in range(129)] + [k / 1024 for k in range(0, 1025, 7)] + [rng.random() for _ in range(400)]
rounded = [k + 0.5 for k in range(-3, 40)] + [rng.random() * 2000 for _ in range(200)] + [64 * (k / 128) for k in range(129)]
pairs = {"fixed": [[x, "%.6f" % x] for x in fixed], "round": [[x, round(x)] for x in rounded]}
(here / "python_numbers.json").write_text("{\n" + ",\n".join(
    f'  "{k}": [\n' + ",\n".join("    " + json.dumps(p) for p in v) + "\n  ]" for k, v in pairs.items()) + "\n}\n")
print("wrote", out)
