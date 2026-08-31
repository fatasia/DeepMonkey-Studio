import { describe, expect, it } from "vitest";
import { completeSocOnnxPrediction, prepareSocOnnxInput, type SocOnnxAdapterModel } from "./batterySocOnnxAdapter.js";

const model: SocOnnxAdapterModel = {
  windowSize: 16,
  inputFeatures: 7,
  featureNames: [
    "normalized_voltage", "c_rate", "temperature_c", "phase",
    "coulomb_soc_anchor", "delta_time_s", "is_lfp",
  ],
  featureMean: [0, 0, 25, 0, 0, 60, 0],
  featureStd: [1, 1, 1, 1, 1, 1, 1],
  deepCorrectionWeight: 0.2,
  chemistryScope: ["lfp", "ncm"],
  confidenceGate: { passed: true, max_test_mae: 0.03 },
  testMae: 0.018,
};

describe("SOCFormer ONNX adapter", () => {
  it("builds left-padded 16×7 windows and physical anchors", () => {
    const prepared = prepareSocOnnxInput({
      model: "socformer",
      fileName: "nmc-discharge.csv",
      chemistry: "ncm",
      nominalCapacityAh: 100,
      records: dischargeRecords(61),
    }, model);
    expect(prepared.dimensions).toEqual([61, 16, 7]);
    expect(prepared.data).toHaveLength(61 * 16 * 7);
    expect(prepared.anchorMode).toBe("cumulative-capacity");
    expect(prepared.physicalAnchors[0]).toBe(100);
    expect(prepared.physicalAnchors.at(-1)).toBe(0);
    expect([...prepared.data].every(Number.isFinite)).toBe(true);
  });

  it("blends the physical anchor with the neural correction", () => {
    const prepared = prepareSocOnnxInput({
      model: "socformer",
      fileName: "nmc-discharge.csv",
      nominalCapacityAh: 100,
      records: dischargeRecords(61),
    }, model);
    const result = completeSocOnnxPrediction(Array.from({ length: 61 }, () => 0.5), prepared, model, "socformer-li-hybrid-v2");
    expect(result).toMatchObject({
      initialSoc: 90,
      finalSoc: 10,
      confidence: "high",
      modelVersion: "socformer-li-hybrid-v2",
    });
    expect((result.points as Array<{ estimatedSoc: number }>)).toHaveLength(61);
  });

  it("treats blank numeric fields as missing rather than zero", () => {
    const records = dischargeRecords(3);
    records[0] = { ...records[0], capacityAh: "", dischargeCapacityAh: 0 };
    const prepared = prepareSocOnnxInput({
      model: "socformer",
      fileName: "blank.csv",
      nominalCapacityAh: 100,
      records,
    }, model);
    expect(prepared.usedObservedCapacity).toBe(true);
    expect(prepared.integrationCapacityAh).toBe(100);
  });

  it("requires nominal capacity before model execution", () => {
    expect(() => prepareSocOnnxInput({ model: "socformer", fileName: "invalid.csv", records: dischargeRecords(2) }, model)).toThrow("有效标称容量");
  });
});

function dischargeRecords(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    time: index * 60,
    voltage: 4.2 - index / Math.max(1, count - 1) * 1.2,
    current: -100,
    temperature: 25,
    capacityAh: index / Math.max(1, count - 1) * 100,
    chargeCapacityAh: 0,
  }));
}
