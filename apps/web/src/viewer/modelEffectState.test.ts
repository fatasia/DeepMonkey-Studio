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

  it("deep-merges a data/script fire patch without losing authored parameters", () => {
    expect(mergeModelEffectsPatch(baseEffects, { fire: { intensity: 3.2 } }).fire).toEqual({
      ...baseEffects.fire,
      intensity: 3.2,
    });
    expect(mergeModelEffectsPatch(baseEffects, { fire: { enabled: false } }).fire?.enabled).toBe(false);
  });
});
