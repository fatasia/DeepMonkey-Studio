import { describe, expect, it } from "vitest";
import { DEFAULT_FIRE_EFFECT, mergeModelEffectsPatch, normalizeFireEffect } from "./modelEffectState";

const baseEffects = {
  outline: false, glow: false, xray: false, scanline: false, heatmap: false,
  dissolve: 0, edgeLight: false, color: "#36a3ff", intensity: 1,
  fire: { ...DEFAULT_FIRE_EFFECT, enabled: true, color: "#00aaff", height: 4 },
};

describe("model effect state", () => {
  it("clamps externally supplied fire parameters", () => {
    expect(normalizeFireEffect({ enabled: true, color: "invalid", intensity: 20, height: 0, density: 8 })).toEqual({
      enabled: true,
      color: DEFAULT_FIRE_EFFECT.color,
      intensity: 5,
      height: 0.1,
      density: 2,
    });
  });

  it("normalizes curves, blend and particle cap, and omits them when absent", () => {
    const normalized = normalizeFireEffect({
      enabled: true, blend: "alpha", maxParticles: 9_999,
      curves: { alpha: [{ time: 2, value: 3 }, { time: 0, value: -1 }], size: [] },
    });
    expect(normalized.blend).toBe("alpha");
    expect(normalized.maxParticles).toBe(160);
    expect(normalized.curves).toEqual({ alpha: [{ time: 0, value: 0 }, { time: 1, value: 1 }] });
    const plain = normalizeFireEffect({ enabled: true, blend: "multiply" as never, maxParticles: Number.NaN });
    expect("curves" in plain || "blend" in plain || "maxParticles" in plain).toBe(false);
  });
  it("deep-merges a data/script fire patch without losing authored parameters", () => {
    expect(mergeModelEffectsPatch(baseEffects, { fire: { intensity: 3.2 } }).fire).toEqual({
      ...baseEffects.fire,
      intensity: 3.2,
    });
    expect(mergeModelEffectsPatch(baseEffects, { fire: { enabled: false } }).fire?.enabled).toBe(false);
  });
});
