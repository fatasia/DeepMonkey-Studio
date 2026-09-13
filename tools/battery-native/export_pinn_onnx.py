"""Export the production-routed BatteryMFormer SPM-PINN expert as a standalone ONNX package."""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import pickle
import sys
from pathlib import Path
from types import SimpleNamespace

_torch_dll_handle = None


def prepare_torch_dll_search_path() -> None:
    if os.name != "nt":
        return
    spec = importlib.util.find_spec("torch")
    candidates = [Path(spec.origin).parent / "lib"] if spec and spec.origin else []
    candidates.extend(Path(entry) / "torch" / "lib" for entry in sys.path if entry)
    torch_lib = next((candidate for candidate in candidates if candidate.is_dir()), None)
    if torch_lib is None:
        return
    os.environ["PATH"] = f"{torch_lib}{os.pathsep}{os.environ.get('PATH', '')}"
    global _torch_dll_handle
    _torch_dll_handle = os.add_dll_directory(str(torch_lib))


prepare_torch_dll_search_path()
import numpy as np
import onnx
import onnxruntime as ort
import torch
from safetensors.torch import load_file

INPUT_NAMES = [
    "curves", "curve_mask", "condition_embedding", "soh_input",
    "cycle_features", "physics_condition",
]
OUTPUT_NAMES = [
    "soh_trajectory", "physical_soh", "physics_gate", "identifiability_score",
    "physical_observation_rmse", "physical_fit_score", "nominal_capacity_ah",
    "equivalent_resistance_ohm", "effective_diffusion_time_h", "degradation_rate",
    "chemistry_fade_scale", "ocv_min_v", "ocv_span_v", "exchange_c_rate",
    "overpotential_scale_v",
]
MODEL_VERSION = "batterymformer-spm-pinn-v9-fieldcal-seed7181"


class PinnExportWrapper(torch.nn.Module):
    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, curves, curve_mask, condition_embedding, soh_input,
                cycle_features, physics_condition):
        trajectory, state = self.model(
            cycle_curve_data=curves[:, :, :3],
            curve_attn_mask=curve_mask,
            aging_condition_embedding=condition_embedding,
            soc_input=curves[:, :, 3],
            soh_input=soh_input,
            cycle_level_features=cycle_features,
            physics_condition=physics_condition,
            return_physics=True,
        )
        return (
            trajectory, state["physical_soh"], state["physics_gate"],
            state["identifiability_score"], state["physical_observation_rmse"],
            state["physical_fit_score"], state["nominal_capacity_ah"],
            state["equivalent_resistance_ohm"], state["effective_diffusion_time_h"],
            state["degradation_rate"], state["chemistry_fade_scale"],
            state["ocv_min_v"], state["ocv_span_v"], state["exchange_c_rate"],
            state["overpotential_scale_v"],
        )


def main() -> None:
    arguments = parse_arguments()
    source_root = arguments.source_root.resolve()
    output_root = arguments.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    checkpoint = source_root / "checkpoints" / "batterymformer-physics" / "model.safetensors"
    config_path = checkpoint.parent / "args.json"
    gate_path = checkpoint.parent / "confidence_gate.json"
    config = SimpleNamespace(**json.loads(config_path.read_text(encoding="utf-8")))
    model = load_model(source_root, checkpoint, config)
    wrapper = PinnExportWrapper(model).eval()
    example = make_inputs(config)
    artifact = output_root / "batterymformer-spm-pinn.fp32.opset18.onnx"

    fastpath = torch.backends.mha.get_fastpath_enabled()
    torch.backends.mha.set_fastpath_enabled(False)
    try:
        with torch.inference_mode():
            torch.onnx.export(
                wrapper, example, artifact, input_names=INPUT_NAMES,
                output_names=OUTPUT_NAMES, opset_version=18,
                do_constant_folding=True, dynamo=False,
            )
    finally:
        torch.backends.mha.set_fastpath_enabled(fastpath)
    onnx.checker.check_model(onnx.load(artifact))
    validation = validate(wrapper, example, artifact)
    if validation["maxAbsoluteError"] > 5e-4 or not validation["finite"]:
        raise RuntimeError(f"PINN ONNX numerical validation failed: {validation}")

    embeddings = export_embeddings(source_root, output_root, int(config.d_llm))
    gate = json.loads(gate_path.read_text(encoding="utf-8"))
    adapter_path = output_root / "batterymformer-spm-pinn.adapter.json"
    adapter = {
        "schemaVersion": 1,
        "modelId": "battery.batterymformer-pinn",
        "modelVersion": MODEL_VERSION,
        "kind": "batterymformer-spm-pinn-v1",
        "runtime": "rust-ort",
        "session": {"inputs": INPUT_NAMES, "outputs": OUTPUT_NAMES},
        "model": {
            "earlyCycles": int(config.early_cycle_threshold),
            "curveLength": int(config.charge_discharge_length),
            "conditionEmbeddingSize": int(config.d_llm),
            "physicsConditionSize": 11,
            "predictionLength": int(config.pred_len),
            "eolThreshold": float(config.eol_threshold),
            "confidenceGate": gate,
        },
        "conditionEmbeddings": embeddings,
    }
    write_json(adapter_path, adapter)
    manifest_path = output_root / "batterymformer-spm-pinn.manifest.json"
    manifest = {
        "schemaVersion": 1,
        "modelId": "battery.batterymformer-pinn",
        "modelVersion": MODEL_VERSION,
        "runtime": "rust-ort",
        "source": {
            "checkpointSha256": sha256(checkpoint),
            "confidenceGateSha256": sha256(gate_path),
        },
        "artifact": descriptor(artifact),
        "runtimeAdapter": descriptor(adapter_path),
        "conditionEmbeddings": embeddings,
        "validation": {**validation, "allowedMaxAbsoluteError": 5e-4},
        "dependency": {"pythonRuntime": False, "sourceProject": False},
    }
    write_json(manifest_path, manifest)
    print(json.dumps({"artifact": descriptor(artifact), "validation": validation}, indent=2))


def load_model(source_root: Path, checkpoint: Path, config: SimpleNamespace):
    official_root = source_root / "vendor" / "BatteryMFormer"
    sys.path[:0] = [str(source_root), str(official_root)]
    module_path = official_root / "models" / "BatteryMFormer.py"
    spec = importlib.util.spec_from_file_location("battery_native_pinn", module_path)
    if not spec or not spec.loader:
        raise RuntimeError(f"Cannot load {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    model = module.Model(config)
    missing, unexpected = model.load_state_dict(load_file(str(checkpoint), device="cpu"), strict=False)
    allowed_missing = {"physics_head.chemistry_fade_log_scale"}
    if set(missing) - allowed_missing or unexpected:
        raise RuntimeError(f"Checkpoint mismatch: missing={missing}, unexpected={unexpected}")
    return model.cpu().eval()


def make_inputs(config: SimpleNamespace):
    generator = torch.Generator().manual_seed(7181)
    cycles = int(config.early_cycle_threshold)
    length = int(config.charge_discharge_length)
    curves = torch.randn((1, cycles, 4, length), generator=generator) * 0.1
    curves[:, :, 0] = 3.6 + curves[:, :, 0]
    curves[:, :, 1] = torch.linspace(1.0, -1.0, length)[None, None, :]
    curves[:, :, 2] = torch.linspace(0.0, 100.0, length)[None, None, :]
    curves[:, :, 3] = torch.linspace(0.01, 0.99, length)[None, None, :]
    mask = torch.ones((1, cycles), dtype=torch.float32)
    condition = torch.randn((1, 1, int(config.d_llm)), generator=generator) * 0.05
    soh = torch.linspace(1.0, 0.86, cycles).reshape(1, cycles, 1)
    features = torch.full((1, cycles, 2), 0.98, dtype=torch.float32)
    physics = torch.tensor([[1, 0, 0, 0, 0, 0, 1, 0, 0.2, 1, 1]], dtype=torch.float32)
    return curves, mask, condition, soh, features, physics


def validate(wrapper, inputs, artifact: Path) -> dict[str, float | bool]:
    session = ort.InferenceSession(str(artifact), providers=["CPUExecutionProvider"])
    with torch.inference_mode():
        expected = [value.detach().cpu().numpy() for value in wrapper(*inputs)]
    actual = session.run(OUTPUT_NAMES, {name: value.numpy() for name, value in zip(INPUT_NAMES, inputs)})
    differences = [np.abs(left - right) for left, right in zip(expected, actual)]
    return {
        "maxAbsoluteError": max(float(value.max(initial=0.0)) for value in differences),
        "meanAbsoluteError": float(np.concatenate([value.reshape(-1) for value in differences]).mean()),
        "finite": bool(all(np.isfinite(value).all() for value in actual)),
    }


def export_embeddings(source_root: Path, output_root: Path, columns: int) -> dict:
    source = source_root / "vendor" / "BatteryMFormer" / "data_provider" / "prompt_embeddings" / "Qwen3_total.pkl"
    with source.open("rb") as handle:
        values = pickle.load(handle)  # noqa: S301 - trusted local model asset
    keys = sorted(str(key) for key in values)
    matrix = np.concatenate([np.asarray(values[key], dtype=np.float32).reshape(1, -1) for key in keys])
    if matrix.shape != (len(keys), columns):
        raise RuntimeError(f"Embedding shape mismatch: {matrix.shape}")
    target = output_root / "batterymformer-spm-pinn.condition-embeddings.f32"
    target.write_bytes(matrix.astype("<f4", copy=False).tobytes(order="C"))
    return {**descriptor(target), "rows": len(keys), "columns": columns, "keys": keys, "fallbackPrefix": "CALB_"}


def descriptor(path: Path) -> dict:
    return {"fileName": path.name, "sha256": sha256(path), "sizeBytes": path.stat().st_size}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--output-root", type=Path, required=True)
    return parser.parse_args()


if __name__ == "__main__":
    main()
