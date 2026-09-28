import { describe, expect, it } from "vitest";
import { effectiveLinearVolume, inverseDistanceGain } from "./spatialAudioAttenuation";

const REF = { refDistance: 2, maxDistance: 50, rolloffFactor: 1 };

describe("spatial audio attenuation (T29 inverse distance model)", () => {
  it("keeps unity gain at and below the reference distance", () => {
    expect(inverseDistanceGain(REF, 2)).toBe(1);
    expect(inverseDistanceGain(REF, 1)).toBe(1);
    expect(inverseDistanceGain(REF, 0)).toBe(1);
  });

  it("halves per reference-distance multiple at rolloff 1", () => {
    expect(inverseDistanceGain(REF, 4)).toBeCloseTo(0.5, 12);
    expect(inverseDistanceGain(REF, 8)).toBeCloseTo(0.25, 12);
    expect(inverseDistanceGain(REF, 32)).toBeCloseTo(1 / 16, 12);
  });

  it("scales with the rolloff factor", () => {
    expect(inverseDistanceGain({ ...REF, rolloffFactor: 2 }, 4)).toBeCloseTo(1 / 3, 12);
    expect(inverseDistanceGain({ ...REF, rolloffFactor: 2 }, 6)).toBeCloseTo(0.2, 12);
    expect(inverseDistanceGain({ ...REF, rolloffFactor: 0 }, 100)).toBe(1);
  });

  it("decays monotonically and never amplifies", () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let d = 2; d <= 200; d += 2) {
      const gain = inverseDistanceGain(REF, d);
      expect(gain).toBeGreaterThan(0);
      expect(gain).toBeLessThanOrEqual(1);
      expect(gain).toBeLessThanOrEqual(previous);
      previous = gain;
    }
  });

  it("defends against invalid parameters without amplifying", () => {
    expect(inverseDistanceGain({ ...REF, refDistance: 0 }, 5)).toBe(1);
    expect(inverseDistanceGain({ ...REF, refDistance: -1 }, 5)).toBe(1);
    expect(inverseDistanceGain({ ...REF, rolloffFactor: -1 }, 5)).toBe(1);
    expect(inverseDistanceGain({ ...REF, rolloffFactor: Number.NaN }, 5)).toBe(1);
    expect(inverseDistanceGain(REF, Number.NaN)).toBe(1);
    expect(inverseDistanceGain(REF, -3)).toBe(1);
  });

  it("normalizes linear volume with mute semantics", () => {
    expect(effectiveLinearVolume(0.7, false)).toBe(0.7);
    expect(effectiveLinearVolume(0.7, true)).toBe(0);
    expect(effectiveLinearVolume(4, false)).toBe(1);
    expect(effectiveLinearVolume(-1, false)).toBe(0);
    expect(effectiveLinearVolume(Number.NaN, false)).toBe(0);
  });
});
