import { describe, expect, it } from "vitest";
import { batteryDataProfile } from "./batteryDataProfile.js";

describe("batteryDataProfile", () => {
  it("summarizes measured ranges and identifies the weakest pack cell", () => {
    const profile = batteryDataProfile([
      { cellId: "C01", moduleId: "M01", cycle: 1, time: 0, current: -20, voltage: 3.5, temperature: 25, soh: 0.98, capacityAh: 98 },
      { cellId: "C02", moduleId: "M01", cycle: 1, time: 0, current: -20, voltage: 3.4, temperature: 27, soh: 0.91, capacityAh: 91 },
      { cellId: "C01", moduleId: "M01", cycle: 2, time: 0, current: 10, voltage: 3.6, temperature: 26, soh: 0.97, capacityAh: 97 },
      { cellId: "C02", moduleId: "M01", cycle: 2, time: 0, current: 10, voltage: 3.3, temperature: 29, soh: 0.90, capacityAh: 90 },
    ]);
    expect(profile).toMatchObject({
      rowCount: 4,
      cellCount: 2,
      cycleCount: 2,
      ranges: { currentA: [-20, 10], voltageV: [3.3, 3.6], temperatureC: [25, 29], sohPct: [90, 98] },
      packAssessment: { meanSohPct: 93.5, weakestSohPct: 90, sohSpreadPct: 7, weakestCellId: "C02", riskLevel: "high" },
    });
  });
});
