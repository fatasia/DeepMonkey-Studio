"""Shared transfer-learning primitives for the research PINO candidates.

Support observations are pooled without query targets, K=0 remains a
first-class zero-shot case, and missing sensor values are distinguished from
physical zeros by an explicit observation mask.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Iterable, Literal

import torch
from torch import Tensor, nn


TRANSFER_ACTIONS = ("direct", "few_shot", "pino", "solver")


@dataclass(frozen=True)
class SensorCorruption:
    current_c_rate: Tensor
    temperature_c: Tensor
    observed_mask: Tensor


@dataclass(frozen=True)
class TransferRiskDecision:
    score: Tensor
    action_index: Tensor
    action_names: tuple[str, ...] = TRANSFER_ACTIONS

    @property
    def actions(self) -> list[str]:
        return [
            self.action_names[int(index)]
            for index in self.action_index.detach().cpu().tolist()
        ]


PHYSICAL_PARAMETER_NAMES = (
    "capacity_scale",
    "ohmic_resistance",
    "polarization_resistance",
    "polarization_time_constant",
    "ocv_shift",
    "solid_diffusivity",
    "heat_transfer",
    "thermal_capacity",
)


@dataclass(frozen=True)
class TestTimeOptimizationResult:
    physical_prompt_delta: Tensor
    protocol_context_delta: Tensor
    loss_history: tuple[float, ...]
    optimized_parameter_count: int


class SupportPhysicalParameterIdentifier(nn.Module):
    """Identify bounded *effective* parameters from a disjoint support set.

    The outputs are dimensionless corrections, not direct laboratory
    measurements.  They are useful as an interpretable calibration state and
    may only affect predictions through separately gated physical equations.
    """

    def __init__(
        self,
        *,
        support_features: int,
        model_dim: int,
        parameter_count: int = len(PHYSICAL_PARAMETER_NAMES),
        prompt_features: int = 0,
    ) -> None:
        super().__init__()
        self.support_features = support_features
        self.parameter_count = parameter_count
        self.prompt_features = prompt_features
        self.encoder = nn.Sequential(
            nn.Linear(support_features, model_dim),
            nn.GELU(),
            nn.LayerNorm(model_dim),
            nn.Linear(model_dim, model_dim),
            nn.GELU(),
        )
        if prompt_features > 0:
            self.query_encoder = nn.Sequential(
                nn.Linear(prompt_features, model_dim),
                nn.GELU(),
                nn.Linear(model_dim, model_dim),
            )
        self.head = nn.Linear(
            model_dim * (2 if prompt_features > 0 else 1),
            parameter_count,
        )
        self.effect_gate = nn.Parameter(torch.zeros(parameter_count))
        nn.init.xavier_uniform_(self.head.weight, gain=0.05)
        nn.init.zeros_(self.head.bias)

    def forward(
        self,
        support: Tensor | None,
        support_mask: Tensor | None,
        *,
        reference: Tensor,
        physical_prompt: Tensor | None = None,
        anchor_capacity: bool = False,
    ) -> tuple[Tensor, Tensor, Tensor]:
        batch = reference.shape[0]
        if support is None:
            support = reference.new_zeros(batch, 1, self.support_features)
            support_mask = torch.zeros(
                batch, 1, dtype=torch.bool, device=reference.device
            )
        if support.ndim != 3 or support.shape != (
            batch,
            support.shape[1],
            self.support_features,
        ):
            raise ValueError(
                "物理参数识别 support 必须为 "
                f"[batch, shots, {self.support_features}]。"
            )
        if support_mask is None:
            support_mask = torch.ones(
                support.shape[:2], dtype=torch.bool, device=support.device
            )
        if support_mask.shape != support.shape[:2]:
            raise ValueError("物理参数识别 support_mask 形状不匹配。")
        weights = support_mask.to(support.dtype).unsqueeze(-1)
        encoded = self.encoder(support)
        pooled = (encoded * weights).sum(dim=1) / weights.sum(
            dim=1
        ).clamp_min(1.0)
        has_support = support_mask.any(dim=1).to(support.dtype).unsqueeze(-1)
        features = pooled
        if self.prompt_features > 0:
            if physical_prompt is None:
                physical_prompt = reference.new_zeros(
                    batch,
                    self.prompt_features,
                )
            if physical_prompt.shape != (batch, self.prompt_features):
                raise ValueError(
                    "条件化物理参数识别需要匹配的 physical_prompt。"
                )
            features = torch.cat(
                (pooled, self.query_encoder(physical_prompt)),
                dim=-1,
            )
        raw = torch.tanh(self.head(features)) * has_support
        confidence = torch.zeros_like(raw)
        if anchor_capacity:
            support_capacity = (
                support[:, :, 11] * weights.squeeze(-1)
            ).sum(dim=1) / weights.squeeze(-1).sum(dim=1).clamp_min(1.0)
            anchored_capacity = (
                (support_capacity - 0.85) / 0.15
            ).clamp(-1.0, 1.0)
            raw = raw.clone()
            raw[:, 0] = anchored_capacity * has_support.squeeze(-1)
            # Capacity is directly observed in the support contract. Other
            # latent parameters remain rejected until external calibration
            # proves identifiability.
            confidence[:, 0] = has_support.squeeze(-1)
        else:
            confidence = has_support.expand_as(raw)
        effective = raw * torch.tanh(self.effect_gate) * confidence
        return raw, effective, confidence


class ProtocolContextEncoder(nn.Module):
    """Encode a leakage-free operating protocol into a neutral residual."""

    def __init__(
        self,
        *,
        context_features: int,
        model_dim: int,
        dropout: float,
    ) -> None:
        super().__init__()
        self.context_features = context_features
        self.encoder = nn.Sequential(
            nn.Linear(context_features, model_dim),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(model_dim, model_dim),
        )
        self.gate = nn.Parameter(torch.zeros(()))

    def forward(self, context: Tensor, *, time_steps: int) -> tuple[Tensor, Tensor]:
        if context.ndim != 2 or context.shape[1] != self.context_features:
            raise ValueError(
                "protocol_context 必须为 "
                f"[batch, {self.context_features}]。"
            )
        strength = torch.tanh(self.gate)
        residual = (
            strength
            * 0.10
            * torch.tanh(self.encoder(context)).unsqueeze(1)
        )
        return residual.expand(-1, time_steps, -1), strength


class FewShotTransferAdapter(nn.Module):
    """FiLM adapter conditioned on K support trajectories and a prompt.

    The final projection and scalar gate are zero-initialised. Adding this
    module to an existing checkpoint is therefore a neutral migration until
    the isolated research adapter is explicitly trained.
    """

    def __init__(
        self,
        *,
        support_features: int,
        prompt_features: int,
        model_dim: int,
        dropout: float,
        robust_support: bool = False,
    ) -> None:
        super().__init__()
        self.support_features = support_features
        self.prompt_features = prompt_features
        self.model_dim = model_dim
        self.robust_support = robust_support
        self.support_encoder = nn.Sequential(
            nn.Linear(support_features, model_dim),
            nn.GELU(),
            nn.LayerNorm(model_dim),
            nn.Dropout(dropout),
            nn.Linear(model_dim, model_dim),
        )
        self.prompt_encoder = nn.Sequential(
            nn.Linear(prompt_features, model_dim),
            nn.GELU(),
            nn.Linear(model_dim, model_dim),
        )
        self.film = nn.Linear(model_dim * 2, model_dim * 2)
        self.gate = nn.Parameter(torch.zeros(()))
        self.calibration_gate = nn.Parameter(torch.zeros(3))
        nn.init.zeros_(self.film.weight)
        nn.init.zeros_(self.film.bias)

    def forward(
        self,
        temporal: Tensor,
        support: Tensor | None,
        support_mask: Tensor | None,
        physical_prompt: Tensor | None,
    ) -> tuple[Tensor, Tensor, Tensor]:
        batch = temporal.shape[0]
        if support is None:
            support = temporal.new_zeros(batch, 1, self.support_features)
            support_mask = torch.zeros(
                batch,
                1,
                dtype=torch.bool,
                device=temporal.device,
            )
        if support.ndim != 3 or support.shape[0] != batch:
            raise ValueError("support 必须为 [batch, shots, features]。")
        if support.shape[2] != self.support_features:
            raise ValueError(
                f"support 特征数必须为 {self.support_features}。"
            )
        if support_mask is None:
            support_mask = torch.ones(
                support.shape[:2],
                dtype=torch.bool,
                device=support.device,
            )
        if support_mask.shape != support.shape[:2]:
            raise ValueError("support_mask 必须为 [batch, shots]。")

        encoded = self.support_encoder(support)
        weights = support_mask.to(encoded.dtype).unsqueeze(-1)
        pooled = (encoded * weights).sum(dim=1) / weights.sum(
            dim=1
        ).clamp_min(1.0)

        if physical_prompt is None:
            physical_prompt = temporal.new_zeros(
                batch,
                self.prompt_features,
            )
        if physical_prompt.shape != (batch, self.prompt_features):
            raise ValueError(
                "physical_prompt 必须为 "
                f"[batch, {self.prompt_features}]。"
            )
        prompt = self.prompt_encoder(physical_prompt)
        scale, shift = self.film(torch.cat((pooled, prompt), dim=-1)).chunk(
            2,
            dim=-1,
        )
        strength = torch.sigmoid(self.gate)
        has_support = support_mask.any(dim=1).to(temporal.dtype)
        sample_strength = strength * has_support
        adapted = temporal * (
            1.0
            + sample_strength[:, None, None]
            * 0.10
            * torch.tanh(scale).unsqueeze(1)
        ) + (
            sample_strength[:, None, None]
            * 0.10
            * torch.tanh(shift).unsqueeze(1)
        )
        residual_values = support[:, :, -3:]
        residual_weights = weights
        if self.robust_support:
            # `make_support_batch` orders candidates by query similarity.
            # Extra shots are admitted only when their voltage residual agrees
            # with that nearest causal anchor. This makes K dynamic: more
            # observations add evidence, but cannot overturn the best-matched
            # support with a protocol-mismatched or saturated residual.
            voltage = residual_values[:, :, 0]
            anchor = voltage[:, :1]
            sign_consistent = (
                (voltage * anchor >= 0.0)
                | (voltage.abs() <= 0.15)
                | (anchor.abs() <= 0.15)
            )
            magnitude_consistent = (voltage - anchor).abs() <= 0.50
            reliable = (
                sign_consistent & magnitude_consistent & support_mask
            )
            reliable[:, 0] = support_mask[:, 0]
            residual_weights = reliable.unsqueeze(-1).to(weights.dtype)
        support_residual = (
            residual_values * residual_weights
        ).sum(dim=1) / residual_weights.sum(dim=1).clamp_min(1.0)
        # Robust bounded corrections prevent one atypical support trajectory
        # from shifting every query in a new protocol. Near zero this preserves
        # the original residual scale; large residuals saturate safely.
        bounded_residual = torch.tanh(support_residual)
        calibration_scale = support_residual.new_tensor((0.03, 0.02, 2.0))
        calibration = (
            torch.tanh(self.calibration_gate)
            * bounded_residual
            * calibration_scale
            * has_support[:, None]
        )
        return adapted, strength, calibration


def build_protocol_context(
    current_c_rate: Tensor,
    temperature_c: Tensor,
    initial_soc: Tensor,
    duration_hours: Tensor,
    capacity_ratio: Tensor,
    sensor_mask: Tensor | None = None,
) -> Tensor:
    """Summarise a planned/observed protocol without using target voltage."""

    if current_c_rate.ndim != 2 or temperature_c.shape != current_c_rate.shape:
        raise ValueError("工况上下文要求同形的 [batch, time] 电流与温度。")
    ramp = torch.zeros_like(current_c_rate)
    ramp[:, 1:] = current_c_rate[:, 1:] - current_c_rate[:, :-1]
    if sensor_mask is None:
        observed_fraction = torch.ones_like(initial_soc)
    else:
        observed_fraction = sensor_mask.float().mean(dim=(1, 2))
    return torch.stack(
        (
            current_c_rate.mean(dim=1).clamp(-5.0, 5.0) / 5.0,
            current_c_rate.abs().mean(dim=1).clamp(max=5.0) / 5.0,
            current_c_rate.square().mean(dim=1).sqrt().clamp(max=5.0) / 5.0,
            current_c_rate.abs().amax(dim=1).clamp(max=5.0) / 5.0,
            ramp.abs().mean(dim=1).clamp(max=5.0) / 5.0,
            (current_c_rate.abs() < 0.03).float().mean(dim=1),
            (
                current_c_rate.abs().mean(dim=1)
                * duration_hours
                / 0.5
            ).clamp(max=4.0),
            ((temperature_c.mean(dim=1) - 25.0) / 25.0).clamp(-2.0, 2.0),
            (temperature_c.std(dim=1) / 15.0).clamp(max=2.0),
            initial_soc.clamp(0.0, 1.0),
            (duration_hours / 0.5).clamp(max=4.0),
            capacity_ratio.clamp(0.5, 1.05) * observed_fraction,
        ),
        dim=-1,
    )


def optimize_test_time_context(
    objective: Callable[[Tensor, Tensor], Tensor],
    *,
    batch_size: int,
    prompt_features: int,
    protocol_features: int,
    device: torch.device,
    dtype: torch.dtype,
    steps: int = 30,
    learning_rate: float = 0.03,
    max_delta: float = 0.25,
) -> TestTimeOptimizationResult:
    """Optimize per-cell context only; model weights remain untouched."""

    if steps < 1:
        raise ValueError("TTO steps 必须至少为 1。")
    prompt_delta = torch.zeros(
        batch_size,
        prompt_features,
        device=device,
        dtype=dtype,
        requires_grad=True,
    )
    protocol_delta = torch.zeros(
        batch_size,
        protocol_features,
        device=device,
        dtype=dtype,
        requires_grad=True,
    )
    optimizer = torch.optim.Adam(
        (prompt_delta, protocol_delta),
        lr=learning_rate,
    )
    history: list[float] = []
    best_loss = float("inf")
    best_prompt = torch.zeros_like(prompt_delta)
    best_protocol = torch.zeros_like(protocol_delta)
    for _ in range(steps):
        optimizer.zero_grad(set_to_none=True)
        bounded_prompt = max_delta * torch.tanh(prompt_delta)
        bounded_protocol = max_delta * torch.tanh(protocol_delta)
        loss = objective(bounded_prompt, bounded_protocol)
        regularization = 1e-3 * (
            bounded_prompt.square().mean()
            + bounded_protocol.square().mean()
        )
        detached_loss = float(loss.detach().cpu())
        if detached_loss < best_loss:
            best_loss = detached_loss
            best_prompt = bounded_prompt.detach().clone()
            best_protocol = bounded_protocol.detach().clone()
        (loss + regularization).backward()
        optimizer.step()
        history.append(detached_loss)
    # Return the best support-set state, never merely the last Adam iterate.
    # This makes TTO a safe optional calibration: its own support objective
    # cannot be worse than the unadapted context.
    history.append(best_loss)
    return TestTimeOptimizationResult(
        physical_prompt_delta=best_prompt,
        protocol_context_delta=best_protocol,
        loss_history=tuple(history),
        optimized_parameter_count=(
            batch_size * (prompt_features + protocol_features)
        ),
    )


def corrupt_sensor_channels(
    current_c_rate: Tensor,
    temperature_c: Tensor,
    *,
    current_drop_probability: float = 0.05,
    temperature_drop_probability: float = 0.25,
    contiguous_probability: float = 0.35,
    generator: torch.Generator | None = None,
) -> SensorCorruption:
    """Create finite masked inputs for sensor-robust supervised training."""

    if current_c_rate.shape != temperature_c.shape:
        raise ValueError("电流与温度轨迹形状必须一致。")
    if current_c_rate.ndim != 2:
        raise ValueError("传感器轨迹必须为 [batch, time]。")
    batch, steps = current_c_rate.shape
    device = current_c_rate.device

    def uniform(shape: tuple[int, ...]) -> Tensor:
        return torch.rand(shape, generator=generator, device=device)

    current_observed = uniform((batch, steps)) >= current_drop_probability
    temperature_observed = (
        uniform((batch, steps)) >= temperature_drop_probability
    )
    if steps >= 4 and contiguous_probability > 0:
        for row in range(batch):
            if float(uniform((1,)).item()) >= contiguous_probability:
                continue
            width = max(1, steps // 5)
            start = int(
                torch.randint(
                    0,
                    steps - width + 1,
                    (1,),
                    generator=generator,
                    device=device,
                ).item()
            )
            if float(uniform((1,)).item()) < 0.75:
                temperature_observed[row, start:start + width] = False
            else:
                current_observed[row, start:start + width] = False

    def interpolate_missing(
        values: Tensor,
        observed_mask: Tensor,
        fallback: float,
    ) -> Tensor:
        result = values.clone()
        positions_index = torch.arange(
            steps,
            device=device,
            dtype=torch.long,
        )
        positions = positions_index.to(values.dtype)
        for row in range(batch):
            observed_positions = torch.nonzero(
                observed_mask[row],
                as_tuple=False,
            ).flatten()
            if observed_positions.numel() == 0:
                result[row].fill_(fallback)
                continue
            observed_values = values[row, observed_positions]
            insertion = torch.searchsorted(
                observed_positions,
                positions_index,
            )
            left_index = (insertion - 1).clamp(
                0,
                observed_positions.numel() - 1,
            )
            right_index = insertion.clamp(
                0,
                observed_positions.numel() - 1,
            )
            left_position = observed_positions[left_index].to(values.dtype)
            right_position = observed_positions[right_index].to(values.dtype)
            denominator = (right_position - left_position).clamp_min(1.0)
            fraction = (positions - left_position) / denominator
            interpolated = (
                observed_values[left_index]
                + fraction
                * (observed_values[right_index] - observed_values[left_index])
            )
            result[row] = torch.where(
                observed_mask[row],
                values[row],
                interpolated,
            )
        return result

    current = interpolate_missing(
        current_c_rate,
        current_observed,
        0.0,
    )
    temperature = interpolate_missing(
        temperature_c,
        temperature_observed,
        25.0,
    )
    observed = torch.stack(
        (current_observed, temperature_observed),
        dim=-1,
    )
    return SensorCorruption(current, temperature, observed)


def summarise_support_trajectories(
    current_c_rate: Tensor,
    temperature_c: Tensor,
    voltage_v: Tensor,
    initial_soc: Tensor,
    duration_hours: Tensor,
    capacity_ratio: Tensor,
    observed_soc: Tensor | None = None,
    predicted_voltage_v: Tensor | None = None,
    predicted_soc: Tensor | None = None,
    predicted_temperature_c: Tensor | None = None,
) -> Tensor:
    """Return causal, observable support features for each trajectory."""

    if current_c_rate.ndim != 2:
        raise ValueError("support 轨迹必须为 [samples, time]。")
    ramp = torch.zeros_like(current_c_rate)
    ramp[:, 1:] = current_c_rate[:, 1:] - current_c_rate[:, :-1]
    base = torch.stack(
        (
            current_c_rate.abs().mean(dim=1).clamp(max=5.0) / 5.0,
            current_c_rate.square().mean(dim=1).sqrt().clamp(max=5.0)
            / 5.0,
            current_c_rate.abs().amax(dim=1).clamp(max=5.0) / 5.0,
            ramp.abs().mean(dim=1).clamp(max=5.0) / 5.0,
            ((temperature_c.mean(dim=1) - 25.0) / 25.0).clamp(-2.0, 2.0),
            (temperature_c.std(dim=1) / 15.0).clamp(max=2.0),
            ((voltage_v.mean(dim=1) - 3.3) / 1.0).clamp(-2.0, 2.0),
            (voltage_v.std(dim=1) / 0.5).clamp(max=2.0),
            ((voltage_v.amax(dim=1) - voltage_v.amin(dim=1)) / 1.5).clamp(
                max=2.0,
            ),
            initial_soc.clamp(0.0, 1.0),
            (duration_hours / 0.5).clamp(max=4.0),
            capacity_ratio.clamp(0.5, 1.05),
        ),
        dim=-1,
    )
    if predicted_voltage_v is None:
        residual = base.new_zeros(base.shape[0], 3)
    else:
        if (
            observed_soc is None
            or predicted_soc is None
            or predicted_temperature_c is None
        ):
            raise ValueError("支持集残差特征必须同时提供 V/SOC/T 预测。")
        residual = torch.stack(
            (
                ((voltage_v - predicted_voltage_v).mean(dim=1) / 0.10).clamp(
                    -3.0,
                    3.0,
                ),
                ((observed_soc - predicted_soc).mean(dim=1) / 0.05).clamp(
                    -3.0,
                    3.0,
                ),
                (
                    (temperature_c - predicted_temperature_c).mean(dim=1)
                    / 5.0
                ).clamp(-3.0, 3.0),
            ),
            dim=-1,
        )
    return torch.cat((base, residual), dim=-1)


def build_query_physical_prompt(
    current_c_rate: Tensor,
    temperature_c: Tensor,
    initial_soc: Tensor,
    duration_hours: Tensor,
    capacity_ratio: Tensor,
    sensor_mask: Tensor | None,
) -> Tensor:
    """Build the phase-one operating/health prompt without target leakage."""

    ramp = torch.zeros_like(current_c_rate)
    ramp[:, 1:] = current_c_rate[:, 1:] - current_c_rate[:, :-1]
    if sensor_mask is None:
        observed_fraction = torch.ones_like(initial_soc)
    else:
        observed_fraction = sensor_mask.float().mean(dim=(1, 2))
    return torch.stack(
        (
            current_c_rate.abs().mean(dim=1).clamp(max=5.0) / 5.0,
            current_c_rate.square().mean(dim=1).sqrt().clamp(max=5.0)
            / 5.0,
            ramp.abs().mean(dim=1).clamp(max=5.0) / 5.0,
            ((temperature_c.mean(dim=1) - 25.0) / 25.0).clamp(-2.0, 2.0),
            initial_soc.clamp(0.0, 1.0),
            (duration_hours / 0.5).clamp(max=4.0),
            capacity_ratio.clamp(0.5, 1.05),
            observed_fraction,
        ),
        dim=-1,
    )


class TransferDomainReference:
    """Robust feature reference used to detect out-of-domain conditions."""

    def __init__(self, centre: Tensor, scale: Tensor) -> None:
        self.centre = centre
        self.scale = scale.clamp_min(1e-4)

    @classmethod
    def fit(cls, features: Tensor) -> "TransferDomainReference":
        if features.ndim != 2 or features.shape[0] < 2:
            raise ValueError("域参考至少需要两个二维特征样本。")
        centre = features.median(dim=0).values
        mad = (features - centre).abs().median(dim=0).values
        return cls(centre, 1.4826 * mad + 1e-4)

    def distance(self, features: Tensor) -> Tensor:
        centre = self.centre.to(features)
        scale = self.scale.to(features)
        z_score = (features - centre).abs() / scale
        used = min(3, z_score.shape[1])
        return z_score.topk(used, dim=1).values.mean(dim=1)

    def state_dict(self) -> dict[str, Tensor]:
        return {
            "centre": self.centre.detach().cpu(),
            "scale": self.scale.detach().cpu(),
        }


class TransferRiskRouter:
    """Interpretable direct → Few-shot → PINO → solver policy."""

    def __init__(
        self,
        *,
        direct_threshold: float = 0.70,
        few_shot_threshold: float = 1.10,
        pino_threshold: float = 1.70,
    ) -> None:
        if not (
            0.0 < direct_threshold < few_shot_threshold < pino_threshold
        ):
            raise ValueError("迁移风险阈值必须严格递增。")
        self.thresholds = (
            direct_threshold,
            few_shot_threshold,
            pino_threshold,
        )

    def decide(
        self,
        *,
        physics_residual: Tensor,
        domain_distance: Tensor,
        expert_disagreement: Tensor,
        uncertainty: Tensor,
        observed_fraction: Tensor,
        support_shots: Tensor,
    ) -> TransferRiskDecision:
        values = (
            physics_residual,
            domain_distance,
            expert_disagreement,
            uncertainty,
            observed_fraction,
            support_shots,
        )
        if any(value.ndim != 1 for value in values):
            raise ValueError("迁移风险输入必须为一维 batch 张量。")
        if len({value.shape[0] for value in values}) != 1:
            raise ValueError("迁移风险输入 batch 大小不一致。")
        score = (
            0.30 * physics_residual.clamp_min(0.0)
            + 0.30 * domain_distance.clamp_min(0.0)
            + 0.20 * expert_disagreement.clamp_min(0.0)
            + 0.10 * uncertainty.clamp_min(0.0)
            + 0.10 * (1.0 - observed_fraction.clamp(0.0, 1.0)) * 2.0
        )
        score = score - 0.08 * support_shots.clamp(0.0, 5.0).sqrt()
        action = torch.zeros_like(score, dtype=torch.long)
        action[score >= self.thresholds[0]] = 1
        action[score >= self.thresholds[1]] = 2
        action[score >= self.thresholds[2]] = 3
        return TransferRiskDecision(score=score, action_index=action)


def condition_labels(
    current_c_rate: Tensor,
    temperature_c: Tensor,
) -> list[str]:
    """Assign deterministic held-out strata from observable inputs."""

    peak = current_c_rate.abs().amax(dim=1)
    temperature = temperature_c.mean(dim=1)
    ramp = (
        current_c_rate[:, 1:] - current_c_rate[:, :-1]
    ).abs().mean(dim=1)
    labels = []
    for rate, temp, dynamic in zip(peak, temperature, ramp):
        rate_label = (
            "low-rate"
            if float(rate) < 1.0
            else "mid-rate"
            if float(rate) < 2.0
            else "high-rate"
        )
        temperature_label = (
            "cold"
            if float(temp) < 20.0
            else "warm"
            if float(temp) > 30.0
            else "nominal"
        )
        profile_label = "dynamic" if float(dynamic) > 0.15 else "smooth"
        labels.append(
            f"{temperature_label}/{rate_label}/{profile_label}"
        )
    return labels


def cell_ids_from_groups(group_ids: Iterable[str]) -> list[str]:
    return [value.split(":cycle-", 1)[0] for value in group_ids]


def protocol_label_from_cell(cell_id: str) -> str:
    upper = cell_id.upper()
    if "DRIVING" in upper:
        return "driving"
    if "_MP_" in upper or "-MP-" in upper:
        return "multi-pulse"
    if "CCCV" in upper:
        return "constant-current"
    return "unspecified"


def validate_shot_count(shots: int) -> Literal[0, 1, 3, 5]:
    if shots not in {0, 1, 3, 5}:
        raise ValueError("Few-shot 仅支持 K=0/1/3/5。")
    return shots  # type: ignore[return-value]
