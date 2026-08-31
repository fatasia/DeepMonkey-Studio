import { describe, expect, it } from "vitest";
import type { ScenePostProcessingState } from "@bim-studio/contracts";
import { createWebGpuPostProcessingPlan } from "./webGpuPostProcessingPlan";

const base: ScenePostProcessingState = {
  enabled: false,
  smaa: false,
  fxaa: false,
  ssao: false,
  ssaoIntensity: 1,
  gtao: false,
  gtaoIntensity: 1,
  bloom: false,
  bloomStrength: 0.35,
  bloomThreshold: 0.9,
};

describe("createWebGpuPostProcessingPlan", () => {
  it("禁用后处理时保持直接场景输出", () => {
    expect(createWebGpuPostProcessingPlan(base, 0)).toMatchObject({ variant: "scene", ao: false, antialias: "none" });
  });

  it("对象描边独立于屏幕后处理总开关", () => {
    expect(createWebGpuPostProcessingPlan(base, 1)).toMatchObject({ variant: "outline", outline: true });
  });

  it("将 SSAO/GTAO 归一到官方 GTAO 节点，并优先使用 SMAA", () => {
    const plan = createWebGpuPostProcessingPlan({
      ...base,
      enabled: true,
      ssao: true,
      bloom: true,
      vignette: true,
      smaa: true,
      fxaa: true,
    }, 0);
    expect(plan).toMatchObject({ ao: true, bloom: true, vignette: true, antialias: "smaa" });
    expect(plan.variant).toBe("ao+bloom+vignette+smaa");
  });

  it("连续参数变化不改变节点图签名", () => {
    const first = createWebGpuPostProcessingPlan({ ...base, enabled: true, bloom: true, bloomStrength: 0.2 }, 0);
    const second = createWebGpuPostProcessingPlan({ ...base, enabled: true, bloom: true, bloomStrength: 2 }, 0);
    expect(second.variant).toBe(first.variant);
  });

  it("WebGPU 调色只在开关变化时重建节点图", () => {
    const first = createWebGpuPostProcessingPlan({ ...base, enabled: true, colorGrading: true, hue: 10 }, 0);
    const second = createWebGpuPostProcessingPlan({ ...base, enabled: true, colorGrading: true, hue: 80 }, 0);
    expect(first.variant).toBe("grade");
    expect(second.variant).toBe(first.variant);
  });
});
