"""Dimensionless single-particle-model physics for the PINO candidate.

The research candidate uses a spherical finite-volume residual instead of
high-order autograd through every Transformer block.  The radial coordinate is
normalised to [0, 1], while ``diffusivity`` represents the dimensionless
``D_s * t_scale / R_s**2`` group.
"""
from __future__ import annotations

from dataclasses import dataclass

import torch
from torch import Tensor


PARTICLE_FLUX_SIGNS = (-1.0, 1.0)


@dataclass
class SPMResiduals:
    dynamics: Tensor
    center_boundary: Tensor
    surface_boundary: Tensor
    conservation: Tensor


def radial_grid(
    radial_points: int,
    *,
    device: torch.device | None = None,
    dtype: torch.dtype = torch.float32,
) -> tuple[Tensor, Tensor, Tensor]:
    if radial_points < 4:
        raise ValueError("radial_points 必须至少为 4。")
    edges = torch.linspace(0.0, 1.0, radial_points + 1, device=device, dtype=dtype)
    centers = 0.5 * (edges[:-1] + edges[1:])
    volumes = (edges[1:].pow(3) - edges[:-1].pow(3)) / 3.0
    return edges, centers, volumes


def radial_volume_average(concentration: Tensor) -> Tensor:
    """Return volume-weighted particle concentration.

    ``concentration`` is ``[..., radial, particle]``.
    """

    radial_points = concentration.shape[-2]
    _, _, volumes = radial_grid(
        radial_points,
        device=concentration.device,
        dtype=concentration.dtype,
    )
    weights = volumes / volumes.sum()
    shape = (1,) * (concentration.ndim - 2) + (radial_points, 1)
    return (concentration * weights.reshape(shape)).sum(dim=-2)


def surface_flux(
    current_c_rate: Tensor,
    flux_scale: float | Tensor = 0.01,
) -> Tensor:
    signs = torch.tensor(
        PARTICLE_FLUX_SIGNS,
        device=current_c_rate.device,
        dtype=current_c_rate.dtype,
    )
    if isinstance(flux_scale, Tensor):
        scale = flux_scale.to(
            device=current_c_rate.device,
            dtype=current_c_rate.dtype,
        )
        if scale.ndim == 1 and scale.shape == (2,):
            scale = scale.reshape(1, 1, 2)
        elif scale.ndim == 2 and scale.shape == (current_c_rate.shape[0], 2):
            scale = scale[:, None, :]
        else:
            raise ValueError("flux_scale Tensor 必须为 [2] 或 [batch, 2]。")
    else:
        scale = float(flux_scale)
    return current_c_rate.unsqueeze(-1) * signs * scale


def finite_volume_rhs(
    concentration: Tensor,
    diffusivity: Tensor,
    imposed_surface_flux: Tensor,
) -> Tensor:
    """Evaluate spherical diffusion RHS using conservative shell fluxes.

    Shapes:
      concentration: ``[batch, time, radial, 2]``
      diffusivity: ``[batch, 2]`` or temperature-conditioned ``[batch, time, 2]``
      imposed_surface_flux: ``[batch, time, 2]``
    """

    if concentration.ndim != 4 or concentration.shape[-1] != 2:
        raise ValueError("concentration 必须为 [batch, time, radial, 2]。")
    batch, time_steps, radial_points, particles = concentration.shape
    if diffusivity.shape == (batch, particles):
        expanded_diffusivity = diffusivity[:, None, None, :]
    elif diffusivity.shape == (batch, time_steps, particles):
        expanded_diffusivity = diffusivity[:, :, None, :]
    else:
        raise ValueError("diffusivity 必须为 [batch, 2] 或 [batch, time, 2]。")
    if imposed_surface_flux.shape != (batch, time_steps, particles):
        raise ValueError("imposed_surface_flux 必须为 [batch, time, 2]。")

    edges, centers, volumes = radial_grid(
        radial_points,
        device=concentration.device,
        dtype=concentration.dtype,
    )
    center_spacing = centers[1:] - centers[:-1]
    internal_gradient = (
        concentration[:, :, 1:, :] - concentration[:, :, :-1, :]
    ) / center_spacing.reshape(1, 1, -1, 1)
    internal_flux = -expanded_diffusivity * internal_gradient
    zero_flux = torch.zeros(
        batch,
        time_steps,
        1,
        particles,
        device=concentration.device,
        dtype=concentration.dtype,
    )
    face_flux = torch.cat(
        (zero_flux, internal_flux, imposed_surface_flux.unsqueeze(-2)),
        dim=-2,
    )
    face_areas = edges.pow(2)
    outward = face_areas[1:].reshape(1, 1, -1, 1) * face_flux[:, :, 1:, :]
    inward = face_areas[:-1].reshape(1, 1, -1, 1) * face_flux[:, :, :-1, :]
    return -(outward - inward) / volumes.reshape(1, 1, -1, 1)


def spm_residuals(
    concentration: Tensor,
    current_c_rate: Tensor,
    delta_time: Tensor,
    diffusivity: Tensor,
    *,
    flux_scale: float | Tensor = 0.01,
) -> SPMResiduals:
    if current_c_rate.shape != concentration.shape[:2]:
        raise ValueError("current_c_rate 必须与 concentration 的 batch/time 对齐。")
    if delta_time.shape != current_c_rate.shape:
        raise ValueError("delta_time 必须与 current_c_rate 同形。")
    imposed_flux = surface_flux(current_c_rate, flux_scale)
    rhs = finite_volume_rhs(concentration, diffusivity, imposed_flux)
    safe_dt = delta_time[:, 1:].clamp_min(1e-6)
    time_derivative = (
        concentration[:, 1:, :, :] - concentration[:, :-1, :, :]
    ) / safe_dt[:, :, None, None]
    dynamics = time_derivative - 0.5 * (rhs[:, 1:, :, :] + rhs[:, :-1, :, :])

    _, centers, _ = radial_grid(
        concentration.shape[-2],
        device=concentration.device,
        dtype=concentration.dtype,
    )
    center_boundary = (
        concentration[:, :, 1, :] - concentration[:, :, 0, :]
    ) / (centers[1] - centers[0])
    surface_gradient = (
        concentration[:, :, -1, :] - concentration[:, :, -2, :]
    ) / (centers[-1] - centers[-2])
    if diffusivity.ndim == 2:
        surface_diffusivity = diffusivity[:, None, :]
    else:
        surface_diffusivity = diffusivity
    predicted_surface_flux = -surface_diffusivity * surface_gradient
    surface_boundary = predicted_surface_flux - imposed_flux

    average = radial_volume_average(concentration)
    average_rate = (average[:, 1:, :] - average[:, :-1, :]) / safe_dt[:, :, None]
    # The unit sphere has surface area / volume ratio 3.
    expected_average_rate = -1.5 * (
        imposed_flux[:, 1:, :] + imposed_flux[:, :-1, :]
    )
    conservation = average_rate - expected_average_rate
    return SPMResiduals(
        dynamics=dynamics,
        center_boundary=center_boundary,
        surface_boundary=surface_boundary,
        conservation=conservation,
    )


def detached_residual_weights(
    residual: Tensor,
    *,
    exponent: float = 0.5,
    max_weight: float = 5.0,
    epsilon: float = 1e-6,
) -> Tensor:
    """Create bounded local PINO collocation weights without a gaming gradient."""

    magnitude = residual.detach().abs()
    reduce_dims = tuple(range(1, magnitude.ndim))
    reference = magnitude.mean(dim=reduce_dims, keepdim=True).clamp_min(epsilon)
    weights = (epsilon + magnitude / reference).pow(exponent)
    weights = weights.clamp(max=max_weight)
    return weights / weights.mean(dim=reduce_dims, keepdim=True).clamp_min(epsilon)


def weighted_square_mean(residual: Tensor) -> Tensor:
    weights = detached_residual_weights(residual)
    return (weights * residual.pow(2)).mean()


def spm_physics_losses(
    concentration: Tensor,
    current_c_rate: Tensor,
    delta_time: Tensor,
    diffusivity: Tensor,
    initial_concentration: Tensor,
    *,
    flux_scale: float | Tensor = 0.01,
) -> tuple[dict[str, Tensor], SPMResiduals]:
    residuals = spm_residuals(
        concentration,
        current_c_rate,
        delta_time,
        diffusivity,
        flux_scale=flux_scale,
    )
    losses = {
        "pde": weighted_square_mean(residuals.dynamics),
        "boundary": (
            weighted_square_mean(residuals.center_boundary)
            + weighted_square_mean(residuals.surface_boundary)
        ),
        "conservation": weighted_square_mean(residuals.conservation),
        "initial": torch.nn.functional.mse_loss(
            concentration[:, 0, :, :],
            initial_concentration[:, None, :].expand_as(concentration[:, 0, :, :]),
        ),
    }
    return losses, residuals
