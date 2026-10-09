"""Gradient-aware balancing for data and physics objectives."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from math import isfinite
from typing import Iterable

import torch
from torch import Tensor, nn


@dataclass(frozen=True)
class AdaptivePhysicsConfig:
    """Controls how much optimization authority the physics objective receives."""

    target_gradient_fraction: float = 0.10
    min_weight: float = 1e-8
    max_weight: float = 1e-2
    ema_decay: float = 0.90
    conflict_cosine_threshold: float = -0.05
    conflict_discount: float = 0.25
    update_every: int = 10
    epsilon: float = 1e-12

    def validate(self) -> None:
        if not 0 < self.target_gradient_fraction <= 1:
            raise ValueError("target_gradient_fraction 必须在 (0, 1] 内。")
        if not 0 <= self.ema_decay < 1:
            raise ValueError("ema_decay 必须在 [0, 1) 内。")
        if not 0 < self.min_weight <= self.max_weight:
            raise ValueError("physics weight 边界无效。")
        if self.update_every < 1:
            raise ValueError("update_every 必须大于等于 1。")


@dataclass(frozen=True)
class PhysicsBalanceDiagnostics:
    weight: float
    data_gradient_norm: float
    physics_gradient_norm: float
    gradient_cosine: float
    conflicted: bool
    updated: bool

    def as_dict(self) -> dict[str, float | bool]:
        return asdict(self)


def _flat_gradients(
    loss: Tensor,
    parameters: tuple[nn.Parameter, ...],
) -> Tensor:
    gradients = torch.autograd.grad(
        loss,
        parameters,
        retain_graph=True,
        allow_unused=True,
    )
    parts = []
    for parameter, gradient in zip(parameters, gradients):
        if not parameter.requires_grad:
            continue
        value = gradient if gradient is not None else torch.zeros_like(parameter)
        # Spectral neural operators have complex-valued Fourier parameters.
        # Preserve both real and imaginary gradient components when measuring
        # norms and conflict angles.
        if torch.is_complex(value):
            value = torch.view_as_real(value)
        parts.append(value.reshape(-1))
    if not parts:
        return torch.zeros(1, device=loss.device, dtype=loss.dtype)
    return torch.cat(parts)


class AdaptivePhysicsBalancer:
    """Balances physics gradients relative to supervised-data gradients.

    A raw coefficient is not comparable across objectives with different units.
    This controller chooses a coefficient so that the *weighted physics gradient*
    is only a configured fraction of the data gradient.  If the two gradients
    point in conflicting directions, physics authority is reduced further.
    """

    def __init__(self, config: AdaptivePhysicsConfig | None = None) -> None:
        self.config = config or AdaptivePhysicsConfig()
        self.config.validate()
        self._weight: float | None = None
        self._last: PhysicsBalanceDiagnostics | None = None

    @property
    def weight(self) -> float:
        return self._weight if self._weight is not None else self.config.min_weight

    @property
    def last_diagnostics(self) -> PhysicsBalanceDiagnostics | None:
        return self._last

    def update(
        self,
        data_loss: Tensor,
        physics_loss: Tensor,
        parameters: Iterable[nn.Parameter],
        step: int,
    ) -> PhysicsBalanceDiagnostics:
        trainable = tuple(parameter for parameter in parameters if parameter.requires_grad)
        should_update = self._weight is None or step % self.config.update_every == 0
        if not should_update:
            previous = self._last
            diagnostics = PhysicsBalanceDiagnostics(
                weight=self.weight,
                data_gradient_norm=previous.data_gradient_norm if previous else 0.0,
                physics_gradient_norm=previous.physics_gradient_norm if previous else 0.0,
                gradient_cosine=previous.gradient_cosine if previous else 0.0,
                conflicted=previous.conflicted if previous else False,
                updated=False,
            )
            self._last = diagnostics
            return diagnostics

        # Compute diagnostics in float64.  With field-valued PINO objectives,
        # the unnormalised float32 dot product can overflow even when the
        # normalised cosine is well-defined.
        data_gradient = torch.nan_to_num(
            _flat_gradients(data_loss, trainable).double(),
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        )
        physics_gradient = torch.nan_to_num(
            _flat_gradients(physics_loss, trainable).double(),
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        )
        data_norm_tensor = torch.linalg.vector_norm(data_gradient)
        physics_norm_tensor = torch.linalg.vector_norm(physics_gradient)
        data_norm = float(data_norm_tensor.detach().cpu())
        physics_norm = float(physics_norm_tensor.detach().cpu())
        if (
            data_norm <= self.config.epsilon
            or physics_norm <= self.config.epsilon
            or not isfinite(data_norm)
            or not isfinite(physics_norm)
        ):
            cosine = 0.0
        else:
            cosine = float(
                torch.dot(
                    data_gradient / data_norm_tensor,
                    physics_gradient / physics_norm_tensor,
                ).detach().cpu()
            )
        cosine = max(-1.0, min(1.0, cosine)) if isfinite(cosine) else 0.0
        conflicted = cosine < self.config.conflict_cosine_threshold

        proposed = (
            self.config.target_gradient_fraction
            * data_norm
            / max(physics_norm, self.config.epsilon)
        )
        if conflicted:
            proposed *= self.config.conflict_discount
        proposed = max(self.config.min_weight, min(self.config.max_weight, proposed))
        if self._weight is None:
            self._weight = proposed
        else:
            self._weight = (
                self.config.ema_decay * self._weight
                + (1.0 - self.config.ema_decay) * proposed
            )
        diagnostics = PhysicsBalanceDiagnostics(
            weight=self._weight,
            data_gradient_norm=data_norm,
            physics_gradient_norm=physics_norm,
            gradient_cosine=cosine,
            conflicted=conflicted,
            updated=True,
        )
        self._last = diagnostics
        return diagnostics
