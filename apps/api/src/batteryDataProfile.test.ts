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

  it("reports consistency spreads, weakest cells and pack energy loss for topologized packs", () => {
    const rows = [
      { cellId: "C01", moduleId: "M01", topology: "2S1P", seriesCount: 2, parallelCount: 1, cycle: 30, voltage: 3.32, temperature: 25.2, internalResistanceMOhm: 1.1, soh: 0.96, capacityAh: 96, nominalCapacityAh: 100 },
      { cellId: "C02", moduleId: "M01", topology: "2S1P", seriesCount: 2, parallelCount: 1, cycle: 30, voltage: 3.28, temperature: 27.8, internalResistanceMOhm: 1.6, soh: 0.9, capacityAh: 90, nominalCapacityAh: 100 },
      { cellId: "C03", moduleId: "M02", topology: "2S1P", seriesCount: 2, parallelCount: 1, cycle: 30, voltage: 3.3, temperature: 26.1, internalResistanceMOhm: 1.2, soh: 0.95, capacityAh: 95, nominalCapacityAh: 100 },
    ];
    const profile = batteryDataProfile(rows, { chemistry: "lfp" });
    const pack = profile.packAssessment as Record<string, unknown>;
    expect(pack.weakestCellId).toBe("C02");
    expect(pack.riskLevel).toBe("high");
    expect(pack.voltageSpreadMv).toBeCloseTo(40, 1);
    expect(pack.temperatureSpreadC).toBeCloseTo(2.6, 1);
    expect(pack.resistanceSpreadPct).toBeCloseTo((0.5 / 1.3) * 100, 1);
    expect(pack.capacityCvPct).toBeGreaterThan(0);
    expect(pack.weakestCells).toMatchObject([
      { cellId: "C02", moduleId: "M01", sohPct: 90 },
      { cellId: "C03" },
      { cellId: "C01" },
    ]);
    expect((pack.weakestCells as Array<Record<string, unknown>>)[0]!.capacityDeviationPct).toBeLessThan(0);
    expect(pack.topologyLabel).toBe("2S1P");
    expect(pack.packCapacityAh).toBe(90);
    expect(pack.packEnergyKwh).toBeCloseTo(2 * 3.2 * 90 / 1000, 4);
    expect(pack.energyLossPct).toBeCloseTo(10, 1);
    expect(pack.riskReasons).toEqual(expect.arrayContaining([expect.stringContaining("SOH 极差")]));
    expect(String(pack.conclusion)).toContain("C02");
    expect(pack.recommendations).toHaveLength(3);
    expect(String(pack.finding)).toContain("C02 / M01");
  });

  it("marks a consistent pack as stable without inventing missing metrics", () => {
    const rows = [
      { cellId: "C01", cycle: 5, voltage: 3.31, temperature: 25, soh: 95.2, capacityAh: 95.2 },
      { cellId: "C02", cycle: 5, voltage: 3.3, temperature: 25.4, soh: 95.6, capacityAh: 95.6 },
      { cellId: "C03", cycle: 5, voltage: 3.305, temperature: 25.1, soh: 95.4, capacityAh: 95.4 },
    ];
    const profile = batteryDataProfile(rows);
    const pack = profile.packAssessment as Record<string, unknown>;
    expect(pack.riskLevel).toBe("stable");
    expect(pack.riskReasons).toEqual([]);
    expect(pack.resistanceSpreadPct).toBeUndefined();
    expect(pack.packEnergyKwh).toBeUndefined();
    expect(pack.voltageSpreadMv).toBeCloseTo(10, 1);
  });
});
