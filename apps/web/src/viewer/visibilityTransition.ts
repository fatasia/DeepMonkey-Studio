import type { SceneVisualTransitionState } from "@bim-studio/contracts";

export interface VisibilityTransitionSample {
  opacityFactor: number;
  scaleFactor: number;
  riseFactor: number;
}

export const DEFAULT_VISIBILITY_TRANSITION: SceneVisualTransitionState = {
  kind: "fade",
  durationMs: 280,
  easing: "ease-out",
};

/** 将外部场景数据限制到稳定动画范围，避免超长动画阻塞连续操作。 */
export function normalizeVisualTransition(
  value: SceneVisualTransitionState | undefined,
): SceneVisualTransitionState {
  if (!value) return { kind: "none", durationMs: 0, easing: "linear" };
  return {
    kind: ["none", "fade", "scale", "rise"].includes(value.kind) ? value.kind : "none",
    durationMs: Math.min(5_000, Math.max(0, Number.isFinite(value.durationMs) ? value.durationMs : 0)),
    easing: ["linear", "ease-in", "ease-out", "ease-in-out"].includes(value.easing) ? value.easing : "linear",
  };
}

export function visibilityTransitionSample(
  transition: SceneVisualTransitionState,
  rawProgress: number,
  entering: boolean,
): VisibilityTransitionSample {
  const eased = ease(Math.min(1, Math.max(0, rawProgress)), transition.easing);
  const visibleProgress = entering ? eased : 1 - eased;
  return {
    opacityFactor: transition.kind === "none" ? Number(entering) : visibleProgress,
    scaleFactor: transition.kind === "scale" ? 0.82 + visibleProgress * 0.18 : 1,
    riseFactor: transition.kind === "rise" ? visibleProgress - 1 : 0,
  };
}

function ease(progress: number, easing: SceneVisualTransitionState["easing"]): number {
  if (easing === "ease-in") return progress * progress;
  if (easing === "ease-out") return 1 - (1 - progress) ** 2;
  if (easing === "ease-in-out") return progress < 0.5 ? 2 * progress * progress : 1 - ((-2 * progress + 2) ** 2) / 2;
  return progress;
}
