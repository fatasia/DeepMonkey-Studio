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

  it("admits a zero budget with empty local lights", () => {
    const selected = prioritizeLocalLights({ points: [point(0, 1)], spots: [] }, 0);
    expect(selected.points).toHaveLength(0);
    expect(selected.spots).toHaveLength(0);
  });

  it("scores distance falloff so nearby lights outrank distant equals", () => {
    const near = prioritizeLocalLights({ points: [point(6, 1), point(0, 1)], spots: [] }, 1);
    expect(near.points?.[0]?.positionView[0]).toBe(0);
  });

  it("rewards wider cones when spots compete for the last slot", () => {
    const spot = (outer: number, x: number) => ({ ...point(x, 1), directionView: [0, 0, -1] as const,
      innerConeCos: 0.95, outerConeCos: outer });
    const selected = prioritizeLocalLights({ points: [], spots: [spot(0.2, 3), spot(0.9, 0)] }, 1);
    expect(selected.spots?.[0]?.outerConeCos).toBe(0.9);
  });

  it("does not mutate the source light arrays and carries lightProfiles through", () => {
    const profiles = Object.freeze([{ id: "ies-a" }] as never);
    const points = Object.freeze([point(0, 4), point(0, 1)]);
    const directional = Object.freeze([{ directionView: [0, -1, 0] as const, color: [1, 1, 1] as const, intensity: 1 }]);
    const selected = prioritizeLocalLights({ directional, points, spots: Object.freeze([]), lightProfiles: profiles }, 1);
    expect(points).toHaveLength(2);
    expect(selected.lightProfiles).toBe(profiles);
    expect(selected.directional).toBe(directional);
    expect(Object.isFrozen(selected.points)).toBe(true);
  });
});
