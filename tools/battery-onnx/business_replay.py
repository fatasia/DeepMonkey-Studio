"""Use one measured battery record to replay the deployed preprocessing and outputs."""
from __future__ import annotations

import csv
import importlib
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import onnxruntime as ort
import torch


def load_business_records(path: Path) -> list[dict[str, str]]:
    """Read the immutable CSV once; callers record its hash in the candidate report."""
    with path.open("r", encoding="utf-8", newline="") as handle:
        records = list(csv.DictReader(handle))
    if not records:
        raise ValueError(f"真实记录为空：{path}")
    return records


def replay_window_model(
    model_id: str,
    model: torch.nn.Module,
    metadata: dict[str, Any],
    session: ort.InferenceSession,
    record_path: Path,
    records: list[dict[str, str]],
) -> dict[str, Any]:
    if model_id == "battery.bmsformer":
        return _replay_bmsformer(model, metadata, session, record_path, records)
    if model_id == "battery.socformer":
        return _replay_socformer(model, metadata, session, record_path, records)
    raise ValueError(f"不支持的真实记录回放：{model_id}")


def replay_batterymformer(
    wrapper: torch.nn.Module,
    config: Any,
    session: ort.InferenceSession,
    source_root: Path,
    record_path: Path,
    records: list[dict[str, str]],
) -> dict[str, Any]:
    features = importlib.import_module("preprocessing.batterymformer_features")
    adapter = importlib.import_module("adapters.batterymformer_adapter")
    cycles = int(config.early_cycle_threshold)
    curve_length = int(config.charge_discharge_length)
    threshold = float(getattr(config, "eol_threshold", 0.8))
    prepared = features.prepare_batterymformer_input(
        records,
        early_cycles=cycles,
        curve_length=curve_length,
        nominal_capacity_ah=_record_nominal(records),
        eol_threshold=threshold,
        file_name=record_path.name,
    )
    aliases = tuple(dict.fromkeys(
        str(record.get("sourceFile", "")).strip()
        for record in records
        if record.get("sourceFile")
    ))
    embedding_path = source_root / "vendor" / "BatteryMFormer" / "data_provider" / "prompt_embeddings" / "Qwen3_total.pkl"
    embedding, condition_mode = adapter._load_condition_embedding(
        embedding_path,
        int(config.d_llm),
        record_path.name,
        aliases,
    )
    tensors = (
        torch.from_numpy(prepared["curves"]).unsqueeze(0),
        torch.from_numpy(prepared["mask"]).unsqueeze(0),
        torch.from_numpy(embedding).reshape(1, 1, -1),
        torch.from_numpy(prepared["soh_input"]).unsqueeze(0),
        torch.from_numpy(prepared["cycle_features"]).unsqueeze(0),
    )
    expected = _torch_output(wrapper, tensors)
    actual = _onnx_output(
        session,
        tensors,
        ("curves", "curve_mask", "condition_embedding", "soh_input", "cycle_features"),
    )
    expected_trajectory, expected_life = _batterymformer_business_output(
        expected[0], prepared, records, threshold, 0.8
    )
    actual_trajectory, actual_life = _batterymformer_business_output(
        actual[0], prepared, records, threshold, 0.8
    )
    raw = _metrics(expected, actual)
    trajectory = _metrics(expected_trajectory * 100.0, actual_trajectory * 100.0)
    passed = bool(
        raw["finite"]
        and raw["maxAbsoluteError"] <= 2e-4
        and trajectory["maxAbsoluteError"] <= 0.01
        and expected_life == actual_life
    )
    return {
        "passed": passed,
        "preprocessing": "prepare_batterymformer_input",
        "records": len(records),
        "cycles": int(prepared["observed_cycles"]),
        "conditionMode": condition_mode,
        "rawTensor": raw,
        "businessOutput": {
            "sohTrajectoryPercentagePoints": trajectory,
            "pytorchPredictedCycleLife": expected_life,
            "onnxPredictedCycleLife": actual_life,
        },
    }


def _replay_bmsformer(
    model: torch.nn.Module,
    metadata: dict[str, Any],
    session: ort.InferenceSession,
    record_path: Path,
    records: list[dict[str, str]],
) -> dict[str, Any]:
    features = importlib.import_module("preprocessing.bmsformer_features")
    indicators = features.extract_cycle_health_indicators(records)
    arguments = {
        "window_size": int(metadata.get("window_size", 20)),
        "feature_mean": metadata.get("feature_mean"),
        "feature_std": metadata.get("feature_std"),
    }
    if int(model.config.input_features) == 2:
        window, warnings = features.build_inference_window(indicators, **arguments)
    else:
        window, warnings = features.build_inference_window(
            indicators,
            feature_names=metadata.get("feature_names"),
            **arguments,
        )
    tensor = torch.tensor([window], dtype=torch.float32)
    expected = _torch_output(model, tensor)
    actual = _onnx_output(session, tensor)
    capacities = [_positive_number(record.get("capacityAh")) for record in records]
    nominal = max((value for value in capacities if value is not None), default=280.0)
    expected_soh = round(float(np.clip(expected.item(), 0.0, 1.2)) * 100.0, 3)
    actual_soh = round(float(np.clip(actual.item(), 0.0, 1.2)) * 100.0, 3)
    expected_capacity = round(nominal * expected_soh / 100.0, 4)
    actual_capacity = round(nominal * actual_soh / 100.0, 4)
    raw = _metrics(expected, actual)
    return {
        "passed": bool(raw["finite"] and raw["maxAbsoluteError"] <= 5e-5 and expected_soh == actual_soh and expected_capacity == actual_capacity),
        "preprocessing": "extract_cycle_health_indicators + build_inference_window",
        "records": len(records),
        "cycles": len(indicators),
        "warnings": warnings,
        "rawTensor": raw,
        "businessOutput": {
            "pytorchCurrentSoh": expected_soh,
            "onnxCurrentSoh": actual_soh,
            "pytorchPredictedCapacityAh": expected_capacity,
            "onnxPredictedCapacityAh": actual_capacity,
        },
    }


def _replay_socformer(
    model: torch.nn.Module,
    metadata: dict[str, Any],
    session: ort.InferenceSession,
    record_path: Path,
    records: list[dict[str, str]],
) -> dict[str, Any]:
    features = importlib.import_module("preprocessing.socformer_features")
    adapter = importlib.import_module("adapters.socformer_adapter")
    latest_cycle = max(int(float(record["cycle"])) for record in records)
    samples = [
        record for record in records
        if int(float(record["cycle"])) == latest_cycle
        and float(record["current"]) < 0
        and float(record["capacityAh"]) > 0
    ]
    nominal = _record_nominal(records)
    chemistry_module = importlib.import_module("preprocessing.battery_chemistry")
    chemistry = chemistry_module.cell_chemistry(
        str(records[0].get("sourceDataset", "")),
        record_path.name,
    )
    observed_capacity = max(float(record["capacityAh"]) for record in samples)
    integration_capacity = observed_capacity if nominal * 0.5 <= observed_capacity <= nominal * 1.3 else nominal
    sequence = features.sequence_features(samples, nominal, chemistry, integration_capacity)
    windows = features.left_padded_windows(sequence, int(metadata.get("window_size", 16)))
    tensor = torch.tensor(windows, dtype=torch.float32)
    mean = torch.tensor(metadata["feature_mean"], dtype=torch.float32)
    std = torch.tensor(metadata["feature_std"], dtype=torch.float32).clamp_min(1e-6)
    tensor = (tensor - mean) / std
    expected = np.clip(_torch_output(model, tensor) * 100.0, 0.0, 100.0)
    actual = np.clip(_onnx_output(session, tensor) * 100.0, 0.0, 100.0)
    anchors = adapter._capacity_soc_anchors(samples, integration_capacity)
    physical = np.asarray(
        anchors if anchors is not None else [row[4] * 100.0 for row in sequence],
        dtype=np.float32,
    )
    weight = float(np.clip(metadata.get("deep_correction_weight", 0.2), 0.0, 1.0))
    expected_soc = np.clip(physical * (1.0 - weight) + expected.reshape(-1) * weight, 0.0, 100.0)
    actual_soc = np.clip(physical * (1.0 - weight) + actual.reshape(-1) * weight, 0.0, 100.0)
    raw = _metrics(expected, actual)
    business = _metrics(expected_soc, actual_soc)
    return {
        "passed": bool(raw["finite"] and raw["maxAbsoluteError"] <= 0.005 and business["maxAbsoluteError"] <= 0.002),
        "preprocessing": "sequence_features + left_padded_windows + physical-anchor blend",
        "records": len(samples),
        "cycle": latest_cycle,
        "chemistry": chemistry,
        "anchorMode": "cumulative-capacity" if anchors is not None else "coulomb-integration",
        "rawSocPercentagePoints": raw,
        "businessOutput": {
            "estimatedSocPercentagePoints": business,
            "pytorchFinalSoc": round(float(expected_soc[-1]), 3),
            "onnxFinalSoc": round(float(actual_soc[-1]), 3),
        },
    }


def _batterymformer_business_output(
    normalized: np.ndarray,
    prepared: dict[str, Any],
    records: list[dict[str, str]],
    normalization_eol: float,
    target_threshold: float,
) -> tuple[np.ndarray, int]:
    trajectory = np.asarray(normalized, dtype=np.float32) * (1.0 - normalization_eol) + normalization_eol
    observed = np.asarray(prepared.get("observed_soh_full", prepared["observed_soh"]), dtype=np.float32)
    cycle_numbers = np.asarray(
        prepared.get("observed_cycle_numbers", np.arange(1, observed.size + 1)),
        dtype=np.int32,
    )
    if cycle_numbers.size and int(cycle_numbers.min()) == 0:
        cycle_numbers += 1
    valid = np.isfinite(observed) & (cycle_numbers >= 1) & (cycle_numbers <= trajectory.size)
    observed, cycle_numbers = observed[valid], cycle_numbers[valid]
    observed_cycles = int(cycle_numbers.max()) if cycle_numbers.size else int(prepared["observed_cycles"])
    if cycle_numbers.size:
        dense_cycles = np.arange(1, observed_cycles + 1, dtype=np.float32)
        trajectory[:observed_cycles] = np.interp(dense_cycles, cycle_numbers.astype(np.float32), observed)
    if 0 < observed_cycles < trajectory.size:
        future = trajectory[observed_cycles:]
        future += float(observed[-1] - future[0])
        trajectory[observed_cycles:] = np.minimum.accumulate(future)
    trajectory = np.clip(trajectory, 0.0, 1.2)
    crossing = np.flatnonzero(trajectory <= target_threshold)
    predicted_life = int(crossing[0] + 1) if crossing.size else int(trajectory.size)
    has_censor_marker = any("rulEventObserved" in record for record in records)
    declared_event = any(str(record.get("rulEventObserved", "")).lower() in {"1", "true", "yes", "y"} for record in records)
    lower_bounds = [
        int(float(record[key])) for record in records
        for key in ("observedSurvivalCycles", "lifetimeLowerBoundCycles")
        if record.get(key) and float(record[key]) > 0
    ]
    if has_censor_marker and not declared_event:
        predicted_life = max(predicted_life, observed_cycles, *lower_bounds)
    return trajectory, predicted_life


def _torch_output(model: torch.nn.Module, value: torch.Tensor | Sequence[torch.Tensor]) -> np.ndarray:
    tensors = (value,) if isinstance(value, torch.Tensor) else tuple(value)
    with torch.inference_mode():
        return model(*tensors).detach().cpu().numpy().astype(np.float32, copy=False)


def _onnx_output(
    session: ort.InferenceSession,
    value: torch.Tensor | Sequence[torch.Tensor],
    names: Sequence[str] = ("input",),
) -> np.ndarray:
    tensors = (value,) if isinstance(value, torch.Tensor) else tuple(value)
    feed = {name: tensor.detach().cpu().numpy() for name, tensor in zip(names, tensors)}
    return np.asarray(session.run([session.get_outputs()[0].name], feed)[0], dtype=np.float32)


def _metrics(expected: np.ndarray, actual: np.ndarray) -> dict[str, float | bool]:
    difference = np.abs(np.asarray(expected) - np.asarray(actual))
    return {
        "maxAbsoluteError": float(difference.max(initial=0.0)),
        "meanAbsoluteError": float(difference.mean() if difference.size else 0.0),
        "finite": bool(np.isfinite(actual).all()),
    }


def _positive_number(value: object) -> float | None:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) and number > 0 else None


def _record_nominal(records: list[dict[str, str]]) -> float:
    declared = [_positive_number(record.get("nominalCapacityAh")) for record in records]
    nominal = next((value for value in declared if value is not None), None)
    if nominal is not None:
        return nominal
    capacities = [_positive_number(record.get("capacityAh")) for record in records]
    inferred = max((value for value in capacities if value is not None), default=0.0)
    if inferred <= 0:
        raise ValueError("真实记录缺少有效额定容量和容量观测。")
    return inferred
