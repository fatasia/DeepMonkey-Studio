import { describe, expect, it } from "vitest";
import { prioritizeLocalLights } from "./importanceBudget.js";

const point = (x: number, intensity: number) => ({ positionView: [x, 0, -4] as const, range: 4, color: [1, 1, 1] as const, intensity });

describe("Deep Lights importance budget", () => {
  it("does not rank an unlimited light as zero coverage", () => {
    const selected = prioritizeLocalLights({ points: [{ ...point(0, 4), range: 0 }, point(0, 1)] }, 1);
    expect(selected.points?.[0]?.range).toBe(0);
  });
  it("keeps the brightest nearby lights and preserves deterministic source order", () => {
    const source = { points: [point(0, 1), point(0, 4), point(0, 2)], spots: [] };
    const selected = prioritizeLocalLights(source, 2);
    expect(selected.points?.map(light => light.intensity)).toEqual([4, 2]);
    expect(prioritizeLocalLights(source, 2).points?.map(light => light.intensity)).toEqual([4, 2]);
  });

  it("budgets points and spots together while retaining directional lights", () => {
    const selected = prioritizeLocalLights({ directional: [{ directionView: [0, -1, 0], color: [1, 1, 1], intensity: 1 }],
      points: [point(0, 1)], spots: [{ ...point(0, 10), directionView: [0, 0, 1], innerConeCos: 0.9, outerConeCos: 0.5 }] }, 1);
    expect(selected.directional).toHaveLength(1);
    expect(selected.points).toHaveLength(0);
    expect(selected.spots).toHaveLength(1);
  });

  it("rejects negative and fractional budgets", () => {
    expect(() => prioritizeLocalLights({ points: [] }, -1)).toThrow("maxLocalLights");
    expect(() => prioritizeLocalLights({ points: [] }, 1.5)).toThrow("maxLocalLights");
  });
});
