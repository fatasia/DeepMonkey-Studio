"""导出并验证 BMSFormer/SOCFormer 的 ONNX FP32 候选制品。

该脚本只证明固定 Tensor Contract 的数值等价，不会生成可通过产品发布门禁的正式清单。
业务预处理、后处理、真实记录和外部锁箱仍须由后续适配器级回放验证。
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import pickle
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Sequence

_torch_dll_handle = None


def prepare_torch_dll_search_path() -> None:
    """Windows 下显式加入 Torch 原生 DLL 目录，避免依赖 Anaconda 的进程环境。"""
    if os.name != "nt":
        return
    torch_spec = importlib.util.find_spec("torch")
    candidates = []
    if torch_spec and torch_spec.origin:
        candidates.append(Path(torch_spec.origin).parent / "lib")
    candidates.extend(Path(entry) / "torch" / "lib" for entry in sys.path if entry)
    candidates.append(Path(sys.executable).parent.parent / "Lib" / "site-packages" / "torch" / "lib")
    torch_lib = next((candidate for candidate in candidates if candidate.is_dir()), None)
    if torch_lib is None:
        return
    os.environ["PATH"] = f"{torch_lib}{os.pathsep}{os.environ.get('PATH', '')}"
    global _torch_dll_handle
    _torch_dll_handle = os.add_dll_directory(str(torch_lib))


prepare_torch_dll_search_path()
# 先完成 Torch 原生库搜索路径初始化，再导入 NumPy/ONNX Runtime，避免
# Windows 进程先加载其他数值库后锁定不兼容的 DLL 搜索顺序。
import numpy as np
import torch
import onnx
import onnxruntime as ort
from business_replay import load_business_records, replay_batterymformer, replay_window_model


@dataclass(frozen=True)
class ModelSpec:
    id: str
    task: str
    checkpoint: str
    loader_module: str
    loader_name: str
    input_contract: str
    output_contract: str


MODEL_SPECS = (
    ModelSpec(
        id="battery.bmsformer",
        task="soh",
        checkpoint="models/bmsformer-batterylife-expanded.pt",
        loader_module="models.bmsformer",
        loader_name="load_bmsformer_checkpoint",
        input_contract="bmsformer-normalized-health-window-v1",
        output_contract="soh-fraction-v1",
    ),
    ModelSpec(
        id="battery.socformer",
        task="soc",
        checkpoint="models/socformer-batterylife-expanded.pt",
        loader_module="models.socformer",
        loader_name="load_socformer_checkpoint",
        input_contract="socformer-normalized-sequence-window-v1",
        output_contract="soc-fraction-v1",
    ),
    ModelSpec(
        id="battery.batterymformer",
        task="rul",
        checkpoint="checkpoints/batterymformer-expanded/model.safetensors",
        loader_module="",
        loader_name="",
        input_contract="batterymformer-early-cycle-multimodal-v1",
        output_contract="soh-trajectory-and-rul-v1",
    ),
)


def main() -> None:
    arguments = parse_arguments()
    source_root = arguments.source_root.resolve()
    output_root = arguments.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    if str(source_root) not in sys.path:
        sys.path.insert(0, str(source_root))
    default_record_root = source_root.parent / "public" / "samples"
    record_paths = arguments.record_file or [
        default_record_root / "multiscale-battery-assessment-tempest-lfp-280ah-700cycle.csv",
        default_record_root / "multiscale-battery-assessment-engineering-lfp-demo.csv",
        default_record_root / "multiscale-battery-assessment-engineering-nmc-demo.csv",
    ]
    replay_cases = [(path.resolve(), load_business_records(path.resolve())) for path in record_paths]

    selected = set(arguments.model or [spec.id for spec in MODEL_SPECS])
    reports = [export_candidate(spec, source_root, output_root, replay_cases) for spec in MODEL_SPECS if spec.id in selected]
    unknown = sorted(selected - {spec.id for spec in MODEL_SPECS})
    if unknown:
        raise ValueError(f"不支持的首批模型：{', '.join(unknown)}")

    summary = {
        "schemaVersion": 1,
        "decisionStatus": "candidate-record-replay",
        "passed": all(report["passed"] for report in reports),
        "models": reports,
        "remainingBlockers": [
            "扩充正式数据分割的外部锁箱与业务指标容差，不以单个真实记录替代",
            "固定更多边界数据、域外数据和异常业务输入锁箱",
            "生成产品 BatteryOnnxEquivalenceManifest 后再进入正式路由",
        ],
    }
    write_json(output_root / "candidate-report.json", summary)
    candidate_manifests = [candidate_manifest(report) for report in reports]
    write_json(output_root / "candidate-manifests.json", candidate_manifests)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if not summary["passed"]:
        raise SystemExit(2)


def candidate_manifest(report: dict[str, Any]) -> dict[str, Any]:
    """生成合同同构的候选清单；生产批准字段固定为未通过，防止工具越权签署。"""
    validation = report["validation"]
    tolerance = validation["tolerance"]
    golden = validation["golden"]
    tasks = {
        "battery.bmsformer": ["soh"],
        "battery.socformer": ["soc"],
        "battery.batterymformer": ["soh", "rul"],
    }[report["modelId"]]
    comparisons_passed = lambda values: sum(
        item["finite"]
        and item["maxAbsoluteError"] <= tolerance["maxAbsoluteError"]
        and item["meanAbsoluteError"] <= tolerance["meanAbsoluteError"]
        for item in values
    )
    business_replays = validation["businessReplays"]["comparisons"]
    preprocessing, postprocessing = {
        "battery.bmsformer": ("bmsformer-health-window-v1", "bmsformer-soh-product-v1"),
        "battery.socformer": ("socformer-sequence-anchor-v1", "socformer-hybrid-soc-product-v1"),
        "battery.batterymformer": ("batterymformer-multimodal-v1", "batterymformer-rul-product-v1"),
    }[report["modelId"]]
    return {
        "schemaVersion": 1,
        "modelId": report["modelId"],
        "source": {
            "modelVersion": report["source"]["modelVersion"],
            "checkpointSha256": report["source"]["checkpointSha256"],
        },
        "artifact": report["artifact"],
        "runtimeAdapter": report["runtimeAdapter"],
        "contract": {
            "input": report["contract"]["input"],
            "output": report["contract"]["output"],
            "preprocessing": preprocessing,
            "postprocessing": postprocessing,
        },
        "validation": {
            "outputs": [
                {
                    "task": task,
                    "samples": golden["samples"],
                    "maxAbsoluteError": golden["maxAbsoluteError"],
                    "meanAbsoluteError": golden["meanAbsoluteError"],
                    "allowedMaxAbsoluteError": tolerance["maxAbsoluteError"],
                    "allowedMeanAbsoluteError": tolerance["meanAbsoluteError"],
                }
                for task in tasks
            ],
            "boundaryCases": validation["boundary"]["cases"],
            "boundaryPassed": comparisons_passed(validation["boundary"]["comparisons"]),
            "outOfDomainCases": validation["outOfDomain"]["cases"],
            "outOfDomainPassed": comparisons_passed(validation["outOfDomain"]["comparisons"]),
            "invalidInputCases": validation["invalidInput"]["cases"],
            "invalidInputRejected": validation["invalidInput"]["rejected"],
            "repeatRuns": validation["repeatability"]["runs"],
            "maxRepeatDrift": validation["repeatability"]["maxAbsoluteDrift"],
            "allowedRepeatDrift": 0.0,
            "businessReplayCases": validation["businessReplays"]["cases"],
            "businessReplayPassed": sum(item["passed"] for item in business_replays),
        },
        "approval": {
            "decisionStatus": "candidate",
            "independentDatasetSplit": False,
            "externalLockboxCases": 0,
        },
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }


def export_candidate(spec: ModelSpec, source_root: Path, output_root: Path, replay_cases: list[tuple[Path, list[dict[str, str]]]]) -> dict[str, Any]:
    if spec.id == "battery.batterymformer":
        return export_batterymformer_candidate(spec, source_root, output_root, replay_cases)

    return export_window_model_candidate(spec, source_root, output_root, replay_cases)


def export_window_model_candidate(spec: ModelSpec, source_root: Path, output_root: Path, replay_cases: list[tuple[Path, list[dict[str, str]]]]) -> dict[str, Any]:
    checkpoint = source_root / spec.checkpoint
    loader = resolve_loader(spec)
    model, metadata = loader(str(checkpoint), device="cpu")
    model.eval()
    window_size = int(metadata.get("window_size", getattr(model.config, "max_sequence_length", 16)))
    input_features = int(model.config.input_features)
    artifact = output_root / f"{spec.id.removeprefix('battery.')}.fp32.opset18.onnx"

    generator = torch.Generator().manual_seed(20260829)
    example = torch.randn((2, window_size, input_features), generator=generator, dtype=torch.float32)
    # PyTorch 2.12 的 TransformerEncoder 默认启用融合快路径；该内部算子
    # 尚没有稳定的 ONNX 映射，导出时展开为标准算子，运行时性能不受影响。
    torch.backends.mha.set_fastpath_enabled(False)
    try:
        with torch.inference_mode():
            torch.onnx.export(
                model,
                example,
                artifact,
                input_names=["input"],
                output_names=["output"],
                dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},
                opset_version=18,
                do_constant_folding=True,
                dynamo=False,
            )
    finally:
        torch.backends.mha.set_fastpath_enabled(True)
    onnx.checker.check_model(onnx.load(artifact))
    session = ort.InferenceSession(str(artifact), providers=["CPUExecutionProvider"])
    business_replays = [
        {"recordFile": path.name, "recordSha256": sha256(path), **replay_window_model(spec.id, model, metadata, session, path, records)}
        for path, records in replay_cases
    ]

    golden = torch.randn((32, window_size, input_features), generator=generator, dtype=torch.float32) * 0.7
    golden_metrics = compare_outputs(model, session, golden)
    boundary_metrics = [
        compare_outputs(model, session, torch.zeros((4, window_size, input_features), dtype=torch.float32)),
        compare_outputs(model, session, torch.full((4, window_size, input_features), 3.0, dtype=torch.float32)),
        compare_outputs(model, session, torch.full((4, window_size, input_features), -3.0, dtype=torch.float32)),
    ]
    out_of_domain_metrics = [
        compare_outputs(model, session, torch.full((2, window_size, input_features), 20.0, dtype=torch.float32)),
        compare_outputs(model, session, torch.full((2, window_size, input_features), -20.0, dtype=torch.float32)),
    ]
    invalid_rejected = sum(
        rejects_input(session, value)
        for value in (
            np.zeros((1, window_size, input_features + 1), dtype=np.float32),
            np.zeros((1, window_size + 1, input_features), dtype=np.float32),
        )
    )
    repeatability = repeated_output_drift(session, golden.numpy(), runs=5)
    runtime_adapter = export_window_runtime_adapter(spec, metadata, model, output_root)
    allowed_max_error = 5e-5
    allowed_mean_error = 1e-6
    all_comparisons = [golden_metrics, *boundary_metrics, *out_of_domain_metrics]
    passed = (
        all(item["maxAbsoluteError"] <= allowed_max_error and item["meanAbsoluteError"] <= allowed_mean_error and item["finite"] for item in all_comparisons)
        and invalid_rejected == 2
        and repeatability == 0.0
        and all(replay["passed"] for replay in business_replays)
    )
    return {
        "modelId": spec.id,
        "task": spec.task,
        "passed": passed,
        "source": {
            "checkpoint": spec.checkpoint,
            "checkpointSha256": sha256(checkpoint),
            "modelVersion": metadata.get("model_version", "unknown"),
        },
        "artifact": {
            "fileName": artifact.name,
            "sha256": sha256(artifact),
            "sizeBytes": artifact.stat().st_size,
            "opset": 18,
            "precision": "fp32",
        },
        "runtimeAdapter": runtime_adapter,
        "contract": {
            "input": spec.input_contract,
            "output": spec.output_contract,
            "shape": ["batch", window_size, input_features],
        },
        "validation": {
            "businessReplays": {"cases": len(business_replays), "comparisons": business_replays},
            "golden": {**golden_metrics, "samples": 32},
            "boundary": {"cases": len(boundary_metrics), "comparisons": boundary_metrics},
            "outOfDomain": {"cases": len(out_of_domain_metrics), "comparisons": out_of_domain_metrics},
            "invalidInput": {"cases": 2, "rejected": invalid_rejected},
            "repeatability": {"runs": 5, "maxAbsoluteDrift": repeatability},
            "tolerance": {"maxAbsoluteError": allowed_max_error, "meanAbsoluteError": allowed_mean_error},
        },
    }


class BatteryMFormerExportWrapper(torch.nn.Module):
    """把正式模型的关键字参数接口收敛为稳定的五输入 ONNX 合同。"""

    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(
        self,
        curves: torch.Tensor,
        curve_mask: torch.Tensor,
        condition_embedding: torch.Tensor,
        soh_input: torch.Tensor,
        cycle_features: torch.Tensor,
    ) -> torch.Tensor:
        return self.model(
            cycle_curve_data=curves[:, :, :3],
            curve_attn_mask=curve_mask,
            aging_condition_embedding=condition_embedding,
            soc_input=curves[:, :, 3],
            soh_input=soh_input,
            cycle_level_features=cycle_features,
        )


def export_batterymformer_candidate(spec: ModelSpec, source_root: Path, output_root: Path, replay_cases: list[tuple[Path, list[dict[str, str]]]]) -> dict[str, Any]:
    checkpoint = source_root / spec.checkpoint
    model, config = load_batterymformer(source_root, checkpoint)
    wrapper = BatteryMFormerExportWrapper(model).eval()
    artifact = output_root / "batterymformer.fp32.opset18.onnx"
    input_names = ["curves", "curve_mask", "condition_embedding", "soh_input", "cycle_features"]
    example = make_batterymformer_inputs(config, batch=1, seed=20260829)

    with torch.inference_mode():
        torch.onnx.export(
            wrapper,
            example,
            artifact,
            input_names=input_names,
            output_names=["soh_trajectory"],
            dynamic_axes={name: {0: "batch"} for name in [*input_names, "soh_trajectory"]},
            opset_version=18,
            do_constant_folding=True,
            dynamo=False,
        )
    onnx.checker.check_model(onnx.load(artifact))
    session = ort.InferenceSession(str(artifact), providers=["CPUExecutionProvider"])
    business_replays = [
        {"recordFile": path.name, "recordSha256": sha256(path), **replay_batterymformer(wrapper, config, session, source_root, path, records)}
        for path, records in replay_cases
    ]

    golden = make_batterymformer_inputs(config, batch=4, seed=20260830)
    golden_metrics = compare_outputs(wrapper, session, golden, input_names)
    boundary_inputs = [
        make_batterymformer_inputs(config, batch=2, seed=1, fill=0.0),
        make_batterymformer_inputs(config, batch=2, seed=2, fill=1.0),
        make_batterymformer_inputs(config, batch=2, seed=3, fill=-1.0),
    ]
    out_of_domain_inputs = [
        make_batterymformer_inputs(config, batch=1, seed=4, fill=20.0),
        make_batterymformer_inputs(config, batch=1, seed=5, fill=-20.0),
    ]
    boundary_metrics = [compare_outputs(wrapper, session, inputs, input_names) for inputs in boundary_inputs]
    out_of_domain_metrics = [compare_outputs(wrapper, session, inputs, input_names) for inputs in out_of_domain_inputs]

    invalid_curves = list(golden)
    invalid_curves[0] = torch.zeros(
        (4, int(config.early_cycle_threshold), 5, int(config.charge_discharge_length)),
        dtype=torch.float32,
    )
    invalid_condition = list(golden)
    invalid_condition[2] = torch.zeros((4, 1, int(config.d_llm) + 1), dtype=torch.float32)
    invalid_rejected = sum(
        rejects_input(session, inputs, input_names)
        for inputs in (tuple(invalid_curves), tuple(invalid_condition))
    )
    repeatability = repeated_output_drift(session, golden, input_names, runs=5)
    runtime_adapter = export_batterymformer_runtime_adapter(spec, source_root, output_root, config)
    allowed_max_error = 2e-4
    allowed_mean_error = 2e-6
    all_comparisons = [golden_metrics, *boundary_metrics, *out_of_domain_metrics]
    passed = (
        all(item["maxAbsoluteError"] <= allowed_max_error and item["meanAbsoluteError"] <= allowed_mean_error and item["finite"] for item in all_comparisons)
        and invalid_rejected == 2
        and repeatability == 0.0
        and all(replay["passed"] for replay in business_replays)
    )
    return {
        "modelId": spec.id,
        "task": spec.task,
        "passed": passed,
        "source": {
            "checkpoint": spec.checkpoint,
            "checkpointSha256": sha256(checkpoint),
            "modelVersion": "batterymformer-expanded",
        },
        "artifact": {
            "fileName": artifact.name,
            "sha256": sha256(artifact),
            "sizeBytes": artifact.stat().st_size,
            "opset": 18,
            "precision": "fp32",
        },
        "runtimeAdapter": runtime_adapter,
        "contract": {
            "input": spec.input_contract,
            "output": spec.output_contract,
            "shapes": {
                "curves": ["batch", int(config.early_cycle_threshold), 4, int(config.charge_discharge_length)],
                "curveMask": ["batch", int(config.early_cycle_threshold)],
                "conditionEmbedding": ["batch", 1, int(config.d_llm)],
                "sohInput": ["batch", int(config.early_cycle_threshold), 1],
                "cycleFeatures": ["batch", int(config.early_cycle_threshold), 2],
                "output": ["batch", int(config.pred_len)],
            },
        },
        "validation": {
            "businessReplays": {"cases": len(business_replays), "comparisons": business_replays},
            "golden": {**golden_metrics, "samples": 4},
            "boundary": {"cases": len(boundary_metrics), "comparisons": boundary_metrics},
            "outOfDomain": {"cases": len(out_of_domain_metrics), "comparisons": out_of_domain_metrics},
            "invalidInput": {"cases": 2, "rejected": invalid_rejected},
            "repeatability": {"runs": 5, "maxAbsoluteDrift": repeatability},
            "tolerance": {"maxAbsoluteError": allowed_max_error, "meanAbsoluteError": allowed_mean_error},
        },
    }


def export_window_runtime_adapter(
    spec: ModelSpec,
    metadata: dict[str, Any],
    model: torch.nn.Module,
    output_root: Path,
) -> dict[str, Any]:
    """导出 Node ONNX Runtime 所需的最小前后处理参数，不复制 checkpoint。"""
    adapter_path = output_root / f"{spec.id.removeprefix('battery.')}.runtime-adapter.json"
    payload = {
        "schemaVersion": 1,
        "modelId": spec.id,
        "modelVersion": metadata.get("model_version", "unknown"),
        "kind": "bmsformer-window-v1" if spec.id == "battery.bmsformer" else "socformer-window-v1",
        "session": {"inputs": ["input"], "output": "output"},
        "model": {
            "windowSize": int(metadata.get("window_size", getattr(model.config, "max_sequence_length", 16))),
            "inputFeatures": int(model.config.input_features),
            "featureNames": metadata.get("feature_names", []),
            "featureMean": metadata.get("feature_mean", []),
            "featureStd": metadata.get("feature_std", []),
            "chemistryScope": metadata.get("chemistry_scope", ["lfp", "ncm"]),
            "chemistryMetrics": metadata.get("chemistry_metrics", {}),
            "confidenceGate": metadata.get("confidence_gate", {}),
            "testMae": metadata.get("test_mae"),
            **(
                {"deepCorrectionWeight": float(metadata.get("deep_correction_weight", 0.2))}
                if spec.id == "battery.socformer" else {}
            ),
        },
    }
    write_json(adapter_path, json_safe(payload))
    return {**file_descriptor(adapter_path), "schemaVersion": 1}


def export_batterymformer_runtime_adapter(
    spec: ModelSpec,
    source_root: Path,
    output_root: Path,
    config: SimpleNamespace,
) -> dict[str, Any]:
    """把 Python pickle 转为可校验的连续 Float32 包，运行时无需 Python/pickle。"""
    embedding_path = source_root / "vendor" / "BatteryMFormer" / "data_provider" / "prompt_embeddings" / "Qwen3_total.pkl"
    with embedding_path.open("rb") as handle:
        source_embeddings = pickle.load(handle)  # noqa: S301 - 本地受信官方制品
    expected_size = int(config.d_llm)
    gate_path = (source_root / spec.checkpoint).parent / "confidence_gate.json"
    confidence_gate = json.loads(gate_path.read_text(encoding="utf-8")) if gate_path.is_file() else {}
    keys = sorted(str(key) for key in source_embeddings)
    matrix = np.concatenate([
        np.asarray(source_embeddings[key], dtype=np.float32).reshape(1, -1)
        for key in keys
    ], axis=0)
    if matrix.shape != (len(keys), expected_size):
        raise ValueError(f"BatteryMFormer 工况嵌入应为 ({len(keys)}, {expected_size})，实际为 {matrix.shape}")

    bundle_path = output_root / "batterymformer.condition-embeddings.f32"
    bundle_path.write_bytes(matrix.astype("<f4", copy=False).tobytes(order="C"))
    adapter_path = output_root / "batterymformer.runtime-adapter.json"
    payload = {
        "schemaVersion": 1,
        "modelId": spec.id,
        "modelVersion": "batterymformer-expanded",
        "kind": "batterymformer-multimodal-v1",
        "session": {
            "inputs": ["curves", "curve_mask", "condition_embedding", "soh_input", "cycle_features"],
            "output": "soh_trajectory",
        },
        "model": {
            "earlyCycles": int(config.early_cycle_threshold),
            "curveLength": int(config.charge_discharge_length),
            "conditionEmbeddingSize": expected_size,
            "predictionLength": int(config.pred_len),
            "eolThreshold": float(getattr(config, "eol_threshold", 0.8)),
            "confidenceGate": confidence_gate,
        },
        "conditionEmbeddings": {
            **file_descriptor(bundle_path),
            "rows": len(keys),
            "columns": expected_size,
            "keys": keys,
            "fallbackPrefix": "CALB_",
        },
    }
    write_json(adapter_path, payload)
    return {**file_descriptor(adapter_path), "schemaVersion": 1}


def load_batterymformer(source_root: Path, checkpoint: Path) -> tuple[torch.nn.Module, SimpleNamespace]:
    """按正式 checkpoint 自带参数加载标准专家，不启用 PINN 影子头。"""
    config_path = checkpoint.parent / "args.json"
    config_values = json.loads(config_path.read_text(encoding="utf-8"))
    config_values.setdefault("e_layers2", config_values.get("e_layers", 2))
    config = SimpleNamespace(**config_values)
    official_root = source_root / "vendor" / "BatteryMFormer"
    module_path = official_root / "models" / "BatteryMFormer.py"
    module_spec = importlib.util.spec_from_file_location("battery_onnx_batterymformer", module_path)
    if not module_spec or not module_spec.loader:
        raise ValueError(f"无法加载 BatteryMFormer 源码：{module_path}")
    sys.path.insert(0, str(official_root))
    module = importlib.util.module_from_spec(module_spec)
    try:
        module_spec.loader.exec_module(module)
    finally:
        if sys.path and sys.path[0] == str(official_root):
            sys.path.pop(0)
    model = module.Model(config)
    from safetensors.torch import load_file
    missing, unexpected = model.load_state_dict(load_file(str(checkpoint), device="cpu"), strict=False)
    if missing or unexpected:
        raise ValueError(f"BatteryMFormer checkpoint 不兼容：missing={missing}, unexpected={unexpected}")
    return model.cpu().eval(), config


def make_batterymformer_inputs(
    config: SimpleNamespace,
    batch: int,
    seed: int,
    fill: float | None = None,
) -> tuple[torch.Tensor, ...]:
    generator = torch.Generator().manual_seed(seed)
    cycles = int(config.early_cycle_threshold)
    curve_length = int(config.charge_discharge_length)
    if fill is None:
        curves = torch.randn((batch, cycles, 4, curve_length), generator=generator) * 0.25
        condition = torch.randn((batch, 1, int(config.d_llm)), generator=generator) * 0.1
        cycle_features = torch.randn((batch, cycles, 2), generator=generator) * 0.1
    else:
        curves = torch.full((batch, cycles, 4, curve_length), fill, dtype=torch.float32)
        condition = torch.full((batch, 1, int(config.d_llm)), fill, dtype=torch.float32)
        cycle_features = torch.full((batch, cycles, 2), fill, dtype=torch.float32)
    curve_mask = torch.ones((batch, cycles), dtype=torch.float32)
    soh_input = torch.linspace(1.0, 0.82, cycles, dtype=torch.float32).reshape(1, cycles, 1).repeat(batch, 1, 1)
    return curves, curve_mask, condition, soh_input, cycle_features


def resolve_loader(spec: ModelSpec) -> Callable[..., tuple[torch.nn.Module, dict[str, Any]]]:
    module = importlib.import_module(spec.loader_module)
    loader = getattr(module, spec.loader_name, None)
    if not callable(loader):
        raise ValueError(f"模型加载器不存在：{spec.loader_module}.{spec.loader_name}")
    return loader


def compare_outputs(
    model: torch.nn.Module,
    session: ort.InferenceSession,
    inputs: torch.Tensor | Sequence[torch.Tensor],
    input_names: Sequence[str] = ("input",),
) -> dict[str, float | bool]:
    tensors = (inputs,) if isinstance(inputs, torch.Tensor) else tuple(inputs)
    with torch.inference_mode():
        expected = model(*tensors).detach().cpu().numpy().astype(np.float32, copy=False)
    output_name = session.get_outputs()[0].name
    actual = np.asarray(session.run([output_name], make_onnx_feed(input_names, tensors))[0], dtype=np.float32)
    difference = np.abs(expected - actual)
    return {
        "maxAbsoluteError": float(difference.max(initial=0.0)),
        "meanAbsoluteError": float(difference.mean() if difference.size else 0.0),
        "finite": bool(np.isfinite(actual).all()),
    }


def rejects_input(
    session: ort.InferenceSession,
    value: np.ndarray | torch.Tensor | Sequence[np.ndarray | torch.Tensor],
    input_names: Sequence[str] = ("input",),
) -> int:
    try:
        output_name = session.get_outputs()[0].name
        session.run([output_name], make_onnx_feed(input_names, value))
    except (ValueError, RuntimeError, ort.capi.onnxruntime_pybind11_state.InvalidArgument):
        return 1
    return 0


def repeated_output_drift(
    session: ort.InferenceSession,
    value: np.ndarray | torch.Tensor | Sequence[np.ndarray | torch.Tensor],
    input_names: Sequence[str] = ("input",),
    runs: int = 5,
) -> float:
    output_name = session.get_outputs()[0].name
    feed = make_onnx_feed(input_names, value)
    baseline = np.asarray(session.run([output_name], feed)[0], dtype=np.float32)
    maximum = 0.0
    for _ in range(runs - 1):
        candidate = np.asarray(session.run([output_name], feed)[0], dtype=np.float32)
        maximum = max(maximum, float(np.abs(baseline - candidate).max(initial=0.0)))
    return maximum


def make_onnx_feed(
    input_names: Sequence[str],
    value: np.ndarray | torch.Tensor | Sequence[np.ndarray | torch.Tensor],
) -> dict[str, np.ndarray]:
    values = (value,) if isinstance(value, (np.ndarray, torch.Tensor)) else tuple(value)
    if len(input_names) != len(values):
        raise ValueError(f"ONNX 输入名称与张量数量不一致：{len(input_names)} != {len(values)}")
    return {
        name: item.detach().cpu().numpy() if isinstance(item, torch.Tensor) else np.asarray(item)
        for name, item in zip(input_names, values)
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def file_descriptor(path: Path) -> dict[str, object]:
    return {
        "fileName": path.name,
        "sha256": sha256(path),
        "sizeBytes": path.stat().st_size,
    }


def json_safe(value: object) -> object:
    """将 checkpoint 元数据收敛为稳定 JSON，避免泄漏 Python/Torch 专用类型。"""
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, torch.Tensor):
        return value.detach().cpu().tolist()
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, Path):
        return str(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"不支持写入运行适配器的类型：{type(value).__name__}")


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, required=True, help="battery-model-service 根目录")
    parser.add_argument("--output-root", type=Path, required=True, help="候选制品与报告目录")
    parser.add_argument("--record-file", type=Path, action="append", help="可重复指定真实业务 CSV；默认回放 TEMPEST、工程 LFP 和工程 NMC 三套记录")
    parser.add_argument("--model", action="append", choices=[spec.id for spec in MODEL_SPECS])
    return parser.parse_args()


if __name__ == "__main__":
    main()
