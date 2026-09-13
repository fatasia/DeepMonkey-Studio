"""Offline exporter for the SPM-PINO checkpoint used by the Rust runtime.

Python and PyTorch are build-time tools only.  The generated ONNX graph contains
the model weights and a real-valued DFT replacement for torch.fft, so the product
runtime does not load Python or PyTorch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np
import torch
from torch import Tensor, nn


TIME_STEPS = 64


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def real_dft_forward(self: nn.Module, values: Tensor) -> Tensor:
    real = torch.einsum("bin,kn->bik", values, self.export_cos)
    imaginary = -torch.einsum("bin,kn->bik", values, self.export_sin)
    out_real = (
        torch.einsum("bik,iok->bok", real, self.export_weight_real)
        - torch.einsum("bik,iok->bok", imaginary, self.export_weight_imag)
    )
    out_imaginary = (
        torch.einsum("bik,iok->bok", real, self.export_weight_imag)
        + torch.einsum("bik,iok->bok", imaginary, self.export_weight_real)
    )
    weighted_real = out_real * self.export_inverse_scale
    weighted_imaginary = out_imaginary * self.export_inverse_scale
    return (
        torch.einsum("bok,kn->bon", weighted_real, self.export_cos)
        - torch.einsum("bok,kn->bon", weighted_imaginary, self.export_sin)
    ) / float(self.export_radial_points)


def exportable_gelu(values: Tensor, approximate: str = "none") -> Tensor:
    del approximate
    coefficient = math.sqrt(2.0 / math.pi)
    return 0.5 * values * (1.0 + torch.tanh(coefficient * (values + 0.044715 * values.pow(3))))


def make_spectral_layers_exportable(model: nn.Module, spectral_type: type[nn.Module], radial_points: int) -> None:
    for name, module in model.named_modules():
        if not isinstance(module, spectral_type):
            continue
        # The electrochemical operator transforms the fixed radial grid; the
        # thermal operator transforms the fixed forecast time axis.
        transform_points = TIME_STEPS if name.startswith("thermal_operator_blocks") else radial_points
        modes = min(int(module.modes), transform_points // 2 + 1)
        frequency = torch.arange(modes, dtype=torch.float32).reshape(-1, 1)
        position = torch.arange(transform_points, dtype=torch.float32).reshape(1, -1)
        angle = 2.0 * math.pi * frequency * position / float(transform_points)
        scale = torch.full((1, modes), 2.0, dtype=torch.float32)
        scale[0, 0] = 1.0
        if transform_points % 2 == 0 and modes == transform_points // 2 + 1:
            scale[0, -1] = 1.0
        module.register_buffer("export_cos", torch.cos(angle))
        module.register_buffer("export_sin", torch.sin(angle))
        module.register_buffer("export_weight_real", module.weight.detach().real[:, :, :modes].clone())
        module.register_buffer("export_weight_imag", module.weight.detach().imag[:, :, :modes].clone())
        module.register_buffer("export_inverse_scale", scale)
        module.export_radial_points = transform_points
    spectral_type.forward = real_dft_forward


class ExportWrapper(nn.Module):
    def __init__(self, model: nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(
        self,
        current_c_rate: Tensor,
        temperature_c: Tensor,
        delta_time: Tensor,
        initial_concentration: Tensor,
        diffusivity: Tensor,
        surface_flux_scale: Tensor,
        chemistry_index: Tensor,
        initial_soc: Tensor,
        duration_hours: Tensor,
        capacity_ratio: Tensor,
    ) -> tuple[Tensor, ...]:
        output = self.model(
            current_c_rate,
            temperature_c,
            delta_time,
            initial_concentration,
            diffusivity,
            surface_flux_scale,
            chemistry_index,
            initial_soc=initial_soc,
            duration_hours=duration_hours,
            capacity_ratio=capacity_ratio,
            route_mode="dynamic",
        )
        return (
            output.voltage_v,
            output.soc,
            output.temperature_c,
            output.route_weights,
            output.route_risk_features,
            output.fast_voltage_v,
            output.operator_voltage_v,
        )


def sample_inputs(chemistry_index: int) -> tuple[Tensor, ...]:
    current = torch.linspace(-0.8, 1.1, TIME_STEPS, dtype=torch.float32).reshape(1, -1)
    temperature = torch.linspace(24.0, 31.0, TIME_STEPS, dtype=torch.float32).reshape(1, -1)
    delta = torch.full_like(current, 1.0 / float(TIME_STEPS - 1))
    delta[:, 0] = 0.0
    return (
        current,
        temperature,
        delta,
        torch.tensor([[0.646, 0.495]], dtype=torch.float32),
        torch.tensor([[0.45, 3.9]], dtype=torch.float32),
        torch.tensor([[0.08745, 0.1494]], dtype=torch.float32),
        torch.tensor([chemistry_index], dtype=torch.long),
        torch.tensor([0.70], dtype=torch.float32),
        torch.tensor([1.0], dtype=torch.float32),
        torch.tensor([0.96], dtype=torch.float32),
    )


def max_output_error(expected: tuple[Tensor, ...], actual: tuple[Tensor, ...]) -> float:
    return max(float((left - right).abs().max()) for left, right in zip(expected, actual, strict=True))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service-root", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    service_root = args.service_root.resolve()
    sys.path.insert(0, str(service_root))
    from models.spm_pino_transformer import (  # pylint: disable=import-error,import-outside-toplevel
        RadialSpectralConv1d,
        SPMPINOTransformer,
        SPMPINOTransformerConfig,
    )

    checkpoint = service_root / "checkpoints" / "research-candidate" / "spm-pino-v13-6-native-v10-guard-seed2026.pt"
    payload = torch.load(checkpoint, map_location="cpu", weights_only=False)
    metadata = dict(payload.get("metadata", {}))
    radial_points = int(metadata.get("radial_points", 18))
    chemistry_index = int(dict(metadata.get("dataset_metadata", {})).get("chemistry_index", 5))
    model = SPMPINOTransformer(SPMPINOTransformerConfig(**payload["config"]))
    model.load_state_dict(payload["state_dict"], strict=True)
    model.set_radial_resolution(radial_points)
    model.eval()
    inputs = sample_inputs(chemistry_index)
    wrapper = ExportWrapper(model).eval()

    with torch.inference_mode():
        fft_reference = wrapper(*inputs)
    make_spectral_layers_exportable(model, RadialSpectralConv1d, radial_points)
    with torch.inference_mode():
        dft_reference = wrapper(*inputs)
    dft_error = max_output_error(fft_reference, dft_reference)
    if dft_error > 2e-5:
        raise RuntimeError(f"real DFT replacement drifted by {dft_error:.8f}")
    torch.nn.functional.gelu = exportable_gelu
    nn.GELU.forward = lambda self, values: exportable_gelu(values)
    for module in model.modules():
        if isinstance(module, nn.TransformerEncoderLayer):
            module.activation = exportable_gelu
    with torch.inference_mode():
        tanh_gelu_reference = wrapper(*inputs)
    gelu_error = max_output_error(dft_reference, tanh_gelu_reference)
    if gelu_error > 3e-4:
        raise RuntimeError(f"exportable GELU drifted by {gelu_error:.8f}")
    export_inputs = inputs
    export_reference = tanh_gelu_reference

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    artifact = output_dir / "spm-pino-v13-6-native-v10-guard.onnx"
    input_names = [
        "current_c_rate", "temperature_c", "delta_time", "initial_concentration",
        "diffusivity", "surface_flux_scale", "chemistry_index", "initial_soc",
        "duration_hours", "capacity_ratio",
    ]
    output_names = [
        "voltage_v", "soc", "temperature_out_c", "route_weights",
        "route_risk_features", "fast_voltage_v", "operator_voltage_v",
    ]
    torch.onnx.export(
        wrapper,
        export_inputs,
        artifact,
        input_names=input_names,
        output_names=output_names,
        opset_version=18,
        do_constant_folding=True,
        dynamo=True,
        external_data=False,
    )

    import onnxruntime as ort  # pylint: disable=import-error,import-outside-toplevel

    session = ort.InferenceSession(str(artifact), providers=["CPUExecutionProvider"])
    feeds = {name: value.detach().cpu().numpy() for name, value in zip(input_names, export_inputs, strict=True)}
    onnx_outputs = session.run(output_names, feeds)
    onnx_error = max(
        float(np.max(np.abs(expected.detach().cpu().numpy() - actual)))
        for expected, actual in zip(export_reference, onnx_outputs, strict=True)
    )
    if onnx_error > 3e-4:
        raise RuntimeError(f"ONNX equivalence drifted by {onnx_error:.8f}")

    adapter = {
        "schemaVersion": 1,
        "modelId": "battery.spm-pino",
        "modelVersion": "spm-pino-v13.6-native-v10-guard",
        "runtime": "rust-ort",
        "precision": "fp32",
        "timeSteps": TIME_STEPS,
        "radialPoints": radial_points,
        "chemistry": {"lfp": chemistry_index},
        "routing": {
            "physicsRiskThreshold": float(model.config.sparse_physics_override_threshold),
            "operatorProbabilityThreshold": float(model.config.sparse_router_probability_threshold),
        },
        "inputNames": input_names,
        "outputNames": output_names,
        "preprocessing": "digital-twin-profile-v1",
        "postprocessing": "twin-moe-risk-route-v1",
    }
    adapter_path = output_dir / "spm-pino.adapter.json"
    adapter_path.write_text(json.dumps(adapter, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = {
        "schemaVersion": 1,
        "modelId": "battery.spm-pino",
        "modelVersion": adapter["modelVersion"],
        "checkpoint": {"sha256": sha256(checkpoint), "fileName": checkpoint.name},
        "artifact": {"sha256": sha256(artifact), "fileName": artifact.name, "sizeBytes": artifact.stat().st_size, "opset": 18},
        "adapter": {"sha256": sha256(adapter_path), "fileName": adapter_path.name},
        "validation": {
            "fftToRealDftMaxAbsoluteError": dft_error,
            "exactToTanhGeluMaxAbsoluteError": gelu_error,
            "pytorchToOnnxMaxAbsoluteError": onnx_error,
        },
    }
    manifest_path = output_dir / "spm-pino.manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
