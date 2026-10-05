import { describe, expect, it, vi } from "vitest";
import { resolveRtShadowRoute, tickRtShadowScheduling, rtShadowRouteMetrics,
  RT_SHADOW_ADAPTIVE_REASON, RT_SHADOW_DEFAULT_COOLDOWN_FRAMES, RT_SHADOW_HYSTERESIS_REASON,
  type RtShadowSchedulingState } from "./rtShadowScheduling.js";
import { updatePbrFrameUniforms } from "./pbrFrameUniforms.js";
import { CameraFrameHistory } from "./cameraFrameHistory.js";
import { PBR_FRAME_UNIFORM_FLOATS } from "./pipelines.js";
import { resolvePbrSceneLighting } from "../lighting/pbrSceneLighting.js";

/**
 * B3 RT 阴影自动选路合同(2026-10-05):
 * ① 纯裁决四规则按序(健康 → 自适应档 → 滞回 → RT);状态变异只在 tick;
 * ② 帧循环不变式:选路 cascade ⇒ frame.output.bloom 开关位=0(WGSL 分支不进入,
 *    行为逐位等于级联档,pbrShadowSwitch ABI 合同同源)。
 */

const healthy = { rtHealthy: true, shadowTier: "ultra" as const };

function state(cooldown = 0): RtShadowSchedulingState {
  return { cascadeCooldownFrames: cooldown };
}

describe("rt shadow route policy", () => {
  it("routes to cascade when the controller is unhealthy, regardless of tier or cooldown", () => {
    expect(resolveRtShadowRoute({ ...healthy, rtHealthy: false,
      controllerFallbackReason: "staging failed", state: state(0) }))
      .toEqual({ channel: "cascade", reason: "controller:staging failed" });
    expect(resolveRtShadowRoute({ rtHealthy: false, shadowTier: "ultra", state: state() }))
      .toEqual({ channel: "cascade", reason: "controller:unstaged" });
  });

  it("routes to cascade at the performance shadow tier and arms the hysteresis cooldown via tick", () => {
    const s = state();
    const route = resolveRtShadowRoute({ ...healthy, shadowTier: "performance", state: s });
    expect(route).toEqual({ channel: "cascade", reason: RT_SHADOW_ADAPTIVE_REASON });
    tickRtShadowScheduling(s, route);
    expect(s.cascadeCooldownFrames).toBe(RT_SHADOW_DEFAULT_COOLDOWN_FRAMES);
  });

  it("holds cascade through the cooldown window and releases exactly when it drains", () => {
    const s = state(3);
    const held = resolveRtShadowRoute({ ...healthy, shadowTier: "balanced", state: s });
    expect(held).toEqual({ channel: "cascade", reason: RT_SHADOW_HYSTERESIS_REASON });
    tickRtShadowScheduling(s, held);
    tickRtShadowScheduling(s, held);
    expect(s.cascadeCooldownFrames).toBe(1);
    expect(resolveRtShadowRoute({ ...healthy, shadowTier: "balanced", state: s }))
      .toEqual({ channel: "cascade", reason: RT_SHADOW_HYSTERESIS_REASON });
    tickRtShadowScheduling(s, held);
    expect(s.cascadeCooldownFrames).toBe(0);
    // 冷却排空后恢复 RT;恢复帧清零计数(防负数残留)。
    expect(resolveRtShadowRoute({ ...healthy, shadowTier: "balanced", state: s }))
      .toEqual({ channel: "ray-traced" });
    tickRtShadowScheduling(s, { channel: "ray-traced" });
    expect(s.cascadeCooldownFrames).toBe(0);
  });

  it("keeps the cooldown stable while the controller is down and does not go negative", () => {
    const s = state(10);
    for (let frame = 0; frame < 20; frame++) {
      const route = resolveRtShadowRoute({ rtHealthy: false, shadowTier: "quality", state: s });
      tickRtShadowScheduling(s, route);
    }
    expect(s.cascadeCooldownFrames).toBe(10);
    expect(rtShadowRouteMetrics({ channel: "cascade", reason: "controller:unstaged" }))
      .toEqual({ channel: "cascade", reason: "controller:unstaged" });
    // 控制器恢复后:冷却期仍走滞回,排空后下一帧恢复 RT(恢复帧清零,防负数残留)。
    while (s.cascadeCooldownFrames > 0) {
      tickRtShadowScheduling(s, resolveRtShadowRoute({ ...healthy, shadowTier: "quality", state: s }));
    }
    expect(resolveRtShadowRoute({ ...healthy, shadowTier: "ultra", state: s }))
      .toEqual({ channel: "ray-traced" });
    expect(rtShadowRouteMetrics({ channel: "ray-traced" })).toEqual({ channel: "ray-traced" });
  });

  it("honors a custom cooldown window from the caller", () => {
    const s = state();
    const route = resolveRtShadowRoute({ ...healthy, shadowTier: "performance", state: s,
      cooldownFrames: 7 });
    tickRtShadowScheduling(s, route, 7);
    expect(s.cascadeCooldownFrames).toBe(7);
  });
});

describe("rt shadow route frame-uniform invariant (cascade ⇒ switch bit 0)", () => {
  function packed(route: { channel: "ray-traced" } | { channel: "cascade"; reason: string } | undefined) {
    const resources = { frameBuffer: {} as GPUBuffer, outputBuffer: {} as GPUBuffer,
      groundInstance: {} as GPUBuffer, frameData: new Float32Array(PBR_FRAME_UNIFORM_FLOATS),
      outputData: new Float32Array(8), groundData: new Float32Array(36) };
    const primary = resolvePbrSceneLighting({ directional: [{ directionWorld: [0, -1, 0],
      color: [1, 0.8, 0.6], intensity: 2, castShadow: true }] }).primary;
    updatePbrFrameUniforms({ writeBuffer: vi.fn() } as unknown as GPUQueue, new CameraFrameHistory(), {
      eye: [0, 0, 10], target: [0, 0, 0], extent: 10, background: [0.1, 0.2, 0.3],
      floor: [0.2, 0.2, 0.2], exposure: 1, roughness: 1,
    }, 800, 600, false, resources, primary,
    // features 快照带 rayTracedShadows=true(构造档),选路 cascade 时位必须被压 0。
    { environment: true, fog: true, groundPlane: true, groundGrid: true, ambientOcclusion: false,
      screenSpaceReflection: false, volumetricFog: false, temporalAa: false, spatialAa: false,
      visibilityBuffer: false, softRasterizeFallback: false, textureArrays: false,
      layeredMaterials: false, occlusionCulling: false, contactShadows: false, temporalUpscale: false,
      bloom: false, vignette: false, toneMapping: "three-aces-r185", debugForceFullRender: false,
      rayTracedShadows: true, sdfGi: false, megaLights: false },
    route);
    return resources.outputData[1]!;
  }

  it("keeps the RT switch bit 1 when routed to ray-traced", () => {
    expect(packed({ channel: "ray-traced" })).toBe(1);
  });
  it("clears the RT switch bit when the route falls back to cascade (bitwise cascade tier)", () => {
    expect(packed({ channel: "cascade", reason: "adaptive-shadow-tier-performance" })).toBe(0);
    expect(packed({ channel: "cascade", reason: "controller:scene-not-staged" })).toBe(0);
  });
  it("keeps the legacy behavior when no route is supplied (features bit passes through)", () => {
    expect(packed(undefined)).toBe(1);
  });
});
