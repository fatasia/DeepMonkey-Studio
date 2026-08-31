import { describe, expect, it } from "vitest";
import { completeBmsOnnxPrediction, prepareBmsOnnxInput, type BmsOnnxAdapterModel } from "./batteryBmsOnnxAdapter.js";

const model: BmsOnnxAdapterModel = {
  windowSize: 20,
  inputFeatures: 6,
  featureNames: [
    "observed_soh", "log1p_charge_duration_s", "log1p_discharge_duration_s",
    "log1p_relative_upper_charge_duration_s", "log1p_relative_mid_discharge_duration_s", "voltage_span_v",
  ],
  featureMean: [0, 0, 0, 0, 0, 0],
  featureStd: [1, 1, 1, 1, 1, 1],
  chemistryScope: ["lfp", "ncm"],
  confidenceGate: { passed: true },
};

describe("BMSFormer ONNX adapter", () => {
  it("builds the deployed 20×6 normalized health window", () => {
    const prepared = prepareBmsOnnxInput({
      model: "bmsformer",
      fileName: "engineering-lfp.csv",
      chemistry: "lfp",
      records: cycleRecords(20),
    }, model);
    expect(prepared.dimensions).toEqual([1, 20, 6]);
    expect(prepared.data).toHaveLength(120);
    expect([...prepared.data].every(Number.isFinite)).toBe(true);
    expect(prepared.warnings).toEqual([]);
    expect(prepared.nominalCapacityAh).toBe(100);
  });

  it("returns the same product fields and capacity basis as the Python adapter", () => {
    const prepared = prepareBmsOnnxInput({ model: "bmsformer", fileName: "lfp.csv", records: cycleRecords(20) }, model);
    expect(completeBmsOnnxPrediction(0.987276, prepared, model, "bmsformer-li-multichem-v2")).toMatchObject({
      currentSoh: 98.728,
      predictedCapacityAh: 98.728,
      confidence: "high",
      modelVersion: "bmsformer-li-multichem-v2",
    });
  });

  it("rejects an incomplete cycle window before ONNX execution", () => {
    expect(() => prepareBmsOnnxInput({ model: "bmsformer", fileName: "short.csv", records: cycleRecords(19) }, model)).toThrow("至少需要 20 个有效循环");
  });
});

function cycleRecords(cycles: number) {
  return Array.from({ length: cycles }, (_, cycleIndex) => {
    const cycle = cycleIndex + 1;
    const soh = 1 - cycleIndex * 0.001;
    return [
      { cycle, time: 0, voltage: 3.0, current: 10, capacityAh: 100 * soh, nominalCapacityAh: 100, soh },
      { cycle, time: 10, voltage: 3.4, current: 10, capacityAh: 100 * soh, nominalCapacityAh: 100, soh },
      { cycle, time: 20, voltage: 4.2, current: 10, capacityAh: 100 * soh, nominalCapacityAh: 100, soh },
      { cycle, time: 30, voltage: 4.1, current: -10, capacityAh: 100 * soh, nominalCapacityAh: 100, soh },
      { cycle, time: 40, voltage: 3.5, current: -10, capacityAh: 100 * soh, nominalCapacityAh: 100, soh },
      { cycle, time: 50, voltage: 3.0, current: -10, capacityAh: 100 * soh, nominalCapacityAh: 100, soh },
    ];
  }).flat();
}
