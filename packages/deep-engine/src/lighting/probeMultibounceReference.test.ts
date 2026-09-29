import { describe, expect, it } from "vitest";
import type { ProbeVector3 } from "./probeClipmapPlan.js";
import { evaluateProbeRadianceEngineParity } from "./probeReferenceIntegrator.js";
import { cosineHemisphereDirection, integrateProbeReferenceMultibounce,
  MULTIBOUNCE_DEFAULT_BOUNCES, MULTIBOUNCE_DEFAULT_SAMPLE_COUNT } from "./probeMultibounceReference.js";
import { buildReferenceRoomScene } from "./probeReferenceScene.js";

// G3 多散射验收分母（多弹 MC 路径追踪）的单测：确定性、与一跳参考的功能量连续性、
// 暗角被多散射点亮的物理方向性。运行时长受控：默认样本 × 70 探针一次采集后复用。
const scene = buildReferenceRoomScene();
const positions: ProbeVector3[] = [];
for (const z of [1, 2, 3, 4, 5]) for (const y of [1, 2]) for (const x of [1, 2, 3, 4, 5, 6, 7]) {
  positions.push(Object.freeze([x, y, z]) as ProbeVector3);
}
const SAMPLES = 1024;
const truth = positions.map(position =>
  integrateProbeReferenceMultibounce(scene, position, { sampleCount: SAMPLES, seed: 20260927 }));
const oneBounce = positions.map(position =>
  evaluateProbeRadianceEngineParity(scene, position, 8).irradiance);
const luminance = (vector: ProbeVector3): number =>
  (vector[0]! + vector[1]! + vector[2]!) / 3;

describe("multibounce MC reference", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const again = integrateProbeReferenceMultibounce(scene, positions[0]!,
      { sampleCount: SAMPLES, seed: 20260927 });
    expect(again.irradiance).toEqual(truth[0]!.irradiance);
    expect(again.stable).toBe(truth[0]!.stable);
    const other = integrateProbeReferenceMultibounce(scene, positions[0]!,
      { sampleCount: SAMPLES, seed: 7 });
    expect(other.irradiance).not.toEqual(truth[0]!.irradiance);
  });

  it("keeps the one-bounce forward semantics on the first hit (miss ratio matches engine parity scale)", () => {
    // 首方向球面均匀与一跳参考同分布；封闭室内首跳 miss 占比应与一跳参考同量级（< 30%）。
    for (const sample of truth) expect(sample.missRatio).toBeLessThan(0.3);
  });

  it("brightens the dark corner probes over the one-bounce field (multibounce energy)", () => {
    // 物理方向性：封闭高反照率房间里多散射只加能量不减能量，暗角（一跳最暗四分位）
    // 的多弹真值必须系统性亮于一跳场。
    const darkest = positions.map((_, index) => index)
      .sort((left, right) => luminance(oneBounce[left]!) - luminance(oneBounce[right]!))
      .slice(0, Math.floor(positions.length / 4));
    const gains = darkest.map(index => luminance(truth[index]!.irradiance)
      / Math.max(luminance(oneBounce[index]!), 1e-9));
    const mean = gains.reduce((total, value) => total + value, 0) / gains.length;
    expect(mean).toBeGreaterThan(1.05);
  });

  it("validates options and defaults", () => {
    expect(MULTIBOUNCE_DEFAULT_SAMPLE_COUNT).toBe(4096);
    expect(MULTIBOUNCE_DEFAULT_BOUNCES).toBe(3);
    expect(() => integrateProbeReferenceMultibounce(scene, positions[0]!, { sampleCount: 1023 }))
      .toThrow(RangeError);
    expect(() => integrateProbeReferenceMultibounce(scene, positions[0]!, { bounces: 0 }))
      .toThrow(RangeError);
    expect(() => integrateProbeReferenceMultibounce(scene, positions[0]!, { stabilityZ: 0 }))
      .toThrow(RangeError);
  });

  it("cosine hemisphere directions stay in the normal hemisphere with cosine weight", () => {
    const normal: ProbeVector3 = [0, 1, 0];
    for (let index = 0; index < 64; index++) {
      const u = (index + 0.5) / 64, v = 0.25;
      const direction = cosineHemisphereDirection(normal, u, v);
      expect(direction[1]).toBeGreaterThanOrEqual(0);
      expect(Math.hypot(direction[0]!, direction[1]!, direction[2]!)).toBeCloseTo(1, 6);
    }
  });
});
