import { describe, expect, it, vi } from "vitest";
import { PbrRenderer } from "./pbrRenderer.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";

describe("PBR initial and late TLAS staging", () => {
  it("accepts the initial feature snapshot before shadow bindings exist", () => {
    const controller = { stageScene: vi.fn(), sceneStaged: true, maskView: {}, maskViewEpoch: 1 };
    const renderer = Object.assign(Object.create(PbrRenderer.prototype), {
      features: resolvePbrRendererFeatures({ rayTracedShadows: true }), rtShadows: controller,
    }) as PbrRenderer;
    expect(() => renderer.stageRayTracedShadowScene({} as never)).not.toThrow();
    expect(controller.stageScene).toHaveBeenCalledExactlyOnceWith({});
    expect(renderer.features.rayTracedShadows).toBe(true);
  });
  it("enables a later valid scene and updates the existing mask binding", () => {
    const mask = {}, setRayTracedShadowMaskView = vi.fn();
    const renderer = Object.assign(Object.create(PbrRenderer.prototype), {
      features: resolvePbrRendererFeatures({ rayTracedShadows: false }),
      rtShadows: { stageScene: vi.fn(), sceneStaged: true, maskView: mask, maskViewEpoch: 2 },
      shadowState: { setRayTracedShadowMaskView }, pipelines: { rayTracedShadowMaskBinding: true },
    }) as PbrRenderer;
    renderer.stageRayTracedShadowScene({} as never);
    expect(renderer.features.rayTracedShadows).toBe(true);
    expect(setRayTracedShadowMaskView).toHaveBeenCalledExactlyOnceWith(mask);
  });
});
