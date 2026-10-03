import { describe, expect, it } from "vitest";
import { createParticleCurve, evaluateParticleCurve } from "./particleCurves.js";
import { bakeParticleCurveLut, sampleParticleCurveLut } from "./particleCurveLut.js";

describe("particleCurveLut", () => {
  const curve = createParticleCurve([{ time: 0, value: 0 }, { time: 0.5, value: 1 }, { time: 1, value: 0.2 }], "alpha");

  it("bakes endpoints exactly and matches the keyframe evaluator at sample nodes", () => {
    const lut = bakeParticleCurveLut(curve, 65);
    expect(lut).toHaveLength(65);
    expect(lut[0]).toBe(0);
    expect(lut[64]).toBeCloseTo(0.2, 6);
    expect(lut[32]).toBeCloseTo(1, 6);
    for (const index of [5, 17, 40, 61]) {
      expect(lut[index]).toBeCloseTo(evaluateParticleCurve(curve, index / 64).value, 6);
    }
  });

  it("samples with linear interpolation, clamps out-of-range and tolerates NaN", () => {
    const lut = bakeParticleCurveLut(curve, 33);
    expect(sampleParticleCurveLut(lut, -1)).toBe(lut[0]);
    expect(sampleParticleCurveLut(lut, 2)).toBe(lut[32]);
    expect(sampleParticleCurveLut(lut, Number.NaN)).toBe(lut[0]);
    for (const t of [0.07, 0.31, 0.5, 0.83]) {
      expect(sampleParticleCurveLut(lut, t)).toBeCloseTo(evaluateParticleCurve(curve, t).value, 2);
    }
  });

  it("is deterministic and rejects invalid resolution", () => {
    expect(Array.from(bakeParticleCurveLut(curve, 16))).toEqual(Array.from(bakeParticleCurveLut(curve, 16)));
    expect(() => bakeParticleCurveLut(curve, 1)).toThrow(RangeError);
    expect(() => bakeParticleCurveLut(curve, 4_097)).toThrow(RangeError);
  });
});
