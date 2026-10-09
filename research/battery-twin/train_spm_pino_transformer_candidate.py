"""Train the isolated SPM-PINO Transformer candidate.

Protocol:
  1. Train the exact same architecture with data losses only.
  2. Restore the best data-only state.
  3. Fine-tune with gradient-balanced PDE/BC/IC/conservation losses.
  4. Freeze both experts and cost-calibrate the router on expert complementarity.
  5. Compare on scenario-isolated holdout data and never promote automatically.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import random
import time
from dataclasses import asdict, replace
from pathlib import Path

import torch
from torch import Tensor, nn
from torch.utils.data import DataLoader, TensorDataset, WeightedRandomSampler

from models.spm_pino_transformer import (
    SPMPINOTransformer,
    SPMPINOTransformerConfig,
)
from research.adaptive_curriculum import (
    AdaptiveCurriculumConfig,
    ResidualPriorityMemory,
    curriculum_progress,
    physics_curriculum_authority,
)
from research.candidate_gate import assert_isolated_candidate_path
from research.multi_constraint_balance import MultiConstraintBalancer
from research.multiphysics_physics import (
    degradation_state_losses,
    lumped_thermal_residuals,
    thermal_physics_losses,
)
from research.spm_dataset import (
    SPMTensorDataset,
    generate_dimensionless_spm_dataset,
    load_spm_npz,
)
from research.spm_physics import spm_physics_losses, spm_residuals
from research.transfer_learning import build_protocol_context

SOC_DIRECTION_EPSILON = 0.002
MULTIPHYSICS_PARAMETER_PREFIXES = (
    "electrochemical_token.",
    "thermal_token.",
    "degradation_token.",
    "cross_physics_attention.",
    "thermal_parameter_head.",
    "thermal_operator_",
    "temperature_feedback_gate",
    "concentration_coupling_head.",
    "degradation_head.",
    "degradation_context_encoder.",
    "degradation_prior_head.",
    "degradation_context_gate",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path(
        "checkpoints/research-candidate/spm-pino-transformer-v1.pt"
    ))
    parser.add_argument(
        "--model-version",
        type=str,
        default="",
        help="Explicit model-card version; defaults to the output checkpoint stem.",
    )
    parser.add_argument(
        "--dataset",
        type=Path,
        help="Optional PyBaMM candidate NPZ; defaults to the conservative fixture",
    )
    parser.add_argument(
        "--warm-start-checkpoint",
        type=Path,
        help="Existing isolated v4 candidate used for router-only calibration.",
    )
    parser.add_argument(
        "--router-only",
        action="store_true",
        help="Freeze both experts and retrain only the sparse physical-risk router.",
    )
    parser.add_argument("--scenarios", type=int, default=256)
    parser.add_argument("--time-steps", type=int, default=64)
    parser.add_argument("--radial-points", type=int, default=24)
    parser.add_argument("--stage1-epochs", type=int, default=30)
    parser.add_argument("--stage2-epochs", type=int, default=30)
    parser.add_argument("--router-epochs", type=int, default=20)
    parser.add_argument("--patience", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=16)
    parser.add_argument("--learning-rate", type=float, default=8e-4)
    parser.add_argument("--stage2-learning-rate", type=float, default=2e-4)
    parser.add_argument("--router-learning-rate", type=float, default=2e-3)
    parser.add_argument(
        "--router-feature-version",
        type=int,
        default=2,
        help="Leakage-free light-expert risk feature contract used by a newly calibrated router.",
    )
    parser.add_argument(
        "--sparse-physics-override-threshold",
        type=float,
        default=3.0,
        help="Force PINO above this normalized physics risk even when the learned router selects fast.",
    )
    parser.add_argument(
        "--sparse-router-probability-threshold",
        type=float,
        default=0.5,
        help="Execute PINO when its learned route probability reaches this threshold.",
    )
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument(
        "--split-seed",
        type=int,
        default=2026,
        help="Fixed grouped data-split seed; vary --seed for independent optimization trials.",
    )
    parser.add_argument("--model-dim", type=int, default=48)
    parser.add_argument("--operator-width", type=int, default=32)
    parser.add_argument("--operator-layers", type=int, default=3)
    parser.add_argument("--radial-modes", type=int, default=8)
    parser.add_argument(
        "--multifidelity-v5",
        action="store_true",
        help="Train voltage/SOC/temperature on measured Farasis targets.",
    )
    parser.add_argument(
        "--hard-sample-mining",
        action="store_true",
        help="Oversample high-ramp/high-heating measured profiles.",
    )
    parser.add_argument(
        "--residual-adaptive-sampling",
        action="store_true",
        help=(
            "Update bounded sample priorities from detached data/physics "
            "residuals while retaining a uniform sampling component."
        ),
    )
    parser.add_argument(
        "--residual-decay-balancing",
        action="store_true",
        help=(
            "Combine gradient-conflict weights with bounded residual-decay "
            "multipliers for slowly converging physical constraints."
        ),
    )
    parser.add_argument(
        "--physics-curriculum-fraction",
        type=float,
        default=0.30,
        help=(
            "Fraction of each physics stage used to ramp physical authority "
            "from data-first warm-up to the full adaptive objective."
        ),
    )
    parser.add_argument(
        "--required-chemistry-family",
        type=str,
        default="",
        help="Reject a dataset whose audited chemistry metadata does not match.",
    )
    parser.add_argument(
        "--expert-only",
        action="store_true",
        help="Train/evaluate PINO experts without fitting the downstream router.",
    )
    parser.add_argument(
        "--operator-residual",
        action="store_true",
        help="Learn a bounded operator correction around the light expert.",
    )
    parser.add_argument(
        "--multiphysics-v1",
        action="store_true",
        help=(
            "Warm-start an isolated v10.6 candidate with the thermal operator, "
            "cross-physics attention, Arrhenius feedback and degradation head. "
            "The production checkpoint and router are never replaced."
        ),
    )
    parser.add_argument(
        "--thermal-dynamics-min-weight",
        type=float,
        default=0.002,
        help=(
            "Minimum adaptive weight for the lumped thermal-dynamics residual. "
            "Used only by --multiphysics-v1 to prevent a useful thermal signal "
            "from collapsing under persistent gradient conflict."
        ),
    )
    parser.add_argument(
        "--degradation-pretrain-checkpoint",
        type=Path,
        help=(
            "Cell-isolated LG M50T degradation adapter checkpoint. "
            "Only named degradation-context parameters are imported."
        ),
    )
    return parser.parse_args()


def split_masks(dataset: SPMTensorDataset, seed: int) -> dict[str, Tensor]:
    if dataset.group_id is not None:
        if len(dataset.group_id) != len(dataset.scenario_family):
            raise ValueError("group_id 数量与工况数量不一致。")
        members_by_group: dict[str, list[int]] = {}
        family_by_group: dict[str, str] = {}
        for index, (family, group_id) in enumerate(
            zip(dataset.scenario_family, dataset.group_id)
        ):
            members_by_group.setdefault(group_id, []).append(index)
            prior = family_by_group.setdefault(group_id, family)
            if prior != family:
                raise ValueError(
                    f"同一 group_id 跨越多个工况族：{group_id}"
                )
        grouped_ids: dict[str, list[str]] = {}
        for group_id, family in family_by_group.items():
            grouped_ids.setdefault(family, []).append(group_id)
        train, validation, test = [], [], []
        for family, group_ids in sorted(grouped_ids.items()):
            if bool(dataset.metadata.get("multifidelity", False)):
                cells: dict[str, list[str]] = {}
                for group_id in group_ids:
                    cell = group_id.split(":cycle-", 1)[0]
                    cells.setdefault(cell, []).append(group_id)
                if len(cells) < 2:
                    raise ValueError(
                        f"工况族 {family} 少于两个电芯，无法整电芯隔离测试。"
                    )
                cell_names = sorted(cells)
                random.Random(f"{seed}:{family}:cells").shuffle(cell_names)
                test_groups = cells[cell_names[-1]]
                remaining = cell_names[:-1]
                if len(remaining) >= 2:
                    validation_groups = cells[remaining[-1]]
                    train_groups = [
                        group
                        for cell in remaining[:-1]
                        for group in cells[cell]
                    ]
                else:
                    remaining_groups = cells[remaining[0]]
                    random.Random(
                        f"{seed}:{family}:validation-groups"
                    ).shuffle(remaining_groups)
                    holdout = max(1, len(remaining_groups) // 5)
                    validation_groups = remaining_groups[-holdout:]
                    train_groups = remaining_groups[:-holdout]
                test.extend(
                    index
                    for key in test_groups
                    for index in members_by_group[key]
                )
                validation.extend(
                    index
                    for key in validation_groups
                    for index in members_by_group[key]
                )
                train.extend(
                    index
                    for key in train_groups
                    for index in members_by_group[key]
                )
                continue
            if len(group_ids) < 3:
                raise ValueError(
                    f"工况族 {family} 仅有 {len(group_ids)} 个独立组，"
                    "无法进行训练/验证/测试分组。"
                )
            random.Random(f"{seed}:{family}:groups").shuffle(group_ids)
            holdout = max(1, len(group_ids) // 5)
            test_groups = group_ids[-holdout:]
            validation_groups = group_ids[-2 * holdout:-holdout]
            train_groups = group_ids[:-2 * holdout]
            test.extend(
                index for key in test_groups for index in members_by_group[key]
            )
            validation.extend(
                index
                for key in validation_groups
                for index in members_by_group[key]
            )
            train.extend(
                index for key in train_groups for index in members_by_group[key]
            )
    else:
        grouped: dict[str, list[int]] = {}
        for index, family in enumerate(dataset.scenario_family):
            grouped.setdefault(family, []).append(index)
        train, validation, test = [], [], []
        for family, indices in sorted(grouped.items()):
            random.Random(f"{seed}:{family}").shuffle(indices)
            holdout = max(1, len(indices) // 5)
            test.extend(indices[-holdout:])
            validation.extend(indices[-2 * holdout:-holdout])
            train.extend(indices[:-2 * holdout])
    masks = {}
    for name, indices in (
        ("train", train),
        ("validation", validation),
        ("test", test),
    ):
        mask = torch.zeros(len(dataset.scenario_family), dtype=torch.bool)
        mask[indices] = True
        masks[name] = mask
    return masks


def model_batch(batch: tuple[Tensor, ...], device: torch.device) -> tuple[Tensor, ...]:
    return tuple(value.to(device) for value in batch)


def freeze_v10_backbone_for_multiphysics(model: SPMPINOTransformer) -> list[str]:
    """Freeze v10.6 and leave only zero-initialized multiphysics adapters trainable."""

    trainable: list[str] = []
    for name, parameter in model.named_parameters():
        enabled = name.startswith(MULTIPHYSICS_PARAMETER_PREFIXES)
        parameter.requires_grad_(enabled)
        if enabled:
            trainable.append(name)
    if not trainable:
        raise ValueError("多物理候选没有可训练的增量参数。")
    return trainable


def forward_model(
    model: SPMPINOTransformer,
    batch: tuple[Tensor, ...],
    observation_mode: str = "observer",
    history_fraction: float = 0.25,
    protocol_context_override: Tensor | None = None,
    **kwargs,
):
    if observation_mode not in {"observer", "forecast"}:
        raise ValueError("observation_mode 必须为 observer 或 forecast。")
    if not 0.0 < history_fraction <= 1.0:
        raise ValueError("history_fraction 必须位于 (0, 1]。")
    current = batch[0]
    voltage = batch[8]
    if observation_mode == "forecast":
        history_steps = max(2, int(round(voltage.shape[1] * history_fraction)))
        voltage = voltage[:, :history_steps]
    capacity_ratio = batch[13].reshape(-1)
    degradation_context = torch.stack(
        (
            (1.0 - capacity_ratio).clamp(0.0, 0.8) / 0.2,
            capacity_ratio.clamp(0.5, 1.05),
            current.abs().mean(dim=1).clamp(max=4.0) / 4.0,
            current.square().mean(dim=1).sqrt().clamp(max=4.0) / 4.0,
            ((voltage.mean(dim=1) - 3.4) / 0.8).clamp(-2.0, 2.0),
            (voltage.std(dim=1) / 0.5).clamp(0.0, 2.0),
            ((voltage.amax(dim=1) - voltage.amin(dim=1)) / 1.5).clamp(
                0.0,
                2.0,
            ),
            torch.zeros_like(capacity_ratio),
        ),
        dim=-1,
    )
    protocol_context = (
        protocol_context_override
        if protocol_context_override is not None
        else build_protocol_context(
            current,
            batch[1],
            batch[10],
            batch[11],
            batch[13],
            kwargs.get("sensor_mask"),
        )
    )
    return model(
        *batch[:7],
        initial_soc=batch[10],
        duration_hours=batch[11],
        capacity_ratio=batch[13],
        degradation_context=(
            degradation_context
            if model.config.degradation_context_version >= 1
            else None
        ),
        protocol_context=(
            protocol_context
            if model.config.protocol_context_version >= 1
            else None
        ),
        **kwargs,
    )


def forecast_horizon_slice(
    time_steps: int,
    history_fraction: float = 0.25,
) -> slice:
    """Return the strictly future evaluation horizon."""

    if time_steps < 3:
        raise ValueError("Forecast 评估至少需要 3 个时间点。")
    if not 0.0 < history_fraction < 1.0:
        raise ValueError("Forecast history_fraction 必须位于 (0, 1)。")
    history_steps = max(2, int(round(time_steps * history_fraction)))
    return slice(min(history_steps, time_steps - 1), time_steps)


def coulomb_soc_reference(
    batch: tuple[Tensor, ...],
    *,
    health_scaled: bool = True,
) -> Tensor:
    current = batch[0]
    trapezoid_current = current.clone()
    trapezoid_current[:, 0] = 0.0
    trapezoid_current[:, 1:] = 0.5 * (
        current[:, 1:] + current[:, :-1]
    )
    return (
        batch[10].reshape(-1, 1)
        + torch.cumsum(trapezoid_current * batch[2], dim=1)
        * batch[11].reshape(-1, 1)
        / (
            batch[13].reshape(-1, 1).clamp_min(0.5)
            if health_scaled
            else 1.0
        )
    ).clamp(0.0, 1.0)


def supervised_loss(
    output,
    batch: tuple[Tensor, ...],
    *,
    health_scaled: bool = True,
) -> Tensor:
    concentration_target = batch[7]
    voltage_target = batch[8]
    soc_target = batch[9]
    soc_delta = output.soc - output.soc[:, :1]
    target_delta = soc_target - soc_target[:, :1]
    terminal_delta = soc_delta[:, -1]
    target_terminal_delta = target_delta[:, -1]
    # Below 0.2 percentage points the sign is numerically fragile and has no
    # useful routing meaning, especially for near-zero-net triangular cycles.
    active_direction = target_terminal_delta.abs() >= SOC_DIRECTION_EPSILON
    direction_loss = (
        (
            nn.functional.softplus(
                -100.0
                * terminal_delta[active_direction]
                * target_terminal_delta[active_direction].sign()
            )
            / 100.0
        ).mean()
        if bool(active_direction.any())
        else output.soc.new_zeros(())
    )
    coulomb_reference = coulomb_soc_reference(
        batch,
        health_scaled=health_scaled,
    )
    blended = (
        nn.functional.mse_loss(output.concentration, concentration_target)
        + 0.50 * nn.functional.smooth_l1_loss(output.voltage_v, voltage_target)
        + 0.80 * nn.functional.mse_loss(output.soc, soc_target)
        + 0.80 * nn.functional.mse_loss(soc_delta, target_delta)
        + 1.00 * nn.functional.smooth_l1_loss(
            terminal_delta,
            target_terminal_delta,
        )
        + 0.50 * direction_loss
        + 0.50 * nn.functional.mse_loss(output.soc, coulomb_reference)
        + 0.10 * output.soc_correction.pow(2).mean()
        + 0.25 * nn.functional.smooth_l1_loss(
            output.temperature_c,
            batch[12],
        )
    )
    # Both experts must be useful before routing can learn complementarity.
    expert_auxiliary = (
        nn.functional.mse_loss(
            output.fast_concentration,
            concentration_target,
        )
        + nn.functional.mse_loss(
            output.operator_concentration,
            concentration_target,
        )
        + 0.25 * nn.functional.smooth_l1_loss(
            output.fast_voltage_v,
            voltage_target,
        )
        + 0.25 * nn.functional.smooth_l1_loss(
            output.operator_voltage_v,
            voltage_target,
        )
    )
    return blended + 0.50 * expert_auxiliary


def _per_sample_operator_cost(output, batch: tuple[Tensor, ...]) -> tuple[Tensor, Tensor]:
    target = batch[7]
    fast_data = (output.fast_concentration - target).abs().flatten(1).mean(dim=1)
    operator_data = (
        output.operator_concentration - target
    ).abs().flatten(1).mean(dim=1)
    fast_voltage = (
        output.fast_voltage_v - batch[8]
    ).abs().mean(dim=1)
    operator_voltage = (
        output.operator_voltage_v - batch[8]
    ).abs().mean(dim=1)

    def physics_cost(concentration: Tensor) -> Tensor:
        residual = spm_residuals(
            concentration,
            batch[0],
            batch[2],
            batch[4],
            flux_scale=batch[5],
        )
        return (
            residual.dynamics.pow(2).flatten(1).mean(dim=1).sqrt()
            + residual.conservation.pow(2).flatten(1).mean(dim=1).sqrt()
        )

    fast_cost = (
        fast_data
        + 0.25 * fast_voltage
        + 0.05 * physics_cost(output.fast_concentration)
    )
    # Small explicit compute cost prevents a meaningless always-heavy router.
    operator_cost = (
        operator_data
        + 0.25 * operator_voltage
        + 0.05 * physics_cost(output.operator_concentration)
        + 0.002
    )
    return fast_cost, operator_cost


def routing_loss(output, batch: tuple[Tensor, ...]) -> Tensor:
    fast_cost, operator_cost = _per_sample_operator_cost(output, batch)
    oracle = torch.stack((fast_cost, operator_cost), dim=-1).argmin(dim=-1)
    selected = output.route_weights.gather(1, oracle[:, None]).clamp_min(1e-7)
    counts = torch.bincount(oracle, minlength=2).to(selected.dtype)
    class_weights = counts.sum() / (2.0 * counts.clamp_min(1.0))
    sample_weights = class_weights[oracle, None]
    # The heavy expert is usually a minority oracle. Inverse-frequency
    # weighting prevents the router from winning with an always-fast policy.
    return (
        -(sample_weights * selected.log()).sum()
        / sample_weights.sum().clamp_min(1e-7)
    )


@torch.no_grad()
def evaluate(
    model: SPMPINOTransformer,
    tensors: tuple[Tensor, ...],
    mask: Tensor,
    device: torch.device,
    batch_size: int,
    route_mode: str = "dynamic",
    *,
    validated_native_domain: bool = False,
) -> dict[str, float]:
    model.eval()
    selected = tuple(value[mask] for value in tensors)
    loader = DataLoader(TensorDataset(*selected), batch_size=batch_size)
    concentration_errors = []
    voltage_errors = []
    voltage_predictions = []
    soc_errors = []
    soc_delta_errors = []
    soc_terminal_delta_errors = []
    soc_direction_matches = []
    coulomb_errors = []
    soc_corrections = []
    temperature_errors = []
    thermal_physics_values = []
    physics_values = []
    fast_physics_values = []
    operator_physics_values = []
    routes = []
    route_predictions = []
    route_oracles = []
    fast_concentration_errors = []
    operator_concentration_errors = []
    fast_voltage_errors = []
    operator_voltage_errors = []
    latencies = []
    for raw_batch in loader:
        batch = model_batch(raw_batch, device)
        if device.type == "cuda":
            torch.cuda.synchronize()
        started = time.perf_counter()
        output = forward_model(
            model,
            batch,
            route_mode=route_mode,
            validated_native_domain=validated_native_domain,
        )
        if device.type == "cuda":
            torch.cuda.synchronize()
        latencies.append((time.perf_counter() - started) * 1000.0)
        concentration_errors.append(
            (output.concentration - batch[7]).abs().cpu()
        )
        fast_concentration_errors.append(
            (output.fast_concentration - batch[7]).abs().cpu()
        )
        operator_concentration_errors.append(
            (output.operator_concentration - batch[7]).abs().cpu()
        )
        voltage_errors.append((output.voltage_v - batch[8]).abs().cpu())
        voltage_predictions.append(output.voltage_v.cpu())
        fast_voltage_errors.append(
            (output.fast_voltage_v - batch[8]).abs().cpu()
        )
        operator_voltage_errors.append(
            (output.operator_voltage_v - batch[8]).abs().cpu()
        )
        soc_errors.append((output.soc - batch[9]).abs().cpu())
        predicted_delta = output.soc - output.soc[:, :1]
        target_delta = batch[9] - batch[9][:, :1]
        soc_delta_errors.append((predicted_delta - target_delta).abs().cpu())
        predicted_terminal = predicted_delta[:, -1]
        target_terminal = target_delta[:, -1]
        soc_terminal_delta_errors.append(
            (predicted_terminal - target_terminal).abs().cpu()
        )
        active_direction = target_terminal.abs() >= SOC_DIRECTION_EPSILON
        if bool(active_direction.any()):
            soc_direction_matches.append(
                (
                    predicted_terminal[active_direction].sign()
                    == target_terminal[active_direction].sign()
                ).float().cpu()
            )
        coulomb_errors.append(
            (
                output.soc
                - coulomb_soc_reference(
                    batch,
                    health_scaled=model.config.health_conditioned_version == 1,
                )
            ).abs().cpu()
        )
        soc_corrections.append(output.soc_correction.abs().cpu())
        temperature_errors.append(
            (output.temperature_c - batch[12]).abs().cpu()
        )
        def residual_rms(
            concentration: Tensor,
            residual_diffusivity: Tensor,
        ) -> Tensor:
            residual = spm_residuals(
                concentration,
                batch[0],
                batch[2],
                residual_diffusivity,
                flux_scale=batch[5],
            )
            return torch.cat(
                (
                    residual.dynamics.flatten(1),
                    residual.center_boundary.flatten(1),
                    residual.surface_boundary.flatten(1),
                    residual.conservation.flatten(1),
                ),
                dim=1,
            ).pow(2).mean(dim=1).sqrt()

        physics_values.append(
            residual_rms(
                output.concentration,
                (
                    output.effective_diffusivity
                    if model.config.thermal_operator_version >= 1
                    else batch[4]
                ),
            ).cpu()
        )
        fast_physics_values.append(
            residual_rms(output.fast_concentration, batch[4]).cpu()
        )
        operator_physics_values.append(
            residual_rms(output.operator_concentration, batch[4]).cpu()
        )
        if model.config.thermal_operator_version >= 1:
            thermal_residuals = lumped_thermal_residuals(
                output.temperature_c,
                batch[1],
                batch[0],
                output.voltage_v,
                output.soc,
                batch[2],
                output.thermal_parameters,
            )
            thermal_physics_values.append(
                thermal_residuals.dynamics.pow(2).mean(dim=1).sqrt().cpu()
            )
        routes.append(output.route_weights.cpu())
        fast_cost, operator_cost = _per_sample_operator_cost(output, batch)
        route_oracles.append(
            torch.stack((fast_cost, operator_cost), dim=-1).argmin(dim=-1).cpu()
        )
        route_predictions.append(output.route_weights.argmax(dim=-1).cpu())
    route_values = torch.cat(routes)
    route_prediction = torch.cat(route_predictions)
    route_oracle = torch.cat(route_oracles)
    fast_members = route_oracle == 0
    operator_members = route_oracle == 1
    fast_recall = (
        float((route_prediction[fast_members] == 0).float().mean())
        if bool(fast_members.any())
        else 0.0
    )
    operator_recall = (
        float((route_prediction[operator_members] == 1).float().mean())
        if bool(operator_members.any())
        else 0.0
    )
    oracle_selected = route_values.gather(1, route_oracle[:, None]).clamp_min(1e-7)
    oracle_counts = torch.bincount(route_oracle, minlength=2).to(route_values.dtype)
    oracle_class_weights = (
        oracle_counts.sum() / (2.0 * oracle_counts.clamp_min(1.0))
    )
    oracle_sample_weights = oracle_class_weights[route_oracle, None]
    weighted_oracle_nll = float(
        -(oracle_sample_weights * oracle_selected.log()).sum()
        / oracle_sample_weights.sum().clamp_min(1e-7)
    )
    latency_sorted = sorted(latencies)
    p95_index = min(
        len(latency_sorted) - 1,
        max(0, math.ceil(0.95 * len(latency_sorted)) - 1),
    )
    voltage_values = torch.cat(voltage_predictions)
    return {
        "concentration_mae": float(torch.cat(concentration_errors).mean()),
        "fast_expert_concentration_mae": float(
            torch.cat(fast_concentration_errors).mean()
        ),
        "pino_expert_concentration_mae": float(
            torch.cat(operator_concentration_errors).mean()
        ),
        "voltage_mae_v": float(torch.cat(voltage_errors).mean()),
        "voltage_min_v": float(voltage_values.min()),
        "voltage_max_v": float(voltage_values.max()),
        "fast_expert_voltage_mae_v": float(
            torch.cat(fast_voltage_errors).mean()
        ),
        "pino_expert_voltage_mae_v": float(
            torch.cat(operator_voltage_errors).mean()
        ),
        "soc_mae": float(torch.cat(soc_errors).mean()),
        "soc_delta_mae": float(torch.cat(soc_delta_errors).mean()),
        "soc_terminal_delta_mae": float(
            torch.cat(soc_terminal_delta_errors).mean()
        ),
        "soc_direction_accuracy": (
            float(torch.cat(soc_direction_matches).mean())
            if soc_direction_matches
            else 1.0
        ),
        "soc_coulomb_residual_mae": float(torch.cat(coulomb_errors).mean()),
        "soc_correction_mae": float(torch.cat(soc_corrections).mean()),
        "temperature_mae_c": float(torch.cat(temperature_errors).mean()),
        "thermal_physics_residual_rms": (
            float(torch.cat(thermal_physics_values).mean())
            if thermal_physics_values
            else 0.0
        ),
        "physics_residual_rms": float(torch.cat(physics_values).mean()),
        "fast_physics_residual_rms": float(
            torch.cat(fast_physics_values).mean()
        ),
        "pino_physics_residual_rms": float(
            torch.cat(operator_physics_values).mean()
        ),
        "fast_route_mean": float(route_values[:, 0].mean()),
        "operator_route_mean": float(route_values[:, 1].mean()),
        "operator_route_std": float(route_values[:, 1].std(unbiased=False)),
        "hard_operator_route_fraction": float((route_prediction == 1).float().mean()),
        "oracle_operator_route_fraction": float((route_oracle == 1).float().mean()),
        "router_oracle_accuracy": float(
            (route_prediction == route_oracle).float().mean()
        ),
        "router_fast_recall": fast_recall,
        "router_operator_recall": operator_recall,
        "router_balanced_accuracy": 0.5 * (fast_recall + operator_recall),
        "router_weighted_oracle_nll": weighted_oracle_nll,
        "p95_batch_latency_ms": latency_sorted[p95_index],
        "samples": int(mask.sum()),
    }


def validation_score(metrics: dict[str, float]) -> float:
    return (
        metrics["concentration_mae"]
        + 0.5 * metrics["voltage_mae_v"]
        + 0.2 * metrics["soc_mae"]
        + 0.3 * metrics["soc_delta_mae"]
        + 0.2 * metrics["soc_terminal_delta_mae"]
        + 0.1 * metrics["soc_coulomb_residual_mae"]
        + 0.05 * metrics["temperature_mae_c"]
    )


@torch.no_grad()
def benchmark_route_latency(
    model: SPMPINOTransformer,
    tensors: tuple[Tensor, ...],
    mask: Tensor,
    device: torch.device,
    *,
    repeats: int = 5,
    validated_native_domain: bool = False,
) -> dict[str, dict[str, float]]:
    """Benchmark request-sized route modes after explicit device warm-up."""
    model.eval()
    indices = mask.nonzero(as_tuple=False).flatten().tolist()
    batches = [
        model_batch(tuple(value[index:index + 1] for value in tensors), device)
        for index in indices
    ]
    if not batches:
        return {}
    results: dict[str, dict[str, float]] = {}
    for route_mode in ("fast", "dynamic", "dynamic_sparse"):
        for batch in batches[: min(5, len(batches))]:
            forward_model(
                model,
                batch,
                route_mode=route_mode,
                validated_native_domain=validated_native_domain,
            )
        if device.type == "cuda":
            torch.cuda.synchronize()
        timings = []
        operator_routes = []
        for _ in range(repeats):
            for batch in batches:
                if device.type == "cuda":
                    torch.cuda.synchronize()
                started = time.perf_counter()
                output = forward_model(
                    model,
                    batch,
                    route_mode=route_mode,
                    validated_native_domain=validated_native_domain,
                )
                if device.type == "cuda":
                    torch.cuda.synchronize()
                timings.append((time.perf_counter() - started) * 1000.0)
                operator_routes.append(
                    float(output.route_weights[:, 1].mean().cpu())
                )
        ordered = sorted(timings)
        p95_index = min(
            len(ordered) - 1,
            max(0, math.ceil(0.95 * len(ordered)) - 1),
        )
        results[route_mode] = {
            "mean_request_latency_ms": float(sum(timings) / len(timings)),
            "median_request_latency_ms": float(
                ordered[len(ordered) // 2]
            ),
            "p95_request_latency_ms": float(ordered[p95_index]),
            "operator_route_fraction": float(
                sum(operator_routes) / len(operator_routes)
            ),
            "requests": len(timings),
        }
    return results


def train_stage(
    *,
    name: str,
    model: SPMPINOTransformer,
    tensors: tuple[Tensor, ...],
    masks: dict[str, Tensor],
    device: torch.device,
    epochs: int,
    patience: int,
    batch_size: int,
    learning_rate: float,
    adaptive_physics: bool,
    hard_sample_mining: bool = False,
    min_constraint_weights: dict[str, float] | None = None,
    residual_adaptive_sampling: bool = False,
    residual_decay_balancing: bool = False,
    physics_curriculum_fraction: float = 0.30,
) -> tuple[dict[str, Tensor], list[dict[str, object]]]:
    train_tensors = tuple(value[masks["train"]] for value in tensors)
    sampler = None
    sample_memory = None
    indexed_dataset = residual_adaptive_sampling
    if hard_sample_mining or residual_adaptive_sampling:
        current = train_tensors[0]
        ramp = (current[:, 1:] - current[:, :-1]).abs().mean(dim=1)
        heating = (
            train_tensors[12] - train_tensors[1]
        ).abs().amax(dim=1)
        risk = current.abs().amax(dim=1) + ramp + 0.2 * heating
        if residual_adaptive_sampling:
            sample_memory = ResidualPriorityMemory(
                risk,
                AdaptiveCurriculumConfig(
                    physics_warmup_fraction=physics_curriculum_fraction,
                ),
            )
            weights = sample_memory.weights(progress=0.0)
        else:
            normalized = risk / risk.median().clamp_min(1e-6)
            weights = (1.0 + normalized.clamp(max=4.0)).double()
        sampler = WeightedRandomSampler(
            weights,
            num_samples=len(weights),
            replacement=True,
        )
    dataset = (
        TensorDataset(torch.arange(len(train_tensors[0])), *train_tensors)
        if indexed_dataset
        else TensorDataset(*train_tensors)
    )
    loader = DataLoader(
        dataset,
        batch_size=batch_size,
        shuffle=sampler is None,
        sampler=sampler,
    )
    frozen_soc_parameters: list[nn.Parameter] = []
    if adaptive_physics and model.config.soc_head_version >= 4:
        frozen_soc_parameters = list(model.soc_correction_head.parameters())
        for parameter in frozen_soc_parameters:
            parameter.requires_grad_(False)
    optimizer = torch.optim.AdamW(
        (parameter for parameter in model.parameters() if parameter.requires_grad),
        lr=learning_rate,
        weight_decay=1e-5,
    )
    constraint_weights = {
        "pde": 0.15,
        "boundary": 0.06,
        "conservation": 0.08,
        "initial": 0.04,
    }
    if model.config.thermal_operator_version >= 1:
        constraint_weights.update(
            {
                "thermal_dynamics": 0.08,
                "thermal_initial": 0.03,
            }
        )
    if model.config.degradation_head_version >= 1:
        constraint_weights.update(
            {
                "degradation_anchor": 0.04,
                "degradation_monotonic": 0.02,
            }
        )
    balancer = (
        MultiConstraintBalancer(
            constraint_weights,
            min_weights=min_constraint_weights,
            max_weight=0.2,
            residual_decay_alpha=(
                0.50 if residual_decay_balancing else 0.0
            ),
        )
        if adaptive_physics
        else None
    )
    best_state = copy.deepcopy(model.state_dict())
    best_score = float("inf")
    stale = 0
    step = 0
    history: list[dict[str, object]] = []
    for epoch in range(1, epochs + 1):
        model.train()
        # Epoch one starts data-only; physics authority and hard-sample
        # preference are released only after the backbone has seen the full
        # training distribution once.
        progress = curriculum_progress(epoch - 1, epochs)
        if sample_memory is not None and sampler is not None:
            sampler.weights.copy_(sample_memory.weights(progress))
        if balancer is not None:
            balancer.set_curriculum_authority(
                physics_curriculum_authority(
                    progress,
                    physics_curriculum_fraction,
                )
            )
        train_total = 0.0
        batches = 0
        conflict_counts = {constraint: 0 for constraint in constraint_weights}
        for raw_batch in loader:
            if indexed_dataset:
                sample_indices = raw_batch[0]
                batch = model_batch(raw_batch[1:], device)
            else:
                sample_indices = None
                batch = model_batch(raw_batch, device)
            optimizer.zero_grad(set_to_none=True)
            output = forward_model(model, batch)
            data_loss = supervised_loss(
                output,
                batch,
                health_scaled=model.config.health_conditioned_version == 1,
            )
            route_loss = routing_loss(output, batch)
            loss = data_loss + 0.01 * route_loss
            diagnostics = None
            physics_residuals = None
            if balancer is not None:
                constraint_losses, physics_residuals = spm_physics_losses(
                    # PINO is the high-fidelity expert; train its operator
                    # directly against physics instead of diluting the signal
                    # through the routed mixture.
                    (
                        output.concentration
                        if model.config.multiphysics_version >= 1
                        else output.operator_concentration
                    ),
                    batch[0],
                    batch[2],
                    (
                        output.effective_diffusivity
                        if model.config.thermal_operator_version >= 1
                        else batch[4]
                    ),
                    batch[3],
                    flux_scale=batch[5],
                )
                if model.config.thermal_operator_version >= 1:
                    thermal_losses, _ = thermal_physics_losses(
                        output.temperature_c,
                        batch[1],
                        batch[0],
                        output.voltage_v,
                        output.soc,
                        batch[2],
                        output.thermal_parameters,
                    )
                    constraint_losses.update(thermal_losses)
                if model.config.degradation_head_version >= 1:
                    constraint_losses.update(
                        degradation_state_losses(
                            output.degradation_state,
                            batch[13],
                        )
                    )
                diagnostics = balancer.update(
                    data_loss,
                    constraint_losses,
                    model.parameters(),
                    step,
                )
                loss = loss + balancer.weighted_loss(constraint_losses)
                for constraint, conflicted in diagnostics.conflicted.items():
                    conflict_counts[constraint] += int(conflicted)
            if sample_memory is not None and sample_indices is not None:
                sample_difficulty = (
                    (output.operator_voltage_v - batch[8])
                    .abs()
                    .mean(dim=1)
                    + 0.25
                    * (output.soc - batch[9]).abs().mean(dim=1)
                    + 0.10
                    * (
                        output.operator_concentration - batch[7]
                    ).abs().flatten(1).mean(dim=1)
                )
                if physics_residuals is not None:
                    sample_difficulty = sample_difficulty + 0.10 * torch.cat(
                        (
                            physics_residuals.dynamics.flatten(1),
                            physics_residuals.center_boundary.flatten(1),
                            physics_residuals.surface_boundary.flatten(1),
                            physics_residuals.conservation.flatten(1),
                        ),
                        dim=1,
                    ).pow(2).mean(dim=1).sqrt()
                sample_memory.update(
                    sample_indices,
                    sample_difficulty.detach().cpu(),
                )
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), max_norm=2.0)
            optimizer.step()
            train_total += float(loss.detach().cpu())
            batches += 1
            step += 1
        validation = evaluate(
            model,
            tensors,
            masks["validation"],
            device,
            batch_size,
        )
        score = validation_score(validation)
        if adaptive_physics:
            # Select the Pareto candidate on the actual high-fidelity expert,
            # not on the still-uncalibrated routed mixture.
            score += 0.20 * validation["pino_physics_residual_rms"]
            if model.config.thermal_operator_version >= 1:
                score += 0.05 * validation["thermal_physics_residual_rms"]
        record: dict[str, object] = {
            "epoch": epoch,
            "train_loss": train_total / max(batches, 1),
            **validation,
        }
        if balancer is not None:
            record["constraint_weights"] = balancer.weights
            record["conflicted_batches"] = conflict_counts
            record["residual_decay_multipliers"] = (
                diagnostics.decay_multipliers
                if diagnostics is not None
                else {}
            )
            record["physics_curriculum_authority"] = (
                diagnostics.curriculum_authority
                if diagnostics is not None
                else 1.0
            )
        if sample_memory is not None:
            record["adaptive_sampling"] = {
                **sample_memory.diagnostics(),
                "priority_min": float(sampler.weights.min()),
                "priority_max": float(sampler.weights.max()),
                "curriculum_progress": progress,
            }
        history.append(record)
        print(
            f"{name} epoch={epoch} val={score:.6f} "
            f"v={validation['voltage_mae_v']:.5f} "
            f"c={validation['concentration_mae']:.5f} "
            f"phys={validation['pino_physics_residual_rms']:.5f}"
        )
        if score < best_score:
            best_score = score
            best_state = copy.deepcopy(model.state_dict())
            stale = 0
        else:
            stale += 1
            if stale >= patience:
                break
    model.load_state_dict(best_state)
    for parameter in frozen_soc_parameters:
        parameter.requires_grad_(True)
    return best_state, history


def calibrate_router(
    *,
    model: SPMPINOTransformer,
    tensors: tuple[Tensor, ...],
    masks: dict[str, Tensor],
    device: torch.device,
    epochs: int,
    patience: int,
    batch_size: int,
    learning_rate: float,
) -> list[dict[str, object]]:
    """Train only the router against the per-sample expert-cost oracle."""
    train_tensors = tuple(value[masks["train"]] for value in tensors)
    train_dataset = TensorDataset(*train_tensors)
    oracle_loader = DataLoader(train_dataset, batch_size=batch_size)
    oracle_items = []
    model.eval()
    with torch.no_grad():
        for raw_batch in oracle_loader:
            batch = model_batch(raw_batch, device)
            output = forward_model(model, batch)
            fast_cost, operator_cost = _per_sample_operator_cost(output, batch)
            oracle_items.append(
                torch.stack((fast_cost, operator_cost), dim=-1)
                .argmin(dim=-1)
                .cpu()
            )
    oracle_labels = torch.cat(oracle_items)
    oracle_counts = torch.bincount(oracle_labels, minlength=2).float()
    if bool((oracle_counts == 0).any()):
        # A router cannot learn complementarity when one expert never wins.
        # Keep deterministic sampling so the downstream gate reports failure.
        sampler = None
    else:
        class_weights = oracle_counts.sum() / (2.0 * oracle_counts)
        sample_weights = class_weights[oracle_labels].double()
        sampler = WeightedRandomSampler(
            sample_weights,
            num_samples=len(train_dataset),
            replacement=True,
        )
    loader = DataLoader(
        train_dataset,
        batch_size=batch_size,
        shuffle=sampler is None,
        sampler=sampler,
    )
    for parameter in model.parameters():
        parameter.requires_grad_(False)
    for parameter in model.router.parameters():
        parameter.requires_grad_(True)
    # Earlier joint training starts with a deliberate fast-expert prior.
    # Calibration is class-balanced, so remove that prior before fitting the
    # final sparse decision boundary.
    final_router_layer = model.router.network[-1]
    if isinstance(final_router_layer, nn.Linear):
        with torch.no_grad():
            final_router_layer.bias.zero_()
    optimizer = torch.optim.AdamW(
        model.router.parameters(),
        lr=learning_rate,
        weight_decay=1e-5,
    )
    best_state = copy.deepcopy(model.router.state_dict())
    best_score = -float("inf")
    stale = 0
    history: list[dict[str, object]] = []
    try:
        for epoch in range(1, epochs + 1):
            model.eval()
            model.router.train()
            train_total = 0.0
            batches = 0
            for raw_batch in loader:
                batch = model_batch(raw_batch, device)
                optimizer.zero_grad(set_to_none=True)
                output = forward_model(model, batch)
                loss = routing_loss(output, batch)
                loss.backward()
                nn.utils.clip_grad_norm_(model.router.parameters(), max_norm=2.0)
                optimizer.step()
                train_total += float(loss.detach().cpu())
                batches += 1
            validation = evaluate(
                model,
                tensors,
                masks["validation"],
                device,
                batch_size,
            )
            minimum_recall = min(
                validation["router_fast_recall"],
                validation["router_operator_recall"],
            )
            score = (
                validation["router_balanced_accuracy"]
                + 0.25 * minimum_recall
                - 0.05 * validation["router_weighted_oracle_nll"]
            )
            record: dict[str, object] = {
                "epoch": epoch,
                "train_loss": train_total / max(batches, 1),
                "calibration_oracle_counts": {
                    "fast": int(oracle_counts[0]),
                    "operator": int(oracle_counts[1]),
                },
                "selection_score": score,
                **validation,
            }
            history.append(record)
            print(
                f"router-calibration epoch={epoch} "
                f"balanced={validation['router_balanced_accuracy']:.4f} "
                f"fast_recall={validation['router_fast_recall']:.4f} "
                f"operator_recall={validation['router_operator_recall']:.4f}"
                f" nll={validation['router_weighted_oracle_nll']:.4f}"
            )
            if score > best_score:
                best_score = score
                best_state = copy.deepcopy(model.router.state_dict())
                stale = 0
            else:
                stale += 1
                if stale >= patience:
                    break
        model.router.load_state_dict(best_state)
    finally:
        for parameter in model.parameters():
            parameter.requires_grad_(True)
    return history


def main() -> None:
    args = parse_args()
    if not 0.0 <= args.physics_curriculum_fraction <= 1.0:
        raise ValueError("--physics-curriculum-fraction 必须位于 [0, 1]。")
    assert_isolated_candidate_path(args.output)
    if args.router_only and args.warm_start_checkpoint is None:
        raise ValueError("--router-only 必须同时提供 --warm-start-checkpoint。")
    if args.multiphysics_v1 and args.warm_start_checkpoint is None:
        raise ValueError("--multiphysics-v1 必须从隔离的 v10.6 检查点热启动。")
    if args.router_only and args.multiphysics_v1:
        raise ValueError("--router-only 与 --multiphysics-v1 不能同时使用。")
    if (
        args.warm_start_checkpoint is not None
        and not args.router_only
        and not args.multiphysics_v1
    ):
        raise ValueError(
            "--warm-start-checkpoint 仅用于 --router-only 或 --multiphysics-v1。"
        )
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    if args.dataset:
        dataset = load_spm_npz(str(args.dataset))
        if dataset.metadata.get("soc_definition") != "cell-soc-coulomb-integral-v2":
            raise ValueError(
                "拒绝训练：数据集必须声明 "
                "soc_definition=cell-soc-coulomb-integral-v2；"
                "旧数据将负极化学计量比误作 SOC。"
            )
        chemistry_family = str(
            dataset.metadata.get("chemistry_family", "")
        )
        if (
            args.required_chemistry_family
            and chemistry_family.lower()
            != args.required_chemistry_family.lower()
        ):
            raise ValueError(
                "拒绝训练：数据 chemistry_family="
                f"{chemistry_family or '未声明'}，要求 "
                f"{args.required_chemistry_family}。"
            )
        if (
            bool(dataset.metadata.get("multifidelity", False))
            and dataset.metadata.get("capacity_ratio_source")
            not in {"unity", "observed-before-window"}
        ):
            raise ValueError(
                "拒绝训练：多保真 capacity_ratio 必须来自窗口开始前的"
                "可观测数据；旧版完整目标 SOC 拟合存在标签泄漏。"
            )
        args.scenarios = len(dataset.scenario_family)
        args.time_steps = dataset.current_c_rate.shape[1]
        args.radial_points = dataset.concentration.shape[2]
        data_backend = f"pybamm-npz:{args.dataset}"
    else:
        dataset = generate_dimensionless_spm_dataset(
            args.scenarios,
            time_steps=args.time_steps,
            radial_points=args.radial_points,
            seed=args.seed,
        )
        data_backend = "dimensionless-conservative-spm"
    masks = split_masks(dataset, args.split_seed)
    tensors = dataset.tensors()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    warm_payload = None
    if args.warm_start_checkpoint is not None:
        warm_payload = torch.load(
            args.warm_start_checkpoint,
            map_location=device,
            weights_only=False,
        )
        base_config = SPMPINOTransformerConfig(**warm_payload["config"])
        if base_config.soc_head_version < 4:
            raise ValueError("热启动仅接受 SOC dynamics v4 候选模型。")
        config = (
            replace(
                base_config,
                multiphysics_version=1,
                thermal_operator_version=1,
                cross_physics_attention_version=1,
                degradation_head_version=1,
                degradation_context_version=1,
            )
            if args.multiphysics_v1
            else base_config
        )
    else:
        config = SPMPINOTransformerConfig(
            model_dim=args.model_dim,
            operator_width=args.operator_width,
            operator_layers=args.operator_layers,
            radial_modes=args.radial_modes,
            soc_head_version=4,
            soc_correction_limit=0.02,
            temperature_head_version=1 if args.multifidelity_v5 else 0,
            operator_residual_version=(
                1 if args.multifidelity_v5 or args.operator_residual else 0
            ),
            health_conditioned_version=2 if args.multifidelity_v5 else 0,
            router_feature_version=args.router_feature_version,
            sparse_physics_override_threshold=args.sparse_physics_override_threshold,
            sparse_router_probability_threshold=args.sparse_router_probability_threshold,
        )
    model = SPMPINOTransformer(config).to(device)
    model.set_radial_resolution(args.radial_points)
    if warm_payload is not None:
        if args.multiphysics_v1:
            incompatible = model.load_state_dict(
                warm_payload["state_dict"],
                strict=False,
            )
            if incompatible.unexpected_keys or any(
                not key.startswith(MULTIPHYSICS_PARAMETER_PREFIXES)
                for key in incompatible.missing_keys
            ):
                raise ValueError(
                    "v10.6 多物理迁移出现非增量参数不兼容："
                    f"missing={incompatible.missing_keys}, "
                    f"unexpected={incompatible.unexpected_keys}"
                )
            if args.degradation_pretrain_checkpoint is not None:
                degradation_payload = torch.load(
                    args.degradation_pretrain_checkpoint,
                    map_location=device,
                    weights_only=False,
                )
                adapter_state = degradation_payload.get("adapter_state_dict")
                if not isinstance(adapter_state, dict) or not adapter_state:
                    raise ValueError("退化预训练检查点缺少 adapter_state_dict。")
                allowed_prefixes = (
                    "degradation_context_encoder.",
                    "degradation_prior_head.",
                    "degradation_context_gate",
                )
                invalid = [
                    name
                    for name in adapter_state
                    if not name.startswith(allowed_prefixes)
                ]
                if invalid:
                    raise ValueError(
                        "退化预训练检查点包含越权参数："
                        + ", ".join(invalid[:3])
                    )
                model.load_state_dict(adapter_state, strict=False)
            stage1_state = copy.deepcopy(model.state_dict())
            stage1_test = evaluate(
                model,
                tensors,
                masks["test"],
                device,
                args.batch_size,
            )
            trainable_multiphysics_parameters = (
                freeze_v10_backbone_for_multiphysics(model)
            )
            _, stage1_history = train_stage(
                name="multiphysics-data-only",
                model=model,
                tensors=tensors,
                masks=masks,
                device=device,
                epochs=args.stage1_epochs,
                patience=args.patience,
                batch_size=args.batch_size,
                learning_rate=args.learning_rate,
                adaptive_physics=False,
                hard_sample_mining=args.hard_sample_mining,
                residual_adaptive_sampling=args.residual_adaptive_sampling,
                physics_curriculum_fraction=args.physics_curriculum_fraction,
            )
            _, stage2_history = train_stage(
                name="multiphysics-coupled-physics",
                model=model,
                tensors=tensors,
                masks=masks,
                device=device,
                epochs=args.stage2_epochs,
                patience=args.patience,
                batch_size=args.batch_size,
                learning_rate=args.stage2_learning_rate,
                adaptive_physics=True,
                hard_sample_mining=args.hard_sample_mining,
                min_constraint_weights={
                    "thermal_dynamics": args.thermal_dynamics_min_weight,
                },
                residual_adaptive_sampling=args.residual_adaptive_sampling,
                residual_decay_balancing=args.residual_decay_balancing,
                physics_curriculum_fraction=args.physics_curriculum_fraction,
            )
        else:
            model.load_state_dict(warm_payload["state_dict"])
            candidate_state = copy.deepcopy(model.state_dict())
            if "stage1_state_dict" not in warm_payload:
                raise ValueError("热启动检查点缺少 stage1_state_dict，无法公平门禁。")
            stage1_state = warm_payload["stage1_state_dict"]
            model.load_state_dict(stage1_state)
            stage1_test = evaluate(
                model,
                tensors,
                masks["test"],
                device,
                args.batch_size,
            )
            model.load_state_dict(candidate_state)
            if args.router_feature_version != config.router_feature_version:
                model.upgrade_router(args.router_feature_version)
            model.set_sparse_override_threshold(
                args.sparse_physics_override_threshold
            )
            model.set_sparse_router_probability_threshold(
                args.sparse_router_probability_threshold
            )
            stage1_history = []
            stage2_history = []
            trainable_multiphysics_parameters = []
    else:
        _, stage1_history = train_stage(
            name="data-only",
            model=model,
            tensors=tensors,
            masks=masks,
            device=device,
            epochs=args.stage1_epochs,
            patience=args.patience,
            batch_size=args.batch_size,
            learning_rate=args.learning_rate,
            adaptive_physics=False,
            hard_sample_mining=args.hard_sample_mining,
            residual_adaptive_sampling=args.residual_adaptive_sampling,
            physics_curriculum_fraction=args.physics_curriculum_fraction,
        )
        stage1_test = evaluate(
            model,
            tensors,
            masks["test"],
            device,
            args.batch_size,
        )
        stage1_state = copy.deepcopy(model.state_dict())

        model.load_state_dict(stage1_state)
        _, stage2_history = train_stage(
            name="adaptive-pino",
            model=model,
            tensors=tensors,
            masks=masks,
            device=device,
            epochs=args.stage2_epochs,
            patience=args.patience,
            batch_size=args.batch_size,
            learning_rate=args.stage2_learning_rate,
            adaptive_physics=True,
            hard_sample_mining=args.hard_sample_mining,
            residual_adaptive_sampling=args.residual_adaptive_sampling,
            residual_decay_balancing=args.residual_decay_balancing,
            physics_curriculum_fraction=args.physics_curriculum_fraction,
        )
        trainable_multiphysics_parameters = []
    router_history = []
    if not args.expert_only and not args.multiphysics_v1:
        router_history = calibrate_router(
            model=model,
            tensors=tensors,
            masks=masks,
            device=device,
            epochs=args.router_epochs,
            patience=args.patience,
            batch_size=args.batch_size,
            learning_rate=args.router_learning_rate,
        )
    candidate_test = evaluate(
        model,
        tensors,
        masks["test"],
        device,
        args.batch_size,
    )
    deployment_test = evaluate(
        model,
        tensors,
        masks["test"],
        device,
        args.batch_size,
        route_mode="dynamic_sparse",
    )
    route_latency_benchmark = benchmark_route_latency(
        model,
        tensors,
        masks["test"],
        device,
    )
    family_test_metrics = {}
    for family in sorted(set(dataset.scenario_family)):
        family_mask = masks["test"].clone()
        family_membership = torch.tensor(
            [item == family for item in dataset.scenario_family],
            dtype=torch.bool,
        )
        family_mask &= family_membership
        family_test_metrics[family] = evaluate(
            model,
            tensors,
            family_mask,
            device,
            args.batch_size,
        )
    accuracy_metrics = (
        "concentration_mae",
        "voltage_mae_v",
        "soc_mae",
        "soc_delta_mae",
        "soc_terminal_delta_mae",
        "soc_coulomb_residual_mae",
        "temperature_mae_c",
    )
    accuracy_checks = {
        metric: candidate_test[metric] <= stage1_test[metric] * 1.03
        for metric in accuracy_metrics
    }
    if args.expert_only:
        accuracy_checks["concentration_mae"] = (
            candidate_test["pino_expert_concentration_mae"]
            <= stage1_test["pino_expert_concentration_mae"] * 1.03
        )
        accuracy_checks["voltage_mae_v"] = (
            candidate_test["pino_expert_voltage_mae_v"]
            <= stage1_test["pino_expert_voltage_mae_v"] * 1.03
        )
    # A multiphysics candidate deliberately freezes the original PINO expert.
    # Its raw residual is therefore an invariant migration check, not an
    # improvable objective.  Gate the coupled electrochemical residual that
    # uses the learned Arrhenius diffusivity instead.
    physics_metric = (
        "physics_residual_rms"
        if args.multiphysics_v1
        else "pino_physics_residual_rms"
        if args.expert_only
        else "physics_residual_rms"
    )
    physics_improvement = (
        stage1_test[physics_metric]
        - candidate_test[physics_metric]
    ) / max(stage1_test[physics_metric], 1e-12)
    minimum_physics_improvement = 0.10 if args.multifidelity_v5 else 0.20
    pino_passed = bool(
        all(accuracy_checks.values())
        and physics_improvement >= minimum_physics_improvement
        and candidate_test["soc_direction_accuracy"] >= 0.90
        and candidate_test["soc_terminal_delta_mae"] <= 0.01
    )
    thermal_physics_improvement = (
        stage1_test["thermal_physics_residual_rms"]
        - candidate_test["thermal_physics_residual_rms"]
    ) / max(stage1_test["thermal_physics_residual_rms"], 1e-12)
    multiphysics_checks = {}
    if args.multiphysics_v1:
        multiphysics_checks = {
            "thermal_residual_improves_at_least_20pct": (
                thermal_physics_improvement >= 0.20
            ),
            "temperature_mae_not_worse_than_3pct": (
                candidate_test["temperature_mae_c"]
                <= stage1_test["temperature_mae_c"] * 1.03 + 1e-6
            ),
        }
        pino_passed = pino_passed and all(multiphysics_checks.values())
    chemistry_family = str(
        dataset.metadata.get("chemistry_family", "")
    ).upper()
    chemistry_voltage_checks = {}
    if chemistry_family == "LFP":
        chemistry_voltage_checks = {
            "lfp_voltage_min_at_least_2_0v": (
                candidate_test["voltage_min_v"] >= 2.0
            ),
            "lfp_voltage_max_at_most_3_8v": (
                candidate_test["voltage_max_v"] <= 3.8
            ),
        }
        pino_passed = pino_passed and all(chemistry_voltage_checks.values())
    oracle_fraction = candidate_test["oracle_operator_route_fraction"]
    hard_fraction = deployment_test["hard_operator_route_fraction"]
    routing_checks = {
        "experts_are_complementary": 0.05 <= oracle_fraction <= 0.95,
        "router_balanced_accuracy_at_least_0_60": (
            candidate_test["router_balanced_accuracy"] >= 0.60
        ),
        "operator_recall_at_least_0_50": (
            candidate_test["router_operator_recall"] >= 0.50
        ),
        "deployed_top1_uses_both_paths": 0.05 <= hard_fraction <= 0.95,
        "sparse_deployment_accuracy_within_3pct": (
            deployment_test["concentration_mae"]
            <= stage1_test["concentration_mae"] * 1.03
            and deployment_test["voltage_mae_v"]
            <= stage1_test["voltage_mae_v"] * 1.03
        ),
        "sparse_mean_latency_below_dual_expert": (
            route_latency_benchmark["dynamic_sparse"][
                "mean_request_latency_ms"
            ]
            < route_latency_benchmark["dynamic"]["mean_request_latency_ms"]
        ),
    }
    routing_passed = (
        None if args.expert_only else all(routing_checks.values())
    )
    expert_parity_checks = {
        "pino_concentration_within_5pct_of_standard": (
            candidate_test["pino_expert_concentration_mae"]
            <= (
                stage1_test["pino_expert_concentration_mae"]
                if args.expert_only
                else stage1_test["concentration_mae"]
            )
            * 1.05
        ),
        "pino_voltage_within_5pct_of_standard": (
            candidate_test["pino_expert_voltage_mae_v"]
            <= (
                stage1_test["pino_expert_voltage_mae_v"]
                if args.expert_only
                else stage1_test["voltage_mae_v"]
            )
            * 1.05
        ),
        "fast_expert_within_5pct_of_standard": (
            candidate_test["fast_expert_concentration_mae"]
            <= stage1_test["concentration_mae"] * 1.05
        ),
    }
    required_expert_parity_checks = {
        name: passed
        for name, passed in expert_parity_checks.items()
        if not (args.expert_only and name == "fast_expert_within_5pct_of_standard")
    }
    candidate_gate = {
        "passed": bool(
            pino_passed
            and (args.expert_only or routing_passed)
            and all(required_expert_parity_checks.values())
        ),
        "pino_passed": pino_passed,
        "routing_passed": routing_passed,
        "accuracy_not_worse_than_3pct": accuracy_checks,
        "physics_improvement": physics_improvement,
        "physics_metric": physics_metric,
        "minimum_physics_improvement": minimum_physics_improvement,
        "thermal_physics_improvement": thermal_physics_improvement,
        "multiphysics_checks": multiphysics_checks,
        "soc_dynamics_checks": {
            "direction_accuracy_at_least_0_90": (
                candidate_test["soc_direction_accuracy"] >= 0.90
            ),
            "terminal_delta_mae_at_most_0_01": (
                candidate_test["soc_terminal_delta_mae"] <= 0.01
            ),
        },
        "chemistry_voltage_checks": chemistry_voltage_checks,
        "routing_checks": routing_checks,
        "expert_parity_checks": expert_parity_checks,
        "required_expert_parity_checks": required_expert_parity_checks,
        "scope": f"{data_backend}; isolated candidate, not a production gate",
    }
    metadata = {
        "model_version": args.model_version.strip() or args.output.stem,
        "status": "isolated research candidate; no production adapter",
        "training_mode": (
            "router-only-frozen-v4"
            if args.router_only
            else "v10.6-frozen-backbone-multiphysics-v1"
            if args.multiphysics_v1
            else "expert-only"
            if args.expert_only
            else "full-v5-multifidelity"
            if args.multifidelity_v5
            else "full-v4"
        ),
        "warm_start_checkpoint": (
            str(args.warm_start_checkpoint)
            if args.warm_start_checkpoint
            else None
        ),
        "degradation_pretrain_checkpoint": (
            str(args.degradation_pretrain_checkpoint)
            if args.degradation_pretrain_checkpoint
            else None
        ),
        "trainable_multiphysics_parameters": trainable_multiphysics_parameters,
        "router_action": (
            "frozen-preserved-from-warm-start"
            if args.multiphysics_v1
            else "calibrated"
            if not args.expert_only
            else "not-trained"
        ),
        "hard_sample_mining": args.hard_sample_mining,
        "seed": args.seed,
        "split_seed": args.split_seed,
        "data_backend": data_backend,
        "soc_definition": dataset.metadata.get("soc_definition"),
        "dataset_metadata": dataset.metadata,
        "scenario_families": sorted(set(dataset.scenario_family)),
        "scenarios": args.scenarios,
        "split_strategy": (
            "leave-one-cell-out-test"
            if bool(dataset.metadata.get("multifidelity", False))
            else "source-cycle-grouped-stratified"
            if dataset.group_id is not None
            else "scenario-stratified"
        ),
        "split_samples": {
            name: int(mask.sum()) for name, mask in masks.items()
        },
        "source_groups": (
            len(set(dataset.group_id))
            if dataset.group_id is not None
            else args.scenarios
        ),
        "time_steps": args.time_steps,
        "radial_points": args.radial_points,
        "stage1_test_metrics": stage1_test,
        "candidate_test_metrics": candidate_test,
        "sparse_deployment_test_metrics": deployment_test,
        "route_latency_benchmark": route_latency_benchmark,
        "family_test_metrics": family_test_metrics,
        "candidate_gate": candidate_gate,
        "stage1_history": stage1_history,
        "stage2_history": stage2_history,
        "router_history": router_history,
        "device": str(device),
        "production_action": "none",
    }
    payload = model.checkpoint_payload(metadata)
    compatible_stage1_state = copy.deepcopy(model.state_dict())
    for name, value in stage1_state.items():
        if not name.startswith("router.") and name in compatible_stage1_state:
            compatible_stage1_state[name] = value
    payload["stage1_state_dict"] = compatible_stage1_state
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(payload, args.output)
    print(json.dumps(
        {
            "checkpoint": str(args.output),
            "config": asdict(model.config),
            **metadata,
        },
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()
