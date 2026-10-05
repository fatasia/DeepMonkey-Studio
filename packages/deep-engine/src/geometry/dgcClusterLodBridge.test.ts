import { describe, expect, it } from "vitest";
import { BAKE_CELL_ERROR_TO_DISPLACEMENT, calibrateBakeErrorToDisplacement } from "./dgcClusterLodBridge.js";

describe("calibrateBakeErrorToDisplacement(缺口 2 误差域统一)", () => {
  const α = BAKE_CELL_ERROR_TO_DISPLACEMENT;

  it("accumulates per-level α×cellSize into a monotone displacement series", () => {
    expect(calibrateBakeErrorToDisplacement([0.2, 0.4, 0.8])).toEqual([
      0.2 * α,
      0.2 * α + 0.4 * α,
      0.2 * α + 0.4 * α + 0.8 * α,
    ]);
  });
  it("clamps negative cell sizes to zero (deterministic, no NaN)", () => {
    expect(calibrateBakeErrorToDisplacement([-1, 0.5])).toEqual([0, 0.5 * BAKE_CELL_ERROR_TO_DISPLACEMENT]);
  });
  it("returns an empty series for an empty input", () => {
    expect(calibrateBakeErrorToDisplacement([])).toEqual([]);
  });
  it("keeps the calibration constant pinned at the documented median", () => {
    expect(BAKE_CELL_ERROR_TO_DISPLACEMENT).toBe(0.2153);
  });
});
