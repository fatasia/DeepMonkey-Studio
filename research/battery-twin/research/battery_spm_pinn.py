"""Learnable single-particle physics expert for BatteryMFormer PINN candidates.

The neural network identifies cell-specific physical parameters and latent
particle concentration fields from measured voltage/current/SOC curves.  The
fields are constrained by a conservative spherical diffusion residual, voltage
observation equation, lithium inventory, energy dissipation, and a learnable
capacity-fade ODE.  Production BatteryMFormer checkpoints do not instantiate
this module unless ``enable_spm_pinn`` is explicitly enabled.
"""
from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import Tensor, nn
import torch.nn.functional as F

from research.spm_physics import (
    radial_grid,
    radial_volume_average,
    spm_physics_losses,
)


@dataclass(frozen=True)
class BatterySPMPINNLossWeights:
    pde: float = 1.0
    boundary: float = 1.0
    conservation: float = 1.0
    initial: float = 0.5
    soc_observation: float = 2.0
    lithium_inventory: float = 1.0
    voltage_observation: float = 1.0
    energy_efficiency: float = 0.5
    dissipation: float = 0.25
    aging_ode: float = 1.0
    physical_trajectory: float = 0.25
    stoichiometry_window: float = 0.1
    ocv_anchor: float = 0.5
    parameter_prior: float = 0.25
    physical_observation: float = 1.0


@dataclass(frozen=True)
class GradientConflictDiagnostics:
    """Conflict signal between data and physics objectives on shared parameters."""

    cosine: float
    multiplier: float
    data_gradient_norm: float
    physics_gradient_norm: float


def gradient_conflict_diagnostics(
    data_loss: Tensor,
    physics_loss: Tensor,
    parameters: list[nn.Parameter],
    *,
    minimum_multiplier: float = 0.15,
    epsilon: float = 1e-12,
) -> GradientConflictDiagnostics:
    """Measure gradient conflict and conservatively attenuate physics pressure.

    The controller only considers parameters reached by both objectives.  An
    aligned or orthogonal physics gradient retains its full weight; a directly
    opposing gradient is reduced to ``minimum_multiplier``.  The diagnostic is
    detached from the training graph so the model cannot game the controller.
    """

    if not 0.0 <= minimum_multiplier <= 1.0:
        raise ValueError("minimum_multiplier 必须位于 [0, 1]。")
    shared = [parameter for parameter in parameters if parameter.requires_grad]
    if not shared:
        return GradientConflictDiagnostics(0.0, 1.0, 0.0, 0.0)

    data_gradients = torch.autograd.grad(
        data_loss,
        shared,
        retain_graph=True,
        allow_unused=True,
    )
    physics_gradients = torch.autograd.grad(
        physics_loss,
        shared,
        retain_graph=True,
        allow_unused=True,
    )
    dot = data_loss.new_zeros(())
    data_norm_sq = data_loss.new_zeros(())
    physics_norm_sq = data_loss.new_zeros(())
    overlap = False
    for data_gradient, physics_gradient in zip(
        data_gradients,
        physics_gradients,
        strict=True,
    ):
        if data_gradient is None or physics_gradient is None:
            continue
        overlap = True
        data_flat = data_gradient.detach().float().reshape(-1)
        physics_flat = physics_gradient.detach().float().reshape(-1)
        dot = dot + torch.dot(data_flat, physics_flat)
        data_norm_sq = data_norm_sq + torch.dot(data_flat, data_flat)
        physics_norm_sq = physics_norm_sq + torch.dot(
            physics_flat,
            physics_flat,
        )

    data_norm = data_norm_sq.sqrt()
    physics_norm = physics_norm_sq.sqrt()
    if (
        not overlap
        or data_norm.item() <= epsilon
        or physics_norm.item() <= epsilon
    ):
        return GradientConflictDiagnostics(
            cosine=0.0,
            multiplier=1.0,
            data_gradient_norm=float(data_norm.item()),
            physics_gradient_norm=float(physics_norm.item()),
        )

    cosine = (dot / (data_norm * physics_norm).clamp_min(epsilon)).clamp(
        -1.0,
        1.0,
    )
    conflict = max(0.0, -float(cosine.item()))
    multiplier = 1.0 - conflict * (1.0 - minimum_multiplier)
    return GradientConflictDiagnostics(
        cosine=float(cosine.item()),
        multiplier=multiplier,
        data_gradient_norm=float(data_norm.item()),
        physics_gradient_norm=float(physics_norm.item()),
    )


def _last_physical_cycle(
    curves: Tensor,
    curve_mask: Tensor,
) -> tuple[Tensor, Tensor]:
    """Gather the last valid cycle containing a non-zero current curve."""

    if curves.ndim != 4 or curves.shape[2] < 4:
        raise ValueError("curves 必须为 [batch, cycle, >=4, point]。")
    if curve_mask.shape != curves.shape[:2]:
        raise ValueError("curve_mask 必须与 curves 的 batch/cycle 对齐。")
    current_activity = curves[:, :, 1, :].abs().mean(dim=-1) > 1e-5
    physical_mask = (curve_mask > 0) & current_activity
    fallback_mask = curve_mask > 0
    indices = torch.arange(
        curves.shape[1],
        device=curves.device,
    ).reshape(1, -1)
    physical_index = torch.where(
        physical_mask,
        indices,
        torch.zeros_like(indices),
    ).amax(dim=1)
    fallback_index = torch.where(
        fallback_mask,
        indices,
        torch.zeros_like(indices),
    ).amax(dim=1)
    has_physical = physical_mask.any(dim=1)
    selected_index = torch.where(has_physical, physical_index, fallback_index)
    batch_index = torch.arange(curves.shape[0], device=curves.device)
    return curves[batch_index, selected_index], selected_index


def _gather_cycle_feature(
    features: Tensor,
    selected_index: Tensor,
) -> Tensor:
    batch_index = torch.arange(features.shape[0], device=features.device)
    return features[batch_index, selected_index]


class BatterySPMPINNHead(nn.Module):
    """Infer physical fields/parameters and a capacity-fade ODE from a cell embedding."""

    def __init__(
        self,
        embedding_dim: int,
        prediction_length: int,
        *,
        radial_points: int = 10,
        collocation_steps: int = 48,
        hidden_dim: int = 64,
        condition_dim: int = 11,
    ) -> None:
        super().__init__()
        if radial_points < 4:
            raise ValueError("radial_points 必须至少为 4。")
        if collocation_steps < 8:
            raise ValueError("collocation_steps 必须至少为 8。")
        self.prediction_length = int(prediction_length)
        self.radial_points = int(radial_points)
        self.collocation_steps = int(collocation_steps)
        self.condition_dim = int(condition_dim)
        self.condition_encoder = nn.Sequential(
            nn.Linear(self.condition_dim, hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, embedding_dim),
        )
        nn.init.zeros_(self.condition_encoder[-1].weight)
        nn.init.zeros_(self.condition_encoder[-1].bias)
        self.observation_encoder = nn.Sequential(
            nn.Linear(20, hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, embedding_dim),
        )
        nn.init.zeros_(self.observation_encoder[-1].weight)
        nn.init.zeros_(self.observation_encoder[-1].bias)
        self.curve_encoder = nn.Sequential(
            nn.Conv1d(4, 16, kernel_size=5, padding=2),
            nn.SiLU(),
            nn.Conv1d(16, 32, kernel_size=5, padding=2),
            nn.SiLU(),
            nn.AdaptiveAvgPool1d(4),
            nn.Flatten(),
            nn.Linear(128, embedding_dim),
        )
        nn.init.zeros_(self.curve_encoder[-1].weight)
        nn.init.zeros_(self.curve_encoder[-1].bias)
        self.condition_norm = nn.LayerNorm(embedding_dim)
        self.context_projection = nn.Sequential(
            nn.Linear(embedding_dim, hidden_dim),
            nn.SiLU(),
            nn.LayerNorm(hidden_dim),
        )
        # context + time + radius + particle id + current + voltage + SOC
        # + capacity coordinate
        self.field_decoder = nn.Sequential(
            nn.Linear(hidden_dim + 7, hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, 1),
        )
        # 2 D + 2 flux + R + i0 + eta + OCV min/span/3 coefficients
        # + fade base/knee/location/width/gate + 3 non-negative stress weights
        self.parameter_head = nn.Linear(embedding_dim, 20)
        nn.init.zeros_(self.parameter_head.weight)
        nn.init.zeros_(self.parameter_head.bias)
        # Start as a small correction to a warm-started data expert.
        self.parameter_head.bias.data[16] = -4.0
        # Empirical-Bayes initialization from the training split's median
        # early-cycle fade.  LFP has only two cells, so this remains learnable
        # and is reported as a low-support prior rather than a universal law.
        self.chemistry_fade_log_scale = nn.Parameter(
            torch.log(
                torch.tensor((0.25, 1.0, 1.0, 1.0, 1.0, 0.70))
            )
        )
        # Bridges short-horizon electrochemical state into long-horizon
        # degradation parameters.  Zero initialization preserves the base
        # candidate until evidence is learned.
        self.degradation_bridge = nn.Sequential(
            nn.Linear(embedding_dim + 8, hidden_dim),
            nn.SiLU(),
            nn.Linear(hidden_dim, 4),
        )
        nn.init.zeros_(self.degradation_bridge[-1].weight)
        nn.init.zeros_(self.degradation_bridge[-1].bias)

    def _condition_embedding(
        self,
        embedding: Tensor,
        physics_condition: Tensor | None,
        observation_summary: Tensor,
        curve_embedding: Tensor,
    ) -> tuple[Tensor, Tensor]:
        if physics_condition is None:
            physics_condition = embedding.new_zeros(
                embedding.shape[0],
                self.condition_dim,
            )
        if physics_condition.shape != (embedding.shape[0], self.condition_dim):
            raise ValueError(
                "physics_condition 必须为 "
                f"[batch, {self.condition_dim}]。"
            )
        conditioned = self.condition_norm(
            embedding
            + self.condition_encoder(physics_condition.to(embedding.dtype))
            + self.observation_encoder(observation_summary.to(embedding.dtype))
            + curve_embedding.to(embedding.dtype)
        )
        return conditioned, physics_condition.to(embedding.dtype)

    @staticmethod
    def _observation_summary(selected_curve: Tensor) -> Tensor:
        voltage = selected_curve[:, 0] / 5.0
        current = selected_curve[:, 1] / 5.0
        capacity = selected_curve[:, 2] / 100.0
        soc = selected_curve[:, 3]

        def moments(value: Tensor) -> tuple[Tensor, Tensor, Tensor, Tensor]:
            return (
                value.mean(dim=1),
                value.std(dim=1, unbiased=False),
                value.amin(dim=1),
                value.amax(dim=1),
            )

        voltage_stats = moments(voltage)
        current_stats = (
            current.mean(dim=1),
            current.std(dim=1, unbiased=False),
            current.abs().mean(dim=1),
            current.abs().amax(dim=1),
        )
        soc_stats = moments(soc)
        capacity_stats = (
            capacity.mean(dim=1),
            capacity.std(dim=1, unbiased=False),
            capacity.amax(dim=1),
            capacity.amax(dim=1) - capacity.amin(dim=1),
        )
        centered_voltage = voltage - voltage.mean(dim=1, keepdim=True)
        centered_current = current - current.mean(dim=1, keepdim=True)
        covariance = (centered_voltage * centered_current).mean(dim=1)
        current_variance = centered_current.square().mean(dim=1).clamp_min(1e-6)
        voltage_current_slope = (covariance / current_variance).clamp(-5.0, 5.0)
        correlation = covariance / (
            centered_voltage.square().mean(dim=1).sqrt()
            * current_variance.sqrt()
        ).clamp_min(1e-6)
        charge_mask = current > 0.01
        discharge_mask = current < -0.01
        charge_voltage = (
            (voltage * charge_mask).sum(dim=1)
            / charge_mask.sum(dim=1).clamp_min(1)
        )
        discharge_voltage = (
            (voltage * discharge_mask).sum(dim=1)
            / discharge_mask.sum(dim=1).clamp_min(1)
        )
        hysteresis = charge_voltage - discharge_voltage
        positive_fraction = charge_mask.to(voltage.dtype).mean(dim=1)
        return torch.stack(
            (
                *voltage_stats,
                *current_stats,
                *soc_stats,
                *capacity_stats,
                correlation.clamp(-1.0, 1.0),
                voltage_current_slope,
                hysteresis.clamp(-1.0, 1.0),
                positive_fraction,
            ),
            dim=-1,
        )

    def _physical_parameters(self, embedding: Tensor) -> dict[str, Tensor]:
        raw = self.parameter_head(embedding)
        sigmoid = torch.sigmoid
        return {
            "diffusivity": 1e-4 + 0.08 * sigmoid(raw[:, 0:2]),
            "flux_scale": 5e-4 + 0.03 * sigmoid(raw[:, 2:4]),
            "resistance_v_per_c": 0.001 + 0.35 * sigmoid(raw[:, 4]),
            "exchange_c_rate": 0.05 + 1.95 * sigmoid(raw[:, 5]),
            "overpotential_scale_v": 0.001 + 0.25 * sigmoid(raw[:, 6]),
            "ocv_min_v": 2.2 + 1.2 * sigmoid(raw[:, 7]),
            "ocv_span_v": 0.3 + 1.8 * sigmoid(raw[:, 8]),
            "ocv_coefficients": torch.softmax(raw[:, 9:12], dim=-1),
            "base_fade_rate": 1e-5 + 1.5e-3 * sigmoid(raw[:, 12]),
            "knee_strength": 0.5 + 5.0 * sigmoid(raw[:, 13]),
            "knee_location": 0.4 + 0.5 * sigmoid(raw[:, 14]),
            "knee_width": 0.03 + 0.17 * sigmoid(raw[:, 15]),
            "physics_gate": 0.5 * sigmoid(raw[:, 16]),
            "stress_weights": 2e-3 * sigmoid(raw[:, 17:20]),
        }

    def forward(
        self,
        embedding: Tensor,
        curves: Tensor,
        curve_mask: Tensor,
        cycle_features: Tensor,
        soh_input: Tensor,
        physics_condition: Tensor | None = None,
    ) -> dict[str, Tensor]:
        selected_curve, selected_index = _last_physical_cycle(curves, curve_mask)
        selected_features = _gather_cycle_feature(
            cycle_features,
            selected_index,
        )
        curve_points = selected_curve.shape[-1]
        if self.collocation_steps > curve_points:
            raise ValueError("collocation_steps 不能超过每循环曲线长度。")
        sample_index = torch.linspace(
            0,
            curve_points - 1,
            self.collocation_steps,
            device=curves.device,
        ).round().long()
        measured_voltage = selected_curve[:, 0, sample_index].clamp(1.0, 6.0)
        current_c_rate = selected_curve[:, 1, sample_index].clamp(-5.0, 5.0)
        capacity_coordinate = selected_curve[:, 2, sample_index]
        soc = selected_curve[:, 3, sample_index].clamp(1e-4, 1.0 - 1e-4)

        delta_soc = torch.diff(soc, dim=1).abs()
        midpoint_current = 0.5 * (
            current_c_rate[:, 1:].abs() + current_c_rate[:, :-1].abs()
        )
        delta_time_tail = delta_soc / midpoint_current.clamp_min(0.02)
        first_delta_time = delta_time_tail[:, :1].clamp_min(1e-4)
        delta_time = torch.cat((first_delta_time, delta_time_tail), dim=1)

        observation_summary = self._observation_summary(selected_curve)
        normalized_curve = torch.stack(
            (
                selected_curve[:, 0] / 5.0,
                selected_curve[:, 1] / 5.0,
                selected_curve[:, 2] / 100.0,
                selected_curve[:, 3],
            ),
            dim=1,
        )
        curve_embedding = self.curve_encoder(normalized_curve)
        conditioned_embedding, physics_condition = self._condition_embedding(
            embedding,
            physics_condition,
            observation_summary,
            curve_embedding,
        )
        parameters = self._physical_parameters(conditioned_embedding)
        context = self.context_projection(conditioned_embedding)
        _, radial_centers, _ = radial_grid(
            self.radial_points,
            device=curves.device,
            dtype=curves.dtype,
        )
        time_coordinate = torch.linspace(
            0.0,
            1.0,
            self.collocation_steps,
            device=curves.device,
            dtype=curves.dtype,
        )
        particle_id = torch.tensor(
            (-1.0, 1.0),
            device=curves.device,
            dtype=curves.dtype,
        )
        batch = curves.shape[0]
        target_shape = (
            batch,
            self.collocation_steps,
            self.radial_points,
            2,
        )

        def expand_context(value: Tensor) -> Tensor:
            return value[:, None, None, None, :].expand(*target_shape, value.shape[-1])

        def expand_observation(value: Tensor) -> Tensor:
            return value[:, :, None, None, None].expand(*target_shape, 1)

        field_features = torch.cat(
            (
                expand_context(context),
                time_coordinate[None, :, None, None, None].expand(*target_shape, 1),
                radial_centers[None, None, :, None, None].expand(*target_shape, 1),
                particle_id[None, None, None, :, None].expand(*target_shape, 1),
                expand_observation(current_c_rate),
                expand_observation(measured_voltage / 5.0),
                expand_observation(soc),
                expand_observation(torch.tanh(capacity_coordinate / 100.0)),
            ),
            dim=-1,
        )
        correction = self.field_decoder(field_features).squeeze(-1)
        average_target = torch.stack((soc, 1.0 - soc), dim=-1)
        base_logit = torch.logit(average_target.clamp(1e-4, 1.0 - 1e-4))
        concentration = torch.sigmoid(
            base_logit[:, :, None, :] + 0.35 * correction
        )

        ocv_coefficients = parameters["ocv_coefficients"]
        ocv_shape = (
            ocv_coefficients[:, 0, None] * soc
            + ocv_coefficients[:, 1, None] * soc.square()
            + ocv_coefficients[:, 2, None] * soc.pow(3)
        )
        ocv = (
            parameters["ocv_min_v"][:, None]
            + parameters["ocv_span_v"][:, None] * ocv_shape
        )
        overpotential = parameters["overpotential_scale_v"][:, None] * torch.asinh(
            current_c_rate / parameters["exchange_c_rate"][:, None]
        )
        predicted_voltage = (
            ocv
            + current_c_rate * parameters["resistance_v_per_c"][:, None]
            + overpotential
        )

        coulombic_efficiency = selected_features[:, 0].clamp(0.0, 1.05)
        energy_efficiency = selected_features[:, 1].clamp(0.0, 1.05)
        mean_c_rate = current_c_rate.abs().mean(dim=1)
        stress = torch.stack(
            (
                (1.0 - coulombic_efficiency).clamp_min(0.0),
                (1.0 - energy_efficiency).clamp_min(0.0),
                mean_c_rate,
            ),
            dim=-1,
        )
        degradation_rate = (
            parameters["base_fade_rate"]
            + (parameters["stress_weights"] * stress).sum(dim=-1)
        )
        chemistry_fade_scale = torch.exp(
            (
                physics_condition[:, :6]
                * self.chemistry_fade_log_scale[None, :]
            ).sum(dim=-1)
        ).clamp(0.15, 2.0)
        degradation_rate = degradation_rate * chemistry_fade_scale
        bridge_features = torch.cat(
            (
                conditioned_embedding,
                stress,
                parameters["diffusivity"].mean(dim=-1, keepdim=True),
                parameters["resistance_v_per_c"].unsqueeze(-1),
                parameters["overpotential_scale_v"].unsqueeze(-1),
                parameters["exchange_c_rate"].unsqueeze(-1),
                physics_condition[:, 6:7],
            ),
            dim=-1,
        )
        bridge = torch.tanh(self.degradation_bridge(bridge_features))
        degradation_rate = degradation_rate * torch.exp(0.5 * bridge[:, 0])
        knee_strength = parameters["knee_strength"] * torch.exp(
            0.5 * bridge[:, 1]
        )
        knee_location = (
            parameters["knee_location"] + 0.10 * bridge[:, 2]
        ).clamp(0.35, 0.95)
        knee_width = (
            parameters["knee_width"] * torch.exp(0.4 * bridge[:, 3])
        ).clamp(0.02, 0.25)
        cycle_fraction = torch.linspace(
            0.0,
            1.0,
            self.prediction_length,
            device=curves.device,
            dtype=curves.dtype,
        )
        knee_activation = torch.sigmoid(
            (
                cycle_fraction[None, :]
                - knee_location[:, None]
            )
            / knee_width[:, None]
        )
        rate_profile = degradation_rate[:, None] * (
            1.0 + knee_strength[:, None] * knee_activation
        )
        initial_soh = soh_input[:, 0, 0]
        physical_soh = initial_soh[:, None] - torch.cumsum(rate_profile, dim=1)
        observed_length = min(soh_input.shape[1], self.prediction_length)
        observed_mask = curve_mask[:, :observed_length].to(curves.dtype)
        physical_observation_error = (
            (
                physical_soh[:, :observed_length]
                - soh_input[:, :observed_length, 0]
            ).square()
            * observed_mask
        ).sum(dim=1) / observed_mask.sum(dim=1).clamp_min(1.0)
        physical_observation_rmse = physical_observation_error.sqrt()
        physical_fit_score = torch.exp(
            -physical_observation_rmse / 0.15
        ).clamp(0.0, 1.0)

        valid_cycle = curve_mask > 0
        per_cycle_rate = curves[:, :, 1, :].abs().mean(dim=-1)
        valid_rate_count = valid_cycle.sum(dim=1).clamp_min(1.0)
        rate_mean = (
            per_cycle_rate * valid_cycle
        ).sum(dim=1) / valid_rate_count
        rate_variance = (
            (per_cycle_rate - rate_mean[:, None]).square() * valid_cycle
        ).sum(dim=1) / valid_rate_count
        rate_excitation = (
            rate_variance.sqrt() / rate_mean.clamp_min(0.05)
        ).clamp(0.0, 1.0)
        soc_coverage = (
            soc.amax(dim=1) - soc.amin(dim=1)
        ).div(0.8).clamp(0.0, 1.0)
        bidirectional = (
            (current_c_rate > 0.05).any(dim=1)
            & (current_c_rate < -0.05).any(dim=1)
        ).to(curves.dtype)
        temperature_known = physics_condition[:, 10]
        identifiability_score = (
            0.35 * rate_excitation
            + 0.35 * soc_coverage
            + 0.20 * bidirectional
            + 0.10 * temperature_known
        ).clamp(0.0, 1.0)
        nominal_capacity_ah = (
            physics_condition[:, 6] * 100.0
        ).clamp_min(0.1)

        return {
            "concentration": concentration,
            "current_c_rate": current_c_rate,
            "delta_time": delta_time,
            "measured_voltage": measured_voltage,
            "predicted_voltage": predicted_voltage,
            "ocv": ocv,
            "soc": soc,
            "initial_concentration": average_target[:, 0, :],
            "coulombic_efficiency": coulombic_efficiency,
            "energy_efficiency": energy_efficiency,
            "rate_profile": rate_profile,
            "physical_soh": physical_soh,
            "physics_gate": parameters["physics_gate"],
            "nominal_capacity_ah": nominal_capacity_ah,
            "equivalent_resistance_ohm": (
                parameters["resistance_v_per_c"] / nominal_capacity_ah
            ),
            "effective_diffusion_time_h": (
                1.0 / parameters["diffusivity"].clamp_min(1e-6)
            ),
            "identifiability_score": identifiability_score,
            "physics_condition": physics_condition,
            "degradation_rate": degradation_rate,
            "chemistry_fade_scale": chemistry_fade_scale,
            "identified_knee_strength": knee_strength,
            "identified_knee_location": knee_location,
            "identified_knee_width": knee_width,
            "physical_observation_rmse": physical_observation_rmse,
            "physical_fit_score": physical_fit_score,
            "heat_generation": (
                current_c_rate.abs() * (predicted_voltage - ocv).abs()
            ),
            **parameters,
        }


def battery_spm_pinn_losses(
    state: dict[str, Tensor],
    predicted_soh: Tensor,
    trajectory_mask: Tensor,
    *,
    weights: BatterySPMPINNLossWeights | None = None,
) -> tuple[Tensor, dict[str, Tensor]]:
    """Return an aggregate learnable electrochemical/aging physics objective."""

    configured = weights or BatterySPMPINNLossWeights()
    spm_losses, _ = spm_physics_losses(
        state["concentration"],
        state["current_c_rate"],
        state["delta_time"],
        state["diffusivity"],
        state["initial_concentration"],
        flux_scale=state["flux_scale"],
    )
    volume_average = radial_volume_average(state["concentration"])
    target_average = torch.stack(
        (state["soc"], 1.0 - state["soc"]),
        dim=-1,
    )
    soc_observation = F.smooth_l1_loss(volume_average, target_average)
    lithium_inventory = (volume_average.sum(dim=-1) - 1.0).square().mean()
    voltage_observation = F.smooth_l1_loss(
        state["predicted_voltage"],
        state["measured_voltage"],
    )
    rest_weight = torch.exp(-state["current_c_rate"].abs() / 0.12)
    ocv_anchor = (
        (state["ocv"] - state["measured_voltage"]).square() * rest_weight
    ).sum() / rest_weight.sum().clamp_min(1e-6)

    chemistry_index = state["physics_condition"][:, :6].argmax(dim=-1)
    diffusivity_priors = state["diffusivity"].new_tensor(
        (0.018, 0.015, 0.016, 0.014, 0.015, 0.015)
    )
    resistance_priors = state["resistance_v_per_c"].new_tensor(
        (0.035, 0.025, 0.024, 0.030, 0.028, 0.030)
    )
    diffusivity_prior = diffusivity_priors[chemistry_index, None].expand_as(
        state["diffusivity"]
    )
    resistance_prior = resistance_priors[chemistry_index]
    prior_strength = (
        1.0 - state["identifiability_score"].detach()
    ).clamp(0.1, 1.0)
    parameter_prior = (
        (
            torch.log(
                state["diffusivity"].clamp_min(1e-6)
                / diffusivity_prior
            ).square().mean(dim=-1)
            + torch.log(
                state["flux_scale"].clamp_min(1e-6) / 0.01
            ).square().mean(dim=-1)
            + torch.log(
                state["resistance_v_per_c"].clamp_min(1e-6)
                / resistance_prior
            ).square()
            + 0.25
            * torch.log(
                state["exchange_c_rate"].clamp_min(1e-6) / 0.8
            ).square()
        )
        * prior_strength
    ).mean()

    charge_mask = (state["current_c_rate"] > 0.01).to(predicted_soh.dtype)
    discharge_mask = (state["current_c_rate"] < -0.01).to(predicted_soh.dtype)
    electrical_power = (
        state["predicted_voltage"]
        * state["current_c_rate"].abs()
        * state["delta_time"]
    )
    charge_energy = (electrical_power * charge_mask).sum(dim=1).clamp_min(1e-6)
    discharge_energy = (electrical_power * discharge_mask).sum(dim=1)
    predicted_energy_efficiency = (discharge_energy / charge_energy).clamp(0.0, 1.2)
    energy_efficiency = F.smooth_l1_loss(
        predicted_energy_efficiency,
        state["energy_efficiency"],
    )
    observed_dissipation = (
        state["current_c_rate"]
        * (state["measured_voltage"] - state["ocv"])
    )
    dissipation = torch.relu(-observed_dissipation).square().mean()

    pair_mask = trajectory_mask[:, 1:] * trajectory_mask[:, :-1]
    predicted_drop = predicted_soh[:, :-1] - predicted_soh[:, 1:]
    aging_ode = (
        (predicted_drop - state["rate_profile"][:, 1:]).square() * pair_mask
    ).sum() / pair_mask.sum().clamp_min(1.0)
    physical_trajectory = (
        (predicted_soh - state["physical_soh"]).square() * trajectory_mask
    ).sum() / trajectory_mask.sum().clamp_min(1.0)
    physical_observation = state["physical_observation_rmse"].square().mean()
    concentration = state["concentration"]
    stoichiometry_window = (
        torch.relu(0.01 - concentration).square()
        + torch.relu(concentration - 0.99).square()
    ).mean()

    terms = {
        **spm_losses,
        "soc_observation": soc_observation,
        "lithium_inventory": lithium_inventory,
        "voltage_observation": voltage_observation,
        "ocv_anchor": ocv_anchor,
        "parameter_prior": parameter_prior,
        "energy_efficiency": energy_efficiency,
        "dissipation": dissipation,
        "aging_ode": aging_ode,
        "physical_trajectory": physical_trajectory,
        "physical_observation": physical_observation,
        "stoichiometry_window": stoichiometry_window,
    }

    def balanced(name: str) -> Tensor:
        # Unit systems differ sharply (volts, stoichiometry, dimensionless
        # diffusion). Detaching the current scale gives every mechanism a
        # comparable gradient budget without letting the model game its weight.
        reference = terms[name].detach().abs().clamp(1e-6, 1e6)
        return terms[name] / reference

    total = (
        configured.pde * balanced("pde")
        + configured.boundary * balanced("boundary")
        + configured.conservation * balanced("conservation")
        + configured.initial * balanced("initial")
        + configured.soc_observation * balanced("soc_observation")
        + configured.lithium_inventory * balanced("lithium_inventory")
        + configured.voltage_observation * balanced("voltage_observation")
        + configured.energy_efficiency * balanced("energy_efficiency")
        + configured.dissipation * balanced("dissipation")
        + configured.aging_ode * balanced("aging_ode")
        + configured.physical_trajectory * balanced("physical_trajectory")
        + configured.stoichiometry_window * balanced("stoichiometry_window")
        + configured.ocv_anchor * balanced("ocv_anchor")
        + configured.parameter_prior * balanced("parameter_prior")
        + configured.physical_observation * balanced("physical_observation")
    )
    return total, terms
