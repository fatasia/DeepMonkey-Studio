import { describe, expect, it } from "vitest";
import { packProbeRadianceUniform, PROBE_RADIANCE_MAX_DIRECTIONS } from "../rayTracing/probeRadianceKernel.js";
import { probeOcclusionDirection } from "../rayTracing/probeOcclusionRayExtension.js";
import {
  DEEP_GI_PROBE_DIRECTIONS_HIGH, DEEP_GI_PROBE_DIRECTIONS_STANDARD,
  probeRadianceDirectionCountForQuality, probeRadianceDirectionPresetForQuality,
  resolveDeepGiProbeDirectionCount, resolveDeepGiProducerDirectionCount,
} from "./probeRadianceDirectionGate.js";
import { planIrradianceProbeClipmap, probeClipmapOptionsForQuality } from "./probeClipmapPlan.js";

/** G3-S1 配置门控：默认 16 不变、32 走 opt-in、非法值 fail-closed 回 16（渲染循环不中断）。 */
describe("probe radiance direction gate", () => {
  it("resolves the default tier (16, no fail-closed) for undefined, \"standard\" and 16", () => {
    for (const value of [undefined, "standard", DEEP_GI_PROBE_DIRECTIONS_STANDARD] as const) {
      const resolution = resolveDeepGiProbeDirectionCount(value);
      expect(resolution.directionCount).toBe(DEEP_GI_PROBE_DIRECTIONS_STANDARD);
      expect(resolution.directionCount).toBe(16);
      expect(resolution.failClosed).toBe(false);
      expect(resolution.reason).toBeUndefined();
    }
  });

  it("resolves the opt-in high tier (32) for \"high\" and 32", () => {
    for (const value of ["high", DEEP_GI_PROBE_DIRECTIONS_HIGH] as const) {
      const resolution = resolveDeepGiProbeDirectionCount(value);
      expect(resolution.directionCount).toBe(DEEP_GI_PROBE_DIRECTIONS_HIGH);
      expect(resolution.directionCount).toBe(32);
      expect(resolution.failClosed).toBe(false);
      expect(resolution.reason).toBeUndefined();
    }
  });

  it("fails closed to 16 (never throws) for every out-of-vocabulary value, with a machine-readable reason", () => {
    const invalid: unknown[] = [0, 8, 15, 17, 33, 64, -16, Number.NaN, Number.POSITIVE_INFINITY,
      16.5, "ultra", "quality", "performance", "HIGH", null, true, {}, [], () => 32];
    for (const value of invalid) {
      const resolution = resolveDeepGiProbeDirectionCount(value as never);
      expect(resolution.directionCount).toBe(DEEP_GI_PROBE_DIRECTIONS_STANDARD);
      expect(resolution.failClosed).toBe(true);
      expect(resolution.reason).toContain("standard");
      expect(resolution.reason).toContain("failed closed to 16");
    }
  });

  it("keeps the gate tiers pinned to the kernel capacity contract (32 = full direction table)", () => {
    expect(DEEP_GI_PROBE_DIRECTIONS_STANDARD).toBeLessThan(DEEP_GI_PROBE_DIRECTIONS_HIGH);
    expect(DEEP_GI_PROBE_DIRECTIONS_HIGH).toBe(PROBE_RADIANCE_MAX_DIRECTIONS);
  });

  it("maps quality tiers: performance/balanced stay on 16, quality opts into 32", () => {
    expect(probeRadianceDirectionPresetForQuality("performance")).toBe("standard");
    expect(probeRadianceDirectionPresetForQuality("balanced")).toBe("standard");
    expect(probeRadianceDirectionPresetForQuality("quality")).toBe("high");
    expect(probeRadianceDirectionCountForQuality("performance")).toBe(16);
    expect(probeRadianceDirectionCountForQuality("balanced")).toBe(16);
    expect(probeRadianceDirectionCountForQuality("quality")).toBe(32);
    expect(() => probeRadianceDirectionPresetForQuality("ultra" as never)).toThrow("Invalid Deep GI quality");
  });

  it("keeps the production quality presets and the gate on the same mapping", () => {
    for (const quality of ["performance", "balanced", "quality"] as const) {
      expect(probeClipmapOptionsForQuality(quality).directionCount)
        .toBe(probeRadianceDirectionCountForQuality(quality));
    }
    // 预设选项馈入规划器不改变既有规划行为（planner 不消费 directionCount）。
    const plan = planIrradianceProbeClipmap({ cameraPosition: [0, 0, 0], sceneBounds: null,
      options: probeClipmapOptionsForQuality("quality") });
    expect(plan.profile.degraded).toBe(false);
    expect(plan.profile.levelCount).toBe(4);
  });

  it("feeds both gate tiers through the production uniform packing path (gate → kernel injection)", () => {
    for (const count of [DEEP_GI_PROBE_DIRECTIONS_STANDARD, DEEP_GI_PROBE_DIRECTIONS_HIGH]) {
      const bytes = packProbeRadianceUniform({ updateCount: 2, directionCount: count, rayMask: 1,
        tMax: 32, surfaceToLight: [0, 1, 0], lightColor: [1, 1, 1], lightIntensity: 1,
        ambient: [0, 0, 0],
        directions: Array.from({ length: count }, (_, ordinal) =>
          probeOcclusionDirection(ordinal, count) as [number, number, number]) });
      expect(bytes.byteLength).toBe(576);
    }
    // 越过容量合同（33）仍由 producer/packer 既有 fail-fast 拒绝：门只产出 16/32，不产 33。
    expect(() => packProbeRadianceUniform({ updateCount: 1, directionCount: 33, rayMask: 1, tMax: 32,
      surfaceToLight: [0, 1, 0], lightColor: [1, 1, 1], lightIntensity: 1, ambient: [0, 0, 0],
      directions: [] })).toThrow(RangeError);
  });

  it("keeps the shipped 32-direction default for the unconfigured product factory and gates explicit config", () => {
    // 未配置 = 已发布默认 32（零配置画质口径；fib32 才过 RMSE 门槛，G3-S1 报告）。
    expect(resolveDeepGiProducerDirectionCount(undefined)).toBe(DEEP_GI_PROBE_DIRECTIONS_HIGH);
    // 显式配置经同一 fail-closed 门。
    expect(resolveDeepGiProducerDirectionCount("standard")).toBe(DEEP_GI_PROBE_DIRECTIONS_STANDARD);
    expect(resolveDeepGiProducerDirectionCount(16)).toBe(DEEP_GI_PROBE_DIRECTIONS_STANDARD);
    expect(resolveDeepGiProducerDirectionCount("high")).toBe(DEEP_GI_PROBE_DIRECTIONS_HIGH);
    expect(resolveDeepGiProducerDirectionCount(32)).toBe(DEEP_GI_PROBE_DIRECTIONS_HIGH);
    // 非法显式配置 fail-closed 回 16（门契约），绝不产 33 等越容量值。
    expect(resolveDeepGiProducerDirectionCount(33 as never)).toBe(DEEP_GI_PROBE_DIRECTIONS_STANDARD);
    expect(resolveDeepGiProducerDirectionCount("ultra" as never)).toBe(DEEP_GI_PROBE_DIRECTIONS_STANDARD);
  });
});
