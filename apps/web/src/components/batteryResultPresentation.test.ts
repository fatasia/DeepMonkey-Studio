import { describe, expect, it } from "vitest";
import { batteryReferencePoints, batteryTrendPoints } from "./batteryResultPresentation";

describe("batteryTrendPoints", () => {
  it("extracts SOC points without fabricating invalid samples", () => {
    expect(batteryTrendPoints("soc", {
      points: [
        { time: 0, estimatedSoc: 80 },
        { time: 5, estimatedSoc: Number.NaN },
        { time: 10, estimatedSoc: 76.5 },
      ],
    })).toEqual([{ x: 0, y: 80 }, { x: 10, y: 76.5 }]);
  });

  it("extracts the model-provided SOH trajectory for RUL", () => {
    expect(batteryTrendPoints("rul", {
      sohCurve: [{ cycle: 1, soh: 99.8 }, { cycle: 200, soh: 87.2 }],
    })).toEqual([{ x: 1, y: 99.8 }, { x: 200, y: 87.2 }]);
  });

  it("does not create a trend for a scalar SOH result", () => {
    expect(batteryTrendPoints("soh", { currentSoh: 96 })).toEqual([]);
  });

  it("extracts reference SOC only where the model kept it", () => {
    expect(batteryReferencePoints("soc", {
      points: [
        { time: 0, estimatedSoc: 80, referenceSoc: 79.5 },
        { time: 5, estimatedSoc: 78 },
        { time: 10, estimatedSoc: 76, referenceSoc: 75.8 },
      ],
    })).toEqual([{ x: 0, y: 79.5 }, { x: 10, y: 75.8 }]);
    expect(batteryReferencePoints("rul", { sohCurve: [{ cycle: 1, soh: 99 }] })).toEqual([]);
  });
});
