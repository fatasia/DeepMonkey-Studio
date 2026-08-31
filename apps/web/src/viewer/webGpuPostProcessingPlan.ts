import type { ScenePostProcessingState } from "@bim-studio/contracts";

export interface WebGpuPostProcessingPlan {
  variant: string;
  ao: boolean;
  outline: boolean;
  bloom: boolean;
  depthOfField: boolean;
  vignette: boolean;
  filmGrain: boolean;
  afterimage: boolean;
  colorGrading: boolean;
  antialias: "smaa" | "fxaa" | "none";
}

/** 将跨后端场景状态归一成 WebGPU 节点图；连续数值不会触发管线重建。 */
export function createWebGpuPostProcessingPlan(
  state: ScenePostProcessingState,
  outlinedObjectCount: number,
): WebGpuPostProcessingPlan {
  const plan: Omit<WebGpuPostProcessingPlan, "variant"> = {
    ao: state.enabled && Boolean(state.ssao || state.gtao),
    outline: outlinedObjectCount > 0,
    bloom: state.enabled && state.bloom,
    depthOfField: state.enabled && Boolean(state.depthOfField),
    vignette: state.enabled && Boolean(state.vignette),
    filmGrain: state.enabled && Boolean(state.filmGrain),
    afterimage: state.enabled && Boolean(state.afterimage),
    colorGrading: state.enabled && Boolean(state.colorGrading),
    antialias: state.enabled && state.smaa ? "smaa" : state.enabled && state.fxaa ? "fxaa" : "none",
  };
  const variant = [
    plan.ao ? "ao" : "",
    plan.outline ? "outline" : "",
    plan.bloom ? "bloom" : "",
    plan.depthOfField ? "dof" : "",
    plan.vignette ? "vignette" : "",
    plan.filmGrain ? "film" : "",
    plan.afterimage ? "afterimage" : "",
    plan.colorGrading ? "grade" : "",
    plan.antialias === "none" ? "" : plan.antialias,
  ].filter(Boolean).join("+") || "scene";
  return { ...plan, variant };
}
