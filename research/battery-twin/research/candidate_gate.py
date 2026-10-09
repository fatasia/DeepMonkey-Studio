"""Acceptance rules for isolated research candidates."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path


PRODUCTION_NAME_FRAGMENTS = {
    "bmsformer.pt",
    "socformer.pt",
    "batterymformer-expanded",
    "batterymformer-physics",
}


def assert_isolated_candidate_path(path: Path) -> None:
    normalized = str(path).replace("\\", "/").lower()
    name = path.name.lower()
    if "candidate" not in normalized or name in PRODUCTION_NAME_FRAGMENTS:
        raise ValueError(f"研究输出必须写入带 candidate 标识的隔离路径：{path}")


@dataclass(frozen=True)
class CandidateScore:
    seed: int
    baseline_mae: float
    candidate_mae: float
    baseline_physics_residual: float
    candidate_physics_residual: float
    interval_coverage: float

    @property
    def relative_mae_change(self) -> float:
        return (self.candidate_mae - self.baseline_mae) / max(self.baseline_mae, 1e-12)

    @property
    def relative_physics_improvement(self) -> float:
        return (
            self.baseline_physics_residual - self.candidate_physics_residual
        ) / max(self.baseline_physics_residual, 1e-12)


@dataclass(frozen=True)
class AcceptancePolicy:
    min_seeds: int = 3
    max_relative_mae_degradation: float = 0.03
    min_relative_physics_improvement: float = 0.20
    nominal_interval_coverage: float = 0.90
    coverage_tolerance: float = 0.03


def evaluate_candidate(
    scores: list[CandidateScore],
    policy: AcceptancePolicy | None = None,
) -> dict[str, object]:
    rules = policy or AcceptancePolicy()
    if not scores:
        raise ValueError("至少需要一个候选评分。")
    mean_mae_change = sum(item.relative_mae_change for item in scores) / len(scores)
    mean_physics_improvement = (
        sum(item.relative_physics_improvement for item in scores) / len(scores)
    )
    mean_coverage = sum(item.interval_coverage for item in scores) / len(scores)
    checks = {
        "enough_seeds": len({item.seed for item in scores}) >= rules.min_seeds,
        "accuracy_preserved": mean_mae_change <= rules.max_relative_mae_degradation,
        "physics_improved": mean_physics_improvement >= rules.min_relative_physics_improvement,
        "coverage_calibrated": abs(
            mean_coverage - rules.nominal_interval_coverage
        ) <= rules.coverage_tolerance,
    }
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "aggregate": {
            "seeds": len({item.seed for item in scores}),
            "mean_relative_mae_change": mean_mae_change,
            "mean_relative_physics_improvement": mean_physics_improvement,
            "mean_interval_coverage": mean_coverage,
        },
        "policy": asdict(rules),
        "scores": [
            {
                **asdict(item),
                "relative_mae_change": item.relative_mae_change,
                "relative_physics_improvement": item.relative_physics_improvement,
            }
            for item in scores
        ],
    }

