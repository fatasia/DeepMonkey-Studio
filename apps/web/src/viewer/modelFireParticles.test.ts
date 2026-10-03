import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIRE_CURVES, FIRE_CURVE_MAX_KEYS, SCENE_FIRE_PARTICLE_BUDGET, fireBlendMode, fireRequestedParticles,
  planSceneFireBudget, resolveFireCurves, sanitizeFireCurve, sanitizeFireCurves,
} from "./modelFireParticles";

describe("fire curves", () => {
  it("sanitizes keyframes: drops non-finite, clamps to channel range, sorts, dedupes, caps at 16", () => {
    const keys = sanitizeFireCurve([
      { time: 0.8, value: 9 }, { time: Number.NaN, value: 1 }, { time: -1, value: 0.3 },
      { time: 0.8, value: 0.5 }, { time: 0.2, value: Number.POSITIVE_INFINITY },
    ], "size");
    expect(keys).toEqual([{ time: 0, value: 0.3 }, { time: 0.8, value: 0.5 }]);
    expect(sanitizeFireCurve([{ time: 0.5, value: 7 }], "alpha")).toEqual([{ time: 0.5, value: 1 }]);
    expect(sanitizeFireCurve(Array.from({ length: 40 }, (_, i) => ({ time: i / 40, value: 1 })), "alpha")).toHaveLength(FIRE_CURVE_MAX_KEYS);
    expect(sanitizeFireCurve([], "size")).toBeUndefined();
    expect(sanitizeFireCurve(undefined, "size")).toBeUndefined();
  });

  it("drops empty curve sets and keeps only valid channels", () => {
    expect(sanitizeFireCurves(undefined)).toBeUndefined();
    expect(sanitizeFireCurves({ size: [] })).toBeUndefined();
    expect(sanitizeFireCurves({ alpha: [{ time: 0, value: 1 }], size: [] })).toEqual({ alpha: [{ time: 0, value: 1 }] });
  });

  it("bakes defaults through the engine LUT and honours authored curves", () => {
    const defaults = resolveFireCurves(undefined);
    expect(defaults.alpha[0]).toBe(0);
    expect(defaults.alpha[defaults.alpha.length - 1]).toBe(0);
    expect(Math.max(...defaults.alpha)).toBeGreaterThan(0.95);
    expect(defaults.sizeMean).toBeGreaterThan(0.4);
    const flat = resolveFireCurves({ size: [{ time: 0, value: 2 }, { time: 1, value: 2 }] });
    expect(flat.sizeMean).toBeCloseTo(2, 5);
  });

  it("falls back to the default curve instead of throwing on invalid keyframes", () => {
    const resolved = resolveFireCurves({ alpha: [{ time: 0.5, value: 1 }, { time: 0.5, value: 0 }] });
    expect(Array.from(resolved.alpha)).toEqual(Array.from(resolveFireCurves(undefined).alpha));
    expect(DEFAULT_FIRE_CURVES.alpha.length).toBeGreaterThan(2);
  });
});

describe("fire emitter budget", () => {
  it("requests min(80×density, authored cap) and defaults blend to additive", () => {
    expect(fireRequestedParticles({ density: 1 })).toBe(80);
    expect(fireRequestedParticles({ density: 2 })).toBe(160);
    expect(fireRequestedParticles({ density: 2, maxParticles: 48 })).toBe(48);
    expect(fireBlendMode({})).toBe("additive");
    expect(fireBlendMode({ blend: "alpha" })).toBe("alpha");
  });

  it("allocates exactly the request while the scene stays within budget", () => {
    const report = planSceneFireBudget([{ id: "b", requested: 120 }, { id: "a", requested: 80 }]);
    expect(report.degraded).toBe(false);
    expect(report.allocatedTotal).toBe(200);
    expect(report.ratio).toBe(1);
    expect(report.reasons).toEqual([]);
    expect(report.emitters.map((item) => item.id)).toEqual(["a", "b"]);
    expect(report.emitters.every((item) => !item.degraded)).toBe(true);
  });

  it("degrades proportionally past the scene budget without losing the total cap", () => {
    const requests = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, requested: 160 }));
    const report = planSceneFireBudget(requests);
    expect(report.requestedTotal).toBe(1600);
    expect(report.allocatedTotal).toBe(SCENE_FIRE_PARTICLE_BUDGET);
    expect(report.degraded).toBe(true);
    expect(report.reasons.length).toBeGreaterThan(0);
    for (const emitter of report.emitters) {
      expect(emitter.allocated).toBeLessThan(emitter.requested);
      expect(emitter.allocated).toBeGreaterThan(0);
    }
  });

  it("is deterministic regardless of input order and never throws beyond 64 emitters", () => {
    const forward = Array.from({ length: 70 }, (_, i) => ({ id: `n${String(i).padStart(2, "0")}`, requested: 40 }));
    const a = planSceneFireBudget(forward);
    const b = planSceneFireBudget([...forward].reverse());
    expect(b).toEqual(a);
    expect(a.emitters).toHaveLength(70);
    expect(a.emitters.slice(64).every((item) => item.allocated === 0)).toBe(true);
    expect(a.allocatedTotal).toBeLessThanOrEqual(SCENE_FIRE_PARTICLE_BUDGET);
    expect(planSceneFireBudget([]).emitters).toEqual([]);
  });
});
