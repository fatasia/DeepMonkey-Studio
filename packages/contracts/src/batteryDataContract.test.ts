import { describe, expect, it } from "vitest";
import {
  assessBatteryDataContract,
  batteryBindingFeatures,
  normalizeBatteryRecords,
} from "./batteryDataContract.js";

describe("battery data contract", () => {
  it("rejects a generic equipment dataset instead of treating all numeric fields as battery signals", () => {
    const result = assessBatteryDataContract("bmsformer", [
      { key: "equipmentId", label: "设备", type: "string" },
      { key: "temperature", label: "温度", type: "number" },
      { key: "vibration", label: "振动", type: "number" },
    ]);

    expect(result.compatible).toBe(false);
    expect(result.missing).toEqual(["循环编号", "采样时间", "电压", "电流", "SOH 或放电容量"]);
  });

  it("maps aliases and Chinese labels to the stable RUL model contract", () => {
    const assessment = assessBatteryDataContract("batterymformer", [
      { key: "cycle_id", type: "number" },
      { key: "sample_at", label: "采样时间（s）", type: "number" },
      { key: "cell_voltage", label: "单体电压(V)", type: "number" },
      { key: "current_in_A", type: "number" },
      { key: "discharge_capacity_in_Ah", type: "number" },
      { key: "charge_capacity_in_Ah", type: "number" },
    ]);

    expect(assessment.compatible).toBe(true);
    expect(batteryBindingFeatures(assessment)).toEqual(expect.arrayContaining([
      { modelField: "cycle", sourceField: "cycle_id", required: true },
      { modelField: "time", sourceField: "sample_at", required: true },
      { modelField: "capacityAh", sourceField: "discharge_capacity_in_Ah", required: true },
      { modelField: "chargeCapacityAh", sourceField: "charge_capacity_in_Ah", required: true },
    ]));
    expect(normalizeBatteryRecords([{ cycle_id: 3, sample_at: 10 }], assessment)[0]).toMatchObject({ cycle: 3, time: 10 });
  });

  it("requires an explicit nominal capacity for SOC", () => {
    const fields = ["time", "voltage", "current"].map((key) => ({ key, type: "number" }));
    expect(assessBatteryDataContract("socformer", fields).missing).toContain("额定容量 Ah（参数）");
    expect(assessBatteryDataContract("socformer", fields, { nominalCapacityProvided: true }).compatible).toBe(true);
  });
});
