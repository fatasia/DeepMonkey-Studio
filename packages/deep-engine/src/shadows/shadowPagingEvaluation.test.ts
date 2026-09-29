import { describe, expect, it } from "vitest";
import { EVALUATION_BUDGET_BYTES, analyticSpotVisibility, buildEvaluationLights, percentile,
  planAtlasLeg, planPagedLeg, spotIrradiance, summarizeShadowQuality } from "./shadowPagingEvaluation.js";

const BUDGET = EVALUATION_BUDGET_BYTES;

describe("buildEvaluationLights", () => {
  it("lays out deterministic separated patches with descending importance", () => {
    const scenario = buildEvaluationLights(4);
    expect(scenario.lights.map(light => light.key)).toEqual(
      ["eval-spot-0", "eval-spot-1", "eval-spot-2", "eval-spot-3"]);
    expect(scenario.lights.map(light => light.importance)).toEqual([4, 3, 2, 1]);
    expect(scenario.lights[0]!.patchCenter).toEqual([-3.5, -3.5]);
    expect(scenario.lights[1]!.patchCenter).toEqual([3.5, -3.5]);
    expect(scenario.lights.every(light => light.occluders.length === 3)).toBe(true);
    expect(() => buildEvaluationLights(0)).toThrow(RangeError);
    expect(() => buildEvaluationLights(17)).toThrow(RangeError);
  });

  it("keeps every occluder inside its own patch", () => {
    const { lights } = buildEvaluationLights(16);
    for (const light of lights) {
      const [cx, cz] = light.patchCenter;
      for (const occluder of light.occluders) {
        expect(Math.abs(occluder.min[0]! - cx)).toBeLessThanOrEqual(light.patchHalfExtent);
        expect(Math.abs(occluder.max[2]! - cz)).toBeLessThanOrEqual(light.patchHalfExtent);
        expect(occluder.min[1]!).toBe(0);
      }
    }
  });
});

describe("planAtlasLeg", () => {
  it("mirrors the product default: 1024 atlas with 2x2 tiles shadows at most four lights", () => {
    const { lights } = buildEvaluationLights(16);
    const plan = planAtlasLeg(lights, BUDGET, { requestedAtlasSize: 1024, tileTexels: 512 });
    expect(plan.strategy).toBe("atlas");
    expect(plan.depthBytes).toBe(BUDGET);
    expect(plan.shadowed).toHaveLength(4);
    expect(plan.shadowed[0]!.key).toBe("eval-spot-0");
    expect(plan.shadowed[0]!.texels).toBe(508);
    expect(plan.unshadowed).toHaveLength(12);
  });

  it("fines the tile grid to cover all sixteen lights at equal bytes", () => {
    const { lights } = buildEvaluationLights(16);
    const plan = planAtlasLeg(lights, BUDGET, { requestedAtlasSize: 1024, tileTexels: 256 });
    expect(plan.shadowed).toHaveLength(16);
    expect(plan.shadowed[0]!.texels).toBe(252);
    expect(plan.unshadowed).toHaveLength(0);
  });

  it("rejects atlases beyond the budget and non-dividing tiles", () => {
    const { lights } = buildEvaluationLights(1);
    expect(() => planAtlasLeg(lights, BUDGET, { requestedAtlasSize: 2048, tileTexels: 512 }))
      .toThrow(/budget/);
    expect(() => planAtlasLeg(lights, BUDGET, { requestedAtlasSize: 1024, tileTexels: 300 }))
      .toThrow(RangeError);
  });
});

describe("planPagedLeg", () => {
  it("admits mip0 pages for every light before deepening any chain", () => {
    const { lights } = buildEvaluationLights(16);
    const plan = planPagedLeg(lights, BUDGET, { tileEdgeTexels: 256, mipLevels: 3 });
    // 16 × mip0(256²×4) = 4 MiB exactly: coverage first, zero budget left for deeper mips.
    expect(plan.shadowed).toHaveLength(16);
    expect(plan.depthBytes).toBe(BUDGET);
    expect(plan.shadowed.every(shadow => shadow.texels === 256)).toBe(true);
    expect(plan.unshadowed).toHaveLength(0);
  });

  it("deepens chains only when the mip0 working set leaves budget", () => {
    const { lights } = buildEvaluationLights(4);
    const plan = planPagedLeg(lights, BUDGET, { tileEdgeTexels: 256, mipLevels: 3 });
    expect(plan.shadowed).toHaveLength(4);
    // Full chains: 4 × (256² + 128² + 64²) × 4 bytes.
    const chain = (256 * 256 + 128 * 128 + 64 * 64) * 4;
    expect(plan.shadowed.every(shadow => shadow.bytes === chain)).toBe(true);
    expect(plan.depthBytes).toBe(4 * chain);
    expect(plan.depthBytes).toBeLessThanOrEqual(BUDGET);
  });

  it("matches atlas coverage at equal tile size and never reserves more bytes", () => {
    const { lights } = buildEvaluationLights(4);
    const atlas = planAtlasLeg(lights, BUDGET, { requestedAtlasSize: 1024, tileTexels: 512 });
    const paged = planPagedLeg(lights, BUDGET, { tileEdgeTexels: 512, mipLevels: 3 });
    // mip0 先于深 mip 准入：同页尺寸同预算下覆盖绝不劣于 atlas。
    expect(paged.shadowed.map(shadow => shadow.key)).toEqual(atlas.shadowed.map(shadow => shadow.key));
    expect(paged.depthBytes).toBeLessThanOrEqual(atlas.depthBytes);
    expect(paged.shadowed.every(shadow => shadow.bytes <= atlas.shadowed[0]!.bytes)).toBe(true);
  });

  it("deepens chains strictly in importance order when budget remains after full mip0 coverage", () => {
    const { lights } = buildEvaluationLights(13);
    const plan = planPagedLeg(lights, BUDGET, { tileEdgeTexels: 256, mipLevels: 3 });
    // 13 × mip0(262144B) = 3.25 MiB：全员覆盖；mip1(65536B) 再进 12 条后预算精确归零。
    // 顶部灯得 mip0+mip1，最低重要性灯只有 mip0：准入次序 = mip 升序 → importance 降序。
    expect(plan.shadowed).toHaveLength(13);
    expect(plan.depthBytes).toBe(BUDGET);
    expect(plan.shadowed[0]!.bytes).toBe(262144 + 65536);
    expect(plan.shadowed[11]!.bytes).toBe(262144 + 65536);
    expect(plan.shadowed[12]!.bytes).toBe(262144);
  });

  it("with mipLevels=1 equals the atlas tile budget per shadowed light", () => {
    const { lights } = buildEvaluationLights(16);
    const atlas = planAtlasLeg(lights, BUDGET, { requestedAtlasSize: 1024, tileTexels: 256 });
    const paged = planPagedLeg(lights, BUDGET, { tileEdgeTexels: 256, mipLevels: 1 });
    expect(paged.shadowed.map(shadow => shadow.key)).toEqual(atlas.shadowed.map(shadow => shadow.key));
    expect(paged.shadowed[0]!.bytes).toBe(256 * 256 * 4);
    expect(paged.shadowed[0]!.texels).toBe(256);
  });

  it("keeps residency within the budget invariant", () => {
    for (const count of [1, 4, 16]) {
      for (const tileEdgeTexels of [128, 256, 512]) {
        const { lights } = buildEvaluationLights(count);
        const plan = planPagedLeg(lights, BUDGET, { tileEdgeTexels, mipLevels: 3 });
        expect(plan.depthBytes).toBeLessThanOrEqual(BUDGET);
        expect(plan.shadowed.length + plan.unshadowed.length).toBe(count);
      }
    }
  });
});

describe("analyticSpotVisibility", () => {
  const { lights } = buildEvaluationLights(1);
  const light = lights[0]!;
  const [cx, cz] = light.patchCenter;

  it("shades the floor footprint behind a straight-down box and clears elsewhere", () => {
    // 灯在 (cx, 5, cz)，宽 0.3、高 1.2 的盒子把脚印投影放大 5/(5-1.2)。
    const scale = 5 / (5 - 1.2);
    const footprintHalf = 0.15 * scale;
    expect(analyticSpotVisibility([cx, 0, cz], light)).toBe(true);
    expect(analyticSpotVisibility([cx + footprintHalf + 0.05, 0, cz], light)).toBe(false);
    expect(analyticSpotVisibility([cx - footprintHalf - 0.05, 0, cz], light)).toBe(false);
    expect(analyticSpotVisibility([cx + 2.5, 0, cz], light)).toBe(false);
  });

  it("projects the thin occluder footprint narrower than the wide one", () => {
    const thin = analyticSpotVisibility([cx - 1.6, 0, cz], light);
    expect(thin).toBe(true);
    expect(analyticSpotVisibility([cx - 1.6 + 0.2, 0, cz], light)).toBe(false);
    // 宽盒(offset +1.6, w 0.7, h 0.9)的地面影=[cx+1.524, cx+2.378]（全距投影 scale=5/4.1）。
    expect(analyticSpotVisibility([cx + 1.6, 0, cz], light)).toBe(true);
    expect(analyticSpotVisibility([cx + 2.2, 0, cz], light)).toBe(true);
    expect(analyticSpotVisibility([cx + 2.5, 0, cz], light)).toBe(false);
  });
});

describe("spotIrradiance", () => {
  it("falls off with squared distance and clamps near the light", () => {
    const { lights } = buildEvaluationLights(1);
    const light = lights[0]!;
    expect(spotIrradiance([0, 0, 0], light)).toBeCloseTo(64 / 25, 12);
    expect(spotIrradiance([light.position[0], 4.9, light.position[2]], light)).toBe(64);
  });
});

describe("summarizeShadowQuality", () => {
  const width = 8, height = 4;
  const build = (): { measured: Float32Array; reference: Float32Array; mask: Uint8Array } => {
    const reference = new Float32Array(width * height);
    const measured = new Float32Array(width * height);
    const mask = new Uint8Array(width * height).fill(1);
    for (let index = 0; index < reference.length; index += 1) {
      reference[index] = (index % width) < 4 ? 1 : 0;
    }
    return { measured, reference, mask };
  };

  it("reports zero error for a perfect hard shadow", () => {
    const { measured, reference, mask } = build();
    measured.set(reference);
    const stats = summarizeShadowQuality(measured, reference, mask, width);
    expect(stats.rmse).toBe(0);
    expect(stats.leakFraction).toBe(0);
    expect(stats.samples).toBe(width * height);
    expect(stats.shadowedSamples).toBe(width * height / 2);
  });

  it("charges leaks inside the reference shadow", () => {
    const { measured, reference, mask } = build();
    measured.set(reference);
    measured[5] = 0.5;
    const stats = summarizeShadowQuality(measured, reference, mask, width);
    expect(stats.leakFraction).toBeCloseTo(1 / (width * height / 2), 12);
  });

  it("measures a one-texel penumbra as width 2 and a hard edge as width 1", () => {
    const hard = build();
    hard.measured.set(hard.reference);
    const hardStats = summarizeShadowQuality(hard.measured, hard.reference, hard.mask, width);
    expect(hardStats.edgeWidthP50).toBe(1);
    expect(hardStats.edgeWidthP95).toBe(1);
    const soft = build();
    soft.measured.set(soft.reference);
    // 每行列 3→4 都是过渡：0.95（亮锚）/0.5（中间）/0.05（影锚）→ 宽 2。
    for (let y = 0; y < height; y += 1) {
      soft.measured[y * width + 3] = 0.95; soft.measured[y * width + 4] = 0.5; soft.measured[y * width + 5] = 0.05;
    }
    const softStats = summarizeShadowQuality(soft.measured, soft.reference, soft.mask, width);
    expect(softStats.edgeWidthP50).toBe(2);
    expect(softStats.edgeWidthP95).toBe(2);
  });

  it("ignores samples outside the mask", () => {
    const { measured, reference, mask } = build();
    measured.set(reference);
    mask.fill(0, 0, 4);
    const stats = summarizeShadowQuality(measured, reference, mask, width);
    expect(stats.samples).toBe(width * height - 4);
  });

  it("returns zero-width stats when no edges exist", () => {
    const reference = new Float32Array(width * height);
    const measured = new Float32Array(width * height);
    const mask = new Uint8Array(width * height).fill(1);
    const stats = summarizeShadowQuality(measured, reference, mask, width);
    expect(stats.edgeWidthP50).toBe(0);
    expect(stats.edgeWidthP95).toBe(0);
    expect(stats.shadowedSamples).toBe(width * height);
    expect(stats.leakFraction).toBe(0);
  });

  it("rejects mismatched array shapes", () => {
    expect(() => summarizeShadowQuality(new Float32Array(3), new Float32Array(32),
      new Uint8Array(32), 8)).toThrow(RangeError);
  });
});

describe("percentile", () => {
  it("returns 0 for empty input and interpolation-free ranks", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
  });
});

describe("determinism", () => {
  it("replays identical plans for identical inputs", () => {
    const { lights } = buildEvaluationLights(16);
    const first = planPagedLeg(lights, BUDGET, { tileEdgeTexels: 256, mipLevels: 3 });
    const second = planPagedLeg(buildEvaluationLights(16).lights, BUDGET, { tileEdgeTexels: 256, mipLevels: 3 });
    expect(second).toEqual(first);
    const atlasFirst = planAtlasLeg(lights, BUDGET, { requestedAtlasSize: 1024, tileTexels: 512 });
    const atlasSecond = planAtlasLeg(buildEvaluationLights(16).lights, BUDGET,
      { requestedAtlasSize: 1024, tileTexels: 512 });
    expect(atlasSecond).toEqual(atlasFirst);
  });
});
