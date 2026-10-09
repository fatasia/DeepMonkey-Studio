"""Electrochemical-thermal-degradation constraints for the PINO candidate.

The thermal equation is a dimensionless lumped energy balance.  It is used as
an auditable residual, not presented as a fully identified calorimetric model:

    dT/dτ = a_j I² + a_r I(SOC - 0.5) - a_c(T - T_amb)

Temperature feeds the SPM diffusion groups through an Arrhenius transform.  The
transform uses activation-energy-over-gas-constant values in kelvin and is
therefore interpretable while remaining learnable per chemistry/health state.
"""
from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import Tensor

from research.spm_physics import weighted_square_mean


@dataclass
class LumpedThermalResiduals:
    dynamics: Tensor
    initial: Tensor


def arrhenius_diffusivity(
    base_diffusivity: Tensor,
    temperature_c: Tensor,
    activation_k: Tensor,
    *,
    reference_temperature_c: float = 25.0,
) -> Tensor:
    """Return time-varying dimensionless diffusivity with Arrhenius feedback."""

    if base_diffusivity.ndim != 2:
        raise ValueError("base_diffusivity 必须为 [batch, particle]。")
    if temperature_c.ndim != 2 or temperature_c.shape[0] != base_diffusivity.shape[0]:
        raise ValueError("temperature_c 必须为 [batch, time]。")
    if activation_k.shape != base_diffusivity.shape:
        raise ValueError("activation_k 必须与 base_diffusivity 同形。")
    temperature_k = (temperature_c + 273.15).clamp(243.15, 343.15)
    reference_k = temperature_c.new_tensor(reference_temperature_c + 273.15)
    exponent = activation_k[:, None, :] * (
        1.0 / reference_k - 1.0 / temperature_k[:, :, None]
    )
    factor = torch.exp(exponent.clamp(-4.0, 4.0))
    return base_diffusivity[:, None, :] * factor


def lumped_thermal_residuals(
    temperature_c: Tensor,
    ambient_temperature_c: Tensor,
    current_c_rate: Tensor,
    voltage_v: Tensor,
    soc: Tensor,
    delta_time: Tensor,
    thermal_parameters: Tensor,
) -> LumpedThermalResiduals:
    """Evaluate a coupled energy-balance residual on normalized time."""

    shape = current_c_rate.shape
    for name, values in (
        ("temperature_c", temperature_c),
        ("ambient_temperature_c", ambient_temperature_c),
        ("voltage_v", voltage_v),
        ("soc", soc),
        ("delta_time", delta_time),
    ):
        if values.shape != shape:
            raise ValueError(f"{name} 必须与 current_c_rate 同形。")
    if thermal_parameters.shape != (shape[0], 3):
        raise ValueError("thermal_parameters 必须为 [batch, 3]。")

    joule_gain = thermal_parameters[:, 0:1]
    reversible_gain = thermal_parameters[:, 1:2]
    cooling_gain = thermal_parameters[:, 2:3]
    overpotential_proxy = (voltage_v - voltage_v.detach().mean(dim=1, keepdim=True))
    heat_rate = (
        joule_gain * current_c_rate.square()
        + reversible_gain
        * current_c_rate
        * (soc - 0.5)
        * (1.0 + overpotential_proxy.abs())
        - cooling_gain * (temperature_c - ambient_temperature_c)
    )
    safe_dt = delta_time[:, 1:].clamp_min(1e-6)
    derivative = (temperature_c[:, 1:] - temperature_c[:, :-1]) / safe_dt
    dynamics = derivative - 0.5 * (heat_rate[:, 1:] + heat_rate[:, :-1])
    initial = temperature_c[:, 0] - ambient_temperature_c[:, 0]
    return LumpedThermalResiduals(dynamics=dynamics, initial=initial)


def thermal_physics_losses(
    temperature_c: Tensor,
    ambient_temperature_c: Tensor,
    current_c_rate: Tensor,
    voltage_v: Tensor,
    soc: Tensor,
    delta_time: Tensor,
    thermal_parameters: Tensor,
) -> tuple[dict[str, Tensor], LumpedThermalResiduals]:
    residuals = lumped_thermal_residuals(
        temperature_c,
        ambient_temperature_c,
        current_c_rate,
        voltage_v,
        soc,
        delta_time,
        thermal_parameters,
    )
    return (
        {
            "thermal_dynamics": weighted_square_mean(residuals.dynamics),
            "thermal_initial": residuals.initial.square().mean(),
        },
        residuals,
    )


def degradation_state_losses(
    degradation_state: Tensor,
    capacity_ratio: Tensor,
) -> dict[str, Tensor]:
    """Constrain observable capacity-loss/resistance-growth states."""

    if degradation_state.ndim != 3 or degradation_state.shape[-1] != 2:
        raise ValueError("degradation_state 必须为 [batch, time, 2]。")
    if capacity_ratio.reshape(-1).shape[0] != degradation_state.shape[0]:
        raise ValueError("capacity_ratio batch 维度不匹配。")
    increments = degradation_state[:, 1:, :] - degradation_state[:, :-1, :]
    capacity_loss_anchor = (1.0 - capacity_ratio.reshape(-1)).clamp(0.0, 0.8)
    return {
        "degradation_anchor": torch.nn.functional.smooth_l1_loss(
            degradation_state[:, 0, 0],
            capacity_loss_anchor,
        ),
        "degradation_monotonic": torch.relu(-increments).square().mean(),
    }
