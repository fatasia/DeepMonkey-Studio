import type { SceneVisualTransitionState } from "@bim-studio/contracts";
import { normalizeVisualTransition } from "./viewer/visibilityTransition";

interface TransitionFrames {
  cover: Keyframe[];
  reveal: Keyframe[];
}

export function sceneTransitionFrames(kind: SceneVisualTransitionState["kind"]): TransitionFrames {
  const transform = kind === "scale" ? "scale(0.96)" : kind === "rise" ? "translateY(2.5%)" : "none";
  return {
    cover: [{ opacity: 0, transform }, { opacity: 1, transform: "none" }],
    reveal: [{ opacity: 1, transform: "none" }, { opacity: 0, transform }],
  };
}

/**
 * 场景跳转遮罩挂在 body 上，因此路由切换不会中断退场动画。
 * 导航抛错时立即撤销遮罩，保留原场景继续工作。
 */
export async function runSceneNavigationTransition(
  requested: SceneVisualTransitionState | undefined,
  navigate: () => void,
): Promise<void> {
  const transition = normalizeVisualTransition(requested);
  const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (transition.kind === "none" || transition.durationMs <= 0 || reducedMotion) {
    navigate();
    return;
  }
  document.getElementById("scene-navigation-transition")?.remove();
  const overlay = document.createElement("div");
  overlay.id = "scene-navigation-transition";
  overlay.setAttribute("aria-hidden", "true");
  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483000",
    pointerEvents: "none",
    opacity: "0",
    background: "radial-gradient(circle at 50% 42%, #172126 0%, #0b1114 72%)",
    transformOrigin: "50% 50%",
  });
  document.body.append(overlay);
  const frames = sceneTransitionFrames(transition.kind);
  const half = Math.max(40, transition.durationMs / 2);
  try {
    await animate(overlay, frames.cover, half, transition.easing);
    navigate();
    await nextFrame();
    await animate(overlay, frames.reveal, half, transition.easing);
  } finally {
    overlay.remove();
  }
}

function animate(element: HTMLElement, frames: Keyframe[], duration: number, easing: SceneVisualTransitionState["easing"]): Promise<void> {
  if (typeof element.animate !== "function") return new Promise((resolve) => window.setTimeout(resolve, duration));
  return element.animate(frames, { duration, easing: cssEasing(easing), fill: "forwards" }).finished.then(() => undefined, () => undefined);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function cssEasing(easing: SceneVisualTransitionState["easing"]): string {
  if (easing === "ease-in") return "cubic-bezier(.4,0,1,1)";
  if (easing === "ease-out") return "cubic-bezier(0,0,.2,1)";
  if (easing === "ease-in-out") return "cubic-bezier(.4,0,.2,1)";
  return "linear";
}
