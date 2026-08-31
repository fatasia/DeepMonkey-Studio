import { describe, expect, it } from "vitest";
import {
  shouldRecycleWebGpuRenderer,
  WEBGPU_SCENE_REPLACEMENTS_BEFORE_RECYCLE,
  webGpuSceneReplacementThreshold,
} from "./webGpuRendererLifecyclePolicy";

describe("shouldRecycleWebGpuRenderer", () => {
  it("recycles WebGPU only after the bounded number of full scene replacements", () => {
    expect(shouldRecycleWebGpuRenderer("webgpu", WEBGPU_SCENE_REPLACEMENTS_BEFORE_RECYCLE - 1)).toBe(false);
    expect(shouldRecycleWebGpuRenderer("webgpu", WEBGPU_SCENE_REPLACEMENTS_BEFORE_RECYCLE)).toBe(true);
  });

  it("never applies the WebGPU workaround to WebGL", () => {
    expect(shouldRecycleWebGpuRenderer("webgl", 100)).toBe(false);
  });

  it("tightens the replacement budget as scene complexity grows", () => {
    expect(webGpuSceneReplacementThreshold(120)).toBe(12);
    expect(webGpuSceneReplacementThreshold(250)).toBe(8);
    expect(webGpuSceneReplacementThreshold(1_000)).toBe(4);
    expect(webGpuSceneReplacementThreshold(5_000)).toBe(2);
  });
});
