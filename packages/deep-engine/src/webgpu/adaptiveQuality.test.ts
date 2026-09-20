import { describe, expect, it } from "vitest";
import { AdaptiveQualityController, adaptiveShadowMapSize, type AdaptiveQualitySample } from "./adaptiveQuality.js";

const sample = (frame: number, changes: Partial<AdaptiveQualitySample> = {}): AdaptiveQualitySample => ({
  frame, sampleCount: 128, cpuP95Ms: 10, cpuP99Ms: 13, gpuP95Ms: 12, gpuP99Ms: 15, longFrameCount: 0,
  width: 1920, height: 1080, drawCalls: 400, triangles: 2_000_000,
  memory: { bufferBytes: 1, textureBytes: 1, estimatedBytes: 2, peakEstimatedBytes: 2, unknownResources: 0, resourceCount: 2,
    admission: { budgetBytes: 100, rejectedCount: 0 } }, ...changes,
});

describe("AdaptiveQualityController", () => {
  it("degrades only after sustained pressure and cooldown, then recovers more slowly", () => {
    const controller = new AdaptiveQualityController({ enabled: true, pressureWindows: 2, recoveryWindows: 3, cooldownFrames: 2 });
    expect(controller.sample(sample(1, { gpuP95Ms: 30 }))).toBeUndefined();
    expect(controller.sample(sample(2, { gpuP95Ms: 30 }))?.knobs).toMatchObject({ ssrConeLevels: 5, fogSteps: 48 });
    expect(controller.sample(sample(3, { gpuP95Ms: 30 }))).toBeUndefined();
    controller.sample(sample(4)); controller.sample(sample(5));
    expect(controller.sample(sample(6))?.reason).toBe("recovered");
  });

  it("honors user overrides and keeps summaries bounded and anonymous", () => {
    const controller = new AdaptiveQualityController({ enabled: true, pressureWindows: 1, cooldownFrames: 0,
      collectHotspots: true, overrides: { fogSteps: 64, shadowTier: "high" } });
    for (let frame = 1; frame <= 20; frame++) controller.sample(sample(frame, { gpuP95Ms: 35 }));
    expect(controller.state().knobs).toMatchObject({ fogSteps: 64, shadowTier: "high" });
    expect(controller.hotspotSummary()).toHaveLength(16);
    expect(JSON.stringify(controller.hotspotSummary())).not.toMatch(/model|object|name|id/i);
  });

  it("is off by default and emits no hotspot payload", () => {
    const controller = new AdaptiveQualityController();
    expect(controller.sample(sample(1, { gpuP95Ms: 100 }))).toBeUndefined();
    expect(controller.hotspotSummary()).toEqual([]);
  });
});

describe("adaptiveShadowMapSize", () => {
  const cases: ReadonlyArray<[Parameters<typeof adaptiveShadowMapSize>[0], number | undefined, number | undefined]> = [
    ["performance", 2048, 1024],
    ["balanced", 2048, 1536],
    ["high", 2048, undefined],
    ["ultra", 2048, undefined],
    ["performance", 1024, undefined],
    ["ultra", undefined, undefined],
  ];
  it.each(cases)("tier %s with author %p yields %p", (tier, author, expected) => {
    expect(adaptiveShadowMapSize(tier, author)).toBe(expected);
  });
});
