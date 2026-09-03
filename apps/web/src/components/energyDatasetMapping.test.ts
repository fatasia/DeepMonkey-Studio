import type { DataDatasetField, DataDatasetPreview } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { energyObservationsFromPreview, inferEnergyFieldMap } from "./energyDatasetMapping";

describe("energy dataset mapping", () => {
  it("infers common production energy field names", () => {
    const fields = [
      { key: "recorded_at", label: "时间" },
      { key: "production_output", label: "产量" },
      { key: "energy_kwh", label: "能耗 kWh" },
      { key: "idle_minutes", label: "空转分钟" },
    ] as DataDatasetField[];
    expect(inferEnergyFieldMap(fields)).toEqual({ timestamp: "recorded_at", output: "production_output", energyKwh: "energy_kwh", idleMinutes: "idle_minutes" });
  });

  it("maps a dataset preview into analyzer observations", () => {
    const preview = {
      fields: [],
      rows: [1, 2, 3, 4].map((value) => ({ at: `t${value}`, qty: value * 10, kwh: value * 3, idle: value })),
    } as unknown as DataDatasetPreview;
    const rows = energyObservationsFromPreview(preview, { timestamp: "at", output: "qty", energyKwh: "kwh", idleMinutes: "idle" });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ timestamp: "t1", output: 10, energyKwh: 3, idleMinutes: 1 });
  });
});
