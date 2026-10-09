"""Gradient-aware dynamic weighting for multiple PINO constraints."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping

from torch import Tensor, nn

from research.adaptive_physics import AdaptivePhysicsBalancer, AdaptivePhysicsConfig
from research.adaptive_curriculum import ResidualDecayTracker


DEFAULT_TARGET_FRACTIONS = {
    "pde": 0.08,
    "boundary": 0.04,
    "conservation": 0.04,
    "initial": 0.04,
}


@dataclass
class MultiConstraintDiagnostics:
    weights: dict[str, float]
    conflicted: dict[str, bool]
    gradient_cosines: dict[str, float]
    decay_multipliers: dict[str, float]
    curriculum_authority: float


class MultiConstraintBalancer:
    """Extends the validated data-vs-physics controller to named constraints."""

    def __init__(
        self,
        target_fractions: Mapping[str, float] | None = None,
        *,
        min_weight: float = 1e-8,
        min_weights: Mapping[str, float] | None = None,
        max_weight: float = 1e-1,
        ema_decay: float = 0.90,
        conflict_discount: float = 0.25,
        update_every: int = 10,
        residual_decay_alpha: float = 0.0,
    ) -> None:
        fractions = dict(target_fractions or DEFAULT_TARGET_FRACTIONS)
        minimums = dict(min_weights or {})
        if not fractions:
            raise ValueError("至少需要一个物理约束。")
        if sum(fractions.values()) > 0.5:
            raise ValueError("物理约束目标梯度占比之和不得超过 0.5。")
        unknown_minimums = set(minimums) - set(fractions)
        if unknown_minimums:
            raise ValueError(
                "物理约束最小权重包含未知名称："
                + ", ".join(sorted(unknown_minimums))
            )
        self._balancers = {
            name: AdaptivePhysicsBalancer(
                AdaptivePhysicsConfig(
                    target_gradient_fraction=fraction,
                    min_weight=minimums.get(name, min_weight),
                    max_weight=max_weight,
                    ema_decay=ema_decay,
                    conflict_discount=conflict_discount,
                    update_every=update_every,
                )
            )
            for name, fraction in fractions.items()
        }
        self._decay_tracker = ResidualDecayTracker(
            self._balancers,
            alpha=residual_decay_alpha,
            ema_decay=ema_decay,
        )
        self._decay_multipliers = {
            name: 1.0 for name in self._balancers
        }
        self._curriculum_authority = 1.0

    def set_curriculum_authority(self, value: float) -> None:
        if not 0.0 <= value <= 1.0:
            raise ValueError("curriculum authority 必须位于 [0, 1]。")
        self._curriculum_authority = float(value)

    @property
    def weights(self) -> dict[str, float]:
        return {
            name: (
                balancer.weight
                * self._decay_multipliers[name]
                * self._curriculum_authority
            )
            for name, balancer in self._balancers.items()
        }

    def update(
        self,
        data_loss: Tensor,
        constraint_losses: Mapping[str, Tensor],
        parameters: Iterable[nn.Parameter],
        step: int,
    ) -> MultiConstraintDiagnostics:
        trainable = tuple(parameters)
        missing = set(self._balancers) - set(constraint_losses)
        if missing:
            raise ValueError(f"缺少物理约束损失：{', '.join(sorted(missing))}")
        diagnostics = {
            name: balancer.update(
                data_loss,
                constraint_losses[name],
                trainable,
                step,
            )
            for name, balancer in self._balancers.items()
        }
        self._decay_multipliers = self._decay_tracker.update(
            dict(constraint_losses)
        )
        return MultiConstraintDiagnostics(
            weights=self.weights,
            conflicted={name: item.conflicted for name, item in diagnostics.items()},
            gradient_cosines={
                name: item.gradient_cosine for name, item in diagnostics.items()
            },
            decay_multipliers=dict(self._decay_multipliers),
            curriculum_authority=self._curriculum_authority,
        )

    def weighted_loss(self, constraint_losses: Mapping[str, Tensor]) -> Tensor:
        result: Tensor | None = None
        for name, balancer in self._balancers.items():
            term = (
                balancer.weight
                * self._decay_multipliers[name]
                * self._curriculum_authority
                * constraint_losses[name]
            )
            result = term if result is None else result + term
        if result is None:
            raise RuntimeError("没有可加权的约束损失。")
        return result
