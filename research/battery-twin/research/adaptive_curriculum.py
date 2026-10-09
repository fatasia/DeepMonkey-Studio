"""Bounded residual curriculum utilities for physics-informed training.

The helpers keep adaptive sampling detached from the model graph.  A model
cannot lower its sampling probability by differentiating through the sampler,
and a uniform component ensures that easy regions never disappear entirely.
"""
from __future__ import annotations

from dataclasses import dataclass
from math import isfinite
from typing import Iterable

import torch
from torch import Tensor


@dataclass(frozen=True)
class AdaptiveCurriculumConfig:
    uniform_fraction_start: float = 0.70
    uniform_fraction_end: float = 0.20
    residual_strength: float = 1.00
    risk_strength: float = 0.50
    priority_exponent: float = 0.50
    max_priority_ratio: float = 6.0
    residual_ema_decay: float = 0.85
    physics_warmup_fraction: float = 0.30

    def validate(self) -> None:
        for name, value in (
            ("uniform_fraction_start", self.uniform_fraction_start),
            ("uniform_fraction_end", self.uniform_fraction_end),
            ("physics_warmup_fraction", self.physics_warmup_fraction),
        ):
            if not 0.0 <= value <= 1.0:
                raise ValueError(f"{name} 必须位于 [0, 1]。")
        if self.uniform_fraction_end > self.uniform_fraction_start:
            raise ValueError("课程后期的均匀采样比例不应高于初期。")
        if self.residual_strength < 0.0 or self.risk_strength < 0.0:
            raise ValueError("采样强度不能为负。")
        if self.priority_exponent <= 0.0:
            raise ValueError("priority_exponent 必须为正。")
        if self.max_priority_ratio < 1.0:
            raise ValueError("max_priority_ratio 必须大于等于 1。")
        if not 0.0 <= self.residual_ema_decay < 1.0:
            raise ValueError("residual_ema_decay 必须位于 [0, 1)。")


def curriculum_progress(epoch: int, epochs: int) -> float:
    if epochs < 1:
        raise ValueError("epochs 必须大于等于 1。")
    return float(min(1.0, max(0.0, epoch / max(epochs, 1))))


def physics_curriculum_authority(
    progress: float,
    warmup_fraction: float,
) -> float:
    """Ramp physics authority after a short data-fitting warm-up."""

    progress = float(min(1.0, max(0.0, progress)))
    if warmup_fraction <= 0.0:
        return 1.0
    return float(min(1.0, progress / warmup_fraction))


def _robust_unit(values: Tensor, epsilon: float = 1e-8) -> Tensor:
    clean = torch.nan_to_num(
        values.detach().double().reshape(-1),
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    ).clamp_min(0.0)
    positive = clean[clean > 0.0]
    reference = (
        positive.median()
        if positive.numel()
        else clean.new_tensor(1.0)
    ).clamp_min(epsilon)
    return (clean / reference).clamp(0.0, 20.0)


def adaptive_sample_weights(
    residual_scores: Tensor,
    risk_scores: Tensor,
    *,
    progress: float,
    config: AdaptiveCurriculumConfig | None = None,
) -> Tensor:
    """Build mean-one, bounded priorities with a persistent uniform mixture."""

    cfg = config or AdaptiveCurriculumConfig()
    cfg.validate()
    residual = _robust_unit(residual_scores)
    risk = _robust_unit(risk_scores)
    if residual.shape != risk.shape:
        raise ValueError("residual_scores 与 risk_scores 形状必须一致。")
    progress = float(min(1.0, max(0.0, progress)))
    uniform_fraction = (
        cfg.uniform_fraction_start
        + progress
        * (cfg.uniform_fraction_end - cfg.uniform_fraction_start)
    )
    priority = (
        1.0
        + cfg.residual_strength * residual
        + cfg.risk_strength * risk
    ).pow(cfg.priority_exponent)
    priority = priority / priority.mean().clamp_min(1e-8)
    priority = priority.clamp(
        min=1.0 / cfg.max_priority_ratio,
        max=cfg.max_priority_ratio,
    )
    mixed = uniform_fraction + (1.0 - uniform_fraction) * priority
    return mixed / mixed.mean().clamp_min(1e-8)


class ResidualPriorityMemory:
    """EMA memory keyed by immutable training-sample indices."""

    def __init__(
        self,
        risk_scores: Tensor,
        config: AdaptiveCurriculumConfig | None = None,
    ) -> None:
        self.config = config or AdaptiveCurriculumConfig()
        self.config.validate()
        self.risk_scores = torch.nan_to_num(
            risk_scores.detach().double().reshape(-1).cpu(),
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        ).clamp_min(0.0)
        self.residual_scores = torch.zeros_like(self.risk_scores)
        self.seen = torch.zeros_like(self.risk_scores, dtype=torch.bool)

    def update(
        self,
        indices: Tensor | Iterable[int],
        residual_scores: Tensor | Iterable[float],
    ) -> None:
        index = torch.as_tensor(indices, dtype=torch.long).reshape(-1).cpu()
        values = torch.as_tensor(
            residual_scores,
            dtype=torch.float64,
        ).reshape(-1).cpu()
        if index.numel() != values.numel():
            raise ValueError("indices 与 residual_scores 数量必须一致。")
        if index.numel() == 0:
            return
        if int(index.min()) < 0 or int(index.max()) >= len(self.residual_scores):
            raise IndexError("残差样本索引越界。")
        values = torch.nan_to_num(
            values,
            nan=0.0,
            posinf=0.0,
            neginf=0.0,
        ).clamp_min(0.0)
        sums = torch.zeros_like(self.residual_scores)
        counts = torch.zeros_like(self.residual_scores)
        sums.scatter_add_(0, index, values)
        counts.scatter_add_(0, index, torch.ones_like(values))
        unique = counts > 0
        averaged = sums[unique] / counts[unique]
        old = self.residual_scores[unique]
        decay = self.config.residual_ema_decay
        first = ~self.seen[unique]
        updated = decay * old + (1.0 - decay) * averaged
        updated[first] = averaged[first]
        self.residual_scores[unique] = updated
        self.seen[unique] = True

    def weights(self, progress: float) -> Tensor:
        return adaptive_sample_weights(
            self.residual_scores,
            self.risk_scores,
            progress=progress,
            config=self.config,
        )

    def diagnostics(self) -> dict[str, float]:
        values = self.residual_scores[self.seen]
        return {
            "seen_fraction": float(self.seen.double().mean()),
            "residual_mean": float(values.mean()) if values.numel() else 0.0,
            "residual_max": float(values.max()) if values.numel() else 0.0,
        }


class ResidualDecayTracker:
    """Upweight constraints whose EMA residuals decay more slowly."""

    def __init__(
        self,
        names: Iterable[str],
        *,
        alpha: float = 0.0,
        ema_decay: float = 0.90,
        minimum: float = 0.50,
        maximum: float = 2.00,
    ) -> None:
        if alpha < 0.0:
            raise ValueError("alpha 不能为负。")
        if not 0.0 <= ema_decay < 1.0:
            raise ValueError("ema_decay 必须位于 [0, 1)。")
        self.names = tuple(names)
        self.alpha = float(alpha)
        self.ema_decay = float(ema_decay)
        self.minimum = float(minimum)
        self.maximum = float(maximum)
        self._ema: dict[str, float] = {}

    def update(self, losses: dict[str, Tensor]) -> dict[str, float]:
        ratios: dict[str, float] = {}
        for name in self.names:
            value = float(losses[name].detach().cpu())
            value = value if isfinite(value) and value >= 0.0 else 0.0
            previous = self._ema.get(name)
            current = (
                value
                if previous is None
                else self.ema_decay * previous + (1.0 - self.ema_decay) * value
            )
            self._ema[name] = current
            ratios[name] = (
                1.0
                if previous is None
                else (previous + 1e-12) / (current + 1e-12)
            )
        if self.alpha == 0.0:
            return {name: 1.0 for name in self.names}
        ordered = sorted(ratios.values())
        reference = ordered[len(ordered) // 2] if ordered else 1.0
        multipliers = {}
        for name, ratio in ratios.items():
            raw = (reference / max(ratio, 1e-8)) ** self.alpha
            multipliers[name] = float(
                min(self.maximum, max(self.minimum, raw))
            )
        return multipliers
