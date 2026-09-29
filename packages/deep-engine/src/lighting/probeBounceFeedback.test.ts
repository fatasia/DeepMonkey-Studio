import { describe, expect, it } from "vitest";
import type { ProbeClipmapLevel, ProbeVector3 } from "./probeClipmapPlan.js";
import { probeClipmapOptionsForQuality } from "./probeClipmapPlan.js";
import { evaluateProbeRadianceEngineParity } from "./probeReferenceIntegrator.js";
import { integrateProbeReferenceMultibounce } from "./probeMultibounceReference.js";
import { bounceEnergySentinel, bounceFeedbackForQuality, BOUNCE_DIVERGENCE_LIMIT,
  BOUNCE_DIVERGENCE_STREAK, BOUNCE_ENERGY_GROWTH_EPSILON, DEEP_GI_BOUNCE_FEEDBACK_GAIN,
  DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS, integrateProbeFieldWithFeedback,
  resolveDeepGiBounceFeedback } from "./probeBounceFeedback.js";
import { buildReferenceRoomScene } from "./probeReferenceScene.js";

// G3 多散射一阶自反馈：迭代上限、发散哨兵、泄露哨兵、门控默认关、双缓冲确定性。
// RMSE/亮度断言用弱化阈值（验收脚本实测：相对改善 14.7%、角落亮度 +11.2%），防脆。
const scene = buildReferenceRoomScene();
const GRID = [7, 2, 5] as const;
const positions: ProbeVector3[] = [];
for (const z of [1, 2, 3, 4, 5]) for (const y of [1, 2]) for (const x of [1, 2, 3, 4, 5, 6, 7]) {
  positions.push(Object.freeze([x, y, z]) as ProbeVector3);
}
const level: ProbeClipmapLevel = { level: 0, gridSize: [...GRID] as [number, number, number],
  spacing: 1, originCell: [0, 0, 0] as [number, number, number], origin: [1, 1, 1] as [number, number, number],
  max: [...GRID] as [number, number, number], probeCount: positions.length };
const engine8 = positions.map(position => evaluateProbeRadianceEngineParity(scene, position, 8));
const buried = engine8.map((sample, index) => ({ sample, index }))
  .filter(({ sample }) => sample.missRatio === 0 && sample.meanDistance <= 0.2).map(entry => entry.index);
const truth = positions.map(position =>
  integrateProbeReferenceMultibounce(scene, position, { sampleCount: 1024, seed: 20260927 }));
const truthField = truth.map(sample => sample.irradiance);
const luminance = (vector: ProbeVector3): number => (vector[0]! + vector[1]! + vector[2]!) / 3;

describe("bounce feedback gate (default off)", () => {
  it("defaults to off without fail-closed for undefined/off/false, on for on/true", () => {
    for (const value of [undefined, "off", false] as const) {
      const resolution = resolveDeepGiBounceFeedback(value);
      expect(resolution.enabled).toBe(false);
      expect(resolution.failClosed).toBe(false);
    }
    for (const value of ["on", true] as const) {
      const resolution = resolveDeepGiBounceFeedback(value);
      expect(resolution.enabled).toBe(true);
      expect(resolution.failClosed).toBe(false);
    }
  });

  it("fails closed to off with a machine-readable reason for every other value", () => {
    for (const value of [0, 1, 2, "OFF", "On", "yes", null, NaN, Infinity, {}, [], () => true]) {
      const resolution = resolveDeepGiBounceFeedback(value as never);
      expect(resolution.enabled).toBe(false);
      expect(resolution.failClosed).toBe(true);
      expect(resolution.reason).toContain("failed closed to off");
    }
  });

  it("maps quality presets with quality as the opt-in tier and stays consistent with clipmap presets", () => {
    expect(bounceFeedbackForQuality("performance")).toBe(false);
    expect(bounceFeedbackForQuality("balanced")).toBe(false);
    expect(bounceFeedbackForQuality("quality")).toBe(true);
    expect(() => bounceFeedbackForQuality("ultra" as never)).toThrow(RangeError);
    for (const quality of ["performance", "balanced", "quality"] as const) {
      expect(probeClipmapOptionsForQuality(quality).bounceFeedback)
        .toBe(bounceFeedbackForQuality(quality));
    }
    // 默认档（balanced）必须关：多散射默认不切。
    expect(probeClipmapOptionsForQuality().bounceFeedback).toBe(false);
  });
});

describe("bounce feedback iteration semantics", () => {
  it("caps iterations fail-closed at DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS", () => {
    const runaway = integrateProbeFieldWithFeedback(scene, { positions, level,
      buriedIndices: buried, directionCount: 16 }, { iterations: 99, gain: 2 });
    expect(runaway.iterations).toBe(DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS);
    expect(runaway.iterationsRun).toBeLessThanOrEqual(DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS);
    expect(DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS).toBe(4);
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      const coerced = integrateProbeFieldWithFeedback(scene, { positions, level,
        buriedIndices: buried, directionCount: 16 }, { iterations: bad });
      expect(coerced.iterations).toBe(DEEP_GI_BOUNCE_FEEDBACK_ITERATIONS);
    }
  });

  it("is deterministic, freezes output, and never mutates state between runs (double buffering)", () => {
    const first = integrateProbeFieldWithFeedback(scene, { positions, level,
      buriedIndices: buried, directionCount: 16 }, { iterations: 3, gain: 1 });
    const second = integrateProbeFieldWithFeedback(scene, { positions, level,
      buriedIndices: buried, directionCount: 16 }, { iterations: 3, gain: 1 });
    expect(second.field).toEqual(first.field);
    expect(second.energyTrail).toEqual(first.energyTrail);
    first.field.forEach(vector => {
      expect(Object.isFrozen(vector)).toBe(true);
      vector.forEach(value => expect(Number.isFinite(value)).toBe(true));
    });
  });

  it("keeps buried probes frozen at the one-bounce field (leak sentinel) and brightens dark corners when on", () => {
    const on = integrateProbeFieldWithFeedback(scene, { positions, level,
      buriedIndices: buried, directionCount: 32 }, { iterations: 4, gain: 1 });
    const off = integrateProbeFieldWithFeedback(scene, { positions, level,
      buriedIndices: buried, directionCount: 32 }, { iterations: 4, gain: 0 });
    for (const index of buried) expect(on.field[index]).toEqual(off.field[index]);
    // 多散射只加能量不减（物理方向性）；暗角（一跳最暗四分位）相对一跳场的平均提升 > 2%
    //（验收实测 11.2%，弱化防脆）。
    const darkest = positions.map((_, index) => index)
      .sort((left, right) => luminance(off.field[left]!) - luminance(off.field[right]!))
      .slice(0, Math.floor(positions.length / 4));
    const gains = darkest.map(index => luminance(on.field[index]!)
      / Math.max(luminance(off.field[index]!), 1e-9));
    expect(gains.reduce((total, value) => total + value, 0) / gains.length).toBeGreaterThan(1.02);
  });

  it("approaches the multibounce truth from the one-bounce field (RMSE improves when on)", () => {
    const offField = positions.map(position =>
      evaluateProbeRadianceEngineParity(scene, position, 32).irradiance);
    const on = integrateProbeFieldWithFeedback(scene, { positions, level,
      buriedIndices: buried, directionCount: 32 }, { iterations: 4, gain: 1 });
    const rmse = (field: readonly ProbeVector3[]): number => {
      let square = 0, reference = 0, count = 0;
      for (let index = 0; index < positions.length; index++) {
        if (buried.includes(index)) continue;
        for (let axis = 0; axis < 3; axis++) {
          square += (field[index]![axis]! - truthField[index]![axis]!) ** 2;
        }
        reference += Math.hypot(...truthField[index]!);
        count += 1;
      }
      return Math.sqrt(square / count) / (reference / count);
    };
    // 弱化阈值：验收脚本全量口径实测 35.08%→29.92%（相对改善 14.7%），此处 1024 样本
    // 真值 + 宽松 5% 下限，防样本数漂移造成的脆断言。
    expect(rmse(on.field)).toBeLessThan(rmse(offField) * 0.95);
    expect(DEEP_GI_BOUNCE_FEEDBACK_GAIN).toBe(1);
  });
});

describe("bounce divergence sentinel", () => {
  it("trips immediately on non-finite or exploding energy", () => {
    expect(bounceEnergySentinel(NaN, 10, 0).tripped).toBe(true);
    expect(bounceEnergySentinel(Infinity, 10, 0).tripped).toBe(true);
    expect(bounceEnergySentinel(10 * BOUNCE_DIVERGENCE_LIMIT * 1.01, 10, 0).tripped).toBe(true);
  });

  it("tolerates a legitimate first-bounce growth then trips only on sustained growth", () => {
    const reference = 21.43;
    const afterFirstBounce = reference * 1.086; // 生产参考曲线的合法一跳反弹增幅（~8.6%）
    let streak = 0;
    const first = bounceEnergySentinel(afterFirstBounce, reference, streak);
    expect(first.tripped).toBe(false);
    const saturated = afterFirstBounce * (1 + BOUNCE_ENERGY_GROWTH_EPSILON * 0.5);
    const second = bounceEnergySentinel(saturated, afterFirstBounce, first.growthStreak);
    expect(second.tripped).toBe(false);
    expect(second.growthStreak).toBe(0);
    // 连续 BOUNCE_DIVERGENCE_STREAK 次增长（增幅 > epsilon）→ 失控。
    const growingOne = bounceEnergySentinel(reference * 1.10, reference, 0);
    expect(growingOne.tripped).toBe(false);
    const growingTwo = bounceEnergySentinel(reference * 1.10 * 1.10, reference * 1.10,
      growingOne.growthStreak);
    expect(growingTwo.tripped).toBe(true);
    expect(BOUNCE_DIVERGENCE_STREAK).toBe(2);
  });
});
