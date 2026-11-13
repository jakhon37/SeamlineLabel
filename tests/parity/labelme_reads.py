"""Reads label files with labelme itself and rasterises them as its export scripts do.

    uv run --with labelme python tests/parity/labelme_reads.py FILE.json...

Works with labelme 5 and 7. Fails if labelme can't load a file, or a shape covers no pixels.
"""
import importlib.metadata
import importlib.util
import io
import os.path as osp
import sys

import numpy as np
import PIL.Image


LABELME = importlib.metadata.version("labelme")


def labelme_utils():
    """labelme_utils.py beside this script, found by its path, as python -I leaves this folder out"""
    spec = importlib.util.spec_from_file_location("labelme_utils", osp.join(osp.dirname(osp.abspath(__file__)), "labelme_utils.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def load(filename):
    # By version, so an import that fails for want of a system library says so
    if tuple(int(n) for n in LABELME.split(".")[:2]) >= (7, 10):
        # labelme 7.10 keeps the reader and rasteriser its export scripts use in examples/utils.py, not in
        # the package, and asks you to copy that file, as labelme_utils.py is. labelme's own loader must
        # still take the file.
        from labelme._label_file import read_label_file

        read_label_file(filename=filename)
        utils = labelme_utils()
        annotation = utils.load_label_file(filename)
        return annotation.shapes, annotation.image_data, lambda shape, shapes, names: utils.shapes_to_label(
            img_shape=shape, shapes=shapes, label_name_to_value=names
        )
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
