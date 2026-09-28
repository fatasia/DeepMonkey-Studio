import { describe, expect, it } from "vitest";
import { createConstantParticleCurve, createParticleCurve, evaluateParticleCurve,
  evaluateParticleCurveOverLife, meanParticleCurveValue, type ParticleCurveKeyframe } from "./particleCurves.js";

describe("particleCurves", () => {
  it("accepts strictly increasing finite keyframes and freezes them", () => {
    const curve = createParticleCurve([{ time: 0, value: 0 }, { time: 1, value: 2 }], "alpha");
    expect(curve).toHaveLength(2);
    expect(Object.isFrozen(curve)).toBe(true);
    expect(Object.isFrozen(curve[0])).toBe(true);
  });

  it("builds constant curves from a single keyframe", () => {
    const curve = createConstantParticleCurve(0.5, "size");
    expect(evaluateParticleCurve(curve, 0).value).toBe(0.5);
    expect(evaluateParticleCurve(curve, 9).value).toBe(0.5);
    expect(evaluateParticleCurve(curve, 9).clamped).toBe(true);
  });

  it("rejects invalid keyframes with precise errors", () => {
    expect(() => createParticleCurve([], "empty")).toThrow(TypeError);
    expect(() => createParticleCurve([{ time: 0, value: 1 }, { time: 0, value: 2 }], "dup")).toThrow(RangeError);
    expect(() => createParticleCurve([{ time: 1, value: 1 }, { time: 0, value: 2 }], "desc")).toThrow(RangeError);
    expect(() => createParticleCurve([{ time: 0, value: Number.NaN }], "nan")).toThrow(RangeError);
    expect(() => createParticleCurve([{ time: Number.POSITIVE_INFINITY, value: 1 }], "inf")).toThrow(RangeError);
  });

  it("interpolates linearly between keyframes", () => {
    const curve = createParticleCurve([{ time: 0, value: 1 }, { time: 2, value: 3 }, { time: 4, value: 7 }], "k");
    expect(evaluateParticleCurve(curve, 1).value).toBe(2);
    expect(evaluateParticleCurve(curve, 3).value).toBe(5);
    expect(evaluateParticleCurve(curve, 1).segment).toBe(0);
    expect(evaluateParticleCurve(curve, 3).segment).toBe(1);
  });

  it("clamps out-of-range times deterministically", () => {
    const curve = createParticleCurve([{ time: 0.5, value: 2 }, { time: 1.5, value: 4 }], "k");
    const low = evaluateParticleCurve(curve, 0);
    const high = evaluateParticleCurve(curve, 9);
    expect(low.value).toBe(2);
    expect(low.clamped).toBe(true);
    expect(high.value).toBe(4);
    expect(high.clamped).toBe(true);
  });

  it("evaluates over normalized lifetime and rejects invalid lifetime", () => {
    const curve = createParticleCurve([{ time: 0, value: 0 }, { time: 1, value: 10 }], "k");
    expect(evaluateParticleCurveOverLife(curve, 0.5, 2)).toBeCloseTo(2.5, 12);
    expect(evaluateParticleCurveOverLife(curve, 1, 2)).toBeCloseTo(5, 12);
    expect(evaluateParticleCurveOverLife(curve, 5, 2)).toBe(10);
    expect(() => evaluateParticleCurveOverLife(curve, 1, 0)).toThrow(RangeError);
    expect(() => evaluateParticleCurveOverLife(curve, -1, 1)).toThrow(RangeError);
    expect(() => evaluateParticleCurveOverLife(curve, Number.NaN, 1)).toThrow(RangeError);
  });

  it("computes deterministic mean values over sampled lifetime", () => {
    const linear = createParticleCurve([{ time: 0, value: 0 }, { time: 1, value: 10 }], "k");
    expect(meanParticleCurveValue(linear, 101)).toBeCloseTo(5, 12);
    expect(meanParticleCurveValue(linear, 101)).toBe(meanParticleCurveValue(linear, 101));
    expect(() => meanParticleCurveValue(linear, 0)).toThrow(RangeError);
  });

  it("is bit-reproducible for identical inputs", () => {
    const keys: readonly ParticleCurveKeyframe[] = [
      { time: 0, value: 0.1 }, { time: 0.25, value: 0.7 }, { time: 1, value: 0.3 }];
    const curve = createParticleCurve(keys, "k");
    const samples = Array.from({ length: 97 }, (_, index) => evaluateParticleCurve(curve, index / 96).value);
    const again = Array.from({ length: 97 }, (_, index) => evaluateParticleCurve(curve, index / 96).value);
    expect(samples).toEqual(again);
  });
});
