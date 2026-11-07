"""Writes discs.onnx, a tiny segmentation model for tests: red pixels are class 1, blue
pixels class 2, the rest background. Run: uv run --with onnx python make_discs.py"""
import json
from pathlib import Path

import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

here = Path(__file__).parent
# One 1x1 convolution, on pixels scaled to 0-1 (mean 0, std 1 in the sidecar)
weights = np.array([
    [[0.0, 0.0, 0.0]],     # background
    [[6.0, -3.0, -3.0]],   # red
    [[-3.0, -3.0, 6.0]],   # blue
], dtype=np.float32).reshape(3, 3, 1, 1)
bias = np.array([0.5, -1.0, -1.0], dtype=np.float32)
graph = helper.make_graph(
    [helper.make_node("Conv", ["input", "w", "b"], ["output"])],
    "discs",
    [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, 64, 64])],
    [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, 64, 64])],
    [numpy_helper.from_array(weights, "w"), numpy_helper.from_array(bias, "b")],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 13)])
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, here / "discs.onnx")
(here / "discs.json").write_text(json.dumps({"classes": ["red", "blue"], "mean": [0, 0, 0], "std": [1, 1, 1], "tile": 1024}, indent=2) + "\n")
