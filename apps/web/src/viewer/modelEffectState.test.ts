import { describe, expect, it } from "vitest";
import { DEFAULT_FIRE_EFFECT, mergeModelEffectsPatch, normalizeFireEffect, normalizeVfxEffect } from "./modelEffectState";
import { VFX_TEMPLATE_MAP } from "./vfxTemplates";

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

  describe("vfx layer state", () => {
    const steam = VFX_TEMPLATE_MAP["exhaust-steam"].defaults;

    it("clamps externally supplied vfx parameters and falls back on an invalid template", () => {
      const normalized = normalizeVfxEffect({
        template: "firework" as never, enabled: true, color: "orange",
        intensity: 9, rate: 0.1, range: 99, lifetime: 0.01, maxParticles: 1,
      });
      expect(normalized.template).toBe("exhaust-steam");
      expect(normalized.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(normalized.intensity).toBe(5);
      expect(normalized.rate).toBe(0.25);
      expect(normalized.range).toBe(50);
      expect(normalized.lifetime).toBe(0.2);
      expect(normalized.maxParticles).toBe(16);
    });

    it("keeps authored fire untouched when a vfx patch arrives, and vice versa", () => {
      const withVfx = mergeModelEffectsPatch(baseEffects, { vfx: { ...steam } });
      expect(withVfx.fire).toEqual(baseEffects.fire);
      expect(withVfx.vfx?.template).toBe("exhaust-steam");
      const fireTouched = mergeModelEffectsPatch(withVfx, { fire: { intensity: 4 } });
      expect(fireTouched.vfx).toEqual(withVfx.vfx);
    });

    it("detaches only on an explicit vfx:undefined and preserves the layer when unmentioned", () => {
      const withVfx = mergeModelEffectsPatch(baseEffects, { vfx: { ...steam, intensity: 2.5 } });
      const unmentioned = mergeModelEffectsPatch(withVfx, { intensity: 2 });
      expect(unmentioned.vfx?.intensity).toBe(2.5);
      const detached = mergeModelEffectsPatch(withVfx, { vfx: undefined });
      expect(detached.vfx).toBeUndefined();
    });

    it("seeds first-time vfx attachments (behavior trigger) with the template defaults", () => {
      // 行为只发 enabled:对象尚无 vfx 图层 → 以告警环模板默认参数为基线。
      const triggered = mergeModelEffectsPatch(baseEffects, { vfx: { template: "alarm-ring", enabled: true } });
      expect(triggered.vfx).toEqual({ ...VFX_TEMPLATE_MAP["alarm-ring"].defaults, enabled: true });
    });
  });
});
