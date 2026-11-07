"""Reads label files with labelme itself and rasterises them as its export scripts do.

    uv run --with labelme python tests/parity/labelme_reads.py FILE.json...

Works with labelme 5 and 7. Fails if labelme can't load a file, or a shape covers no pixels.
"""
import importlib.metadata
import io
import os.path as osp
import sys

import numpy as np
import PIL.Image


LABELME = importlib.metadata.version("labelme")


def load(filename):
    # By version, so an import that fails for want of a system library says so
    if int(LABELME.split(".")[0]) >= 7:
        from labelme._label_file import read_label_file
        from labelme._utils._mask import shapes_to_label

        annotation = read_label_file(filename=filename)
        return annotation.shapes, annotation.image_data, lambda shape, shapes, names: shapes_to_label(
            img_shape=shape, shapes=shapes, label_name_to_value=names
        )
    import labelme  # labelme 5
    from labelme import utils

    label_file = labelme.LabelFile(filename=filename)
    data = label_file.imageData
    if data is None:
        with open(osp.join(osp.dirname(filename), label_file.imagePath), "rb") as f:
            data = f.read()
    return label_file.shapes, data, utils.shapes_to_label


def main() -> None:
    print("labelme", LABELME)
    for filename in sys.argv[1:]:
        shapes, data, to_label = load(filename)
        image = np.asarray(PIL.Image.open(io.BytesIO(data)))
        names = {"_background_": 0}
        for shape in shapes:
            names.setdefault(shape["label"], len(names))
        cls, _ = to_label(image.shape, shapes, names)
        for shape in shapes:
            one, _ = to_label(image.shape, [shape], names)
            assert one.any(), f"{filename}: {shape['shape_type']} {shape['label']} covers nothing"
        kinds = sorted({s["shape_type"] for s in shapes})
        print(f"ok {osp.basename(osp.dirname(filename))}/{osp.basename(filename)}: {len(shapes)} shapes ({', '.join(kinds)}), {int((cls > 0).sum())} labelled pixels")


if __name__ == "__main__":
    main()
