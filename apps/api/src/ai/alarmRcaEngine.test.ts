import { describe, expect, it } from "vitest";
import { AlarmRcaInputError, analyzeAlarmRca, buildAlarmRcaExplanationEnvelope } from "./alarmRcaEngine.js";
import { thermalAlarmRcaCase as thermalCase } from "./alarmRcaTestFixtures.js";

describe("deterministic alarm RCA", () => {
  it("ranks evidence-backed candidates without claiming causality", () => {
    const result = analyzeAlarmRca(thermalCase());
    expect(result).toMatchObject({
      decisionStatus: "investigation-required", generatedBy: "deterministic-alarm-rca",
      workOrderDraft: { status: "draft", requiresConfirmation: true, closePolicy: "human-only", priority: "high" },
    });
    expect(result.candidates[0]).toMatchObject({ id: "thermal-load", rank: 1, status: "hypothesis" });
    expect(result.candidates[0]?.statement).toContain("不是因果结论");
    expect(result.candidates[0]?.evidence.map((item) => item.id)).toEqual(expect.arrayContaining(["temperature-high", "current-high", "fan-trip"]));
    expect(result.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns stable fingerprints for the same evidence and changes when evidence changes", () => {
    const input = thermalCase();
    const first = analyzeAlarmRca(input);
    const second = analyzeAlarmRca(structuredClone(input));
    const changed = analyzeAlarmRca({ ...input, anomalies: input.anomalies.map((item) => item.id === "temperature-high" ? { ...item, deviationScore: 4 } : item) });
    expect(first.evidenceFingerprint).toBe(second.evidenceFingerprint);
    expect(changed.evidenceFingerprint).not.toBe(first.evidenceFingerprint);
    expect(first.workOrderDraft.evidenceFingerprint).toBe(first.evidenceFingerprint);
  });

  it("excludes cross-asset and out-of-window records from scoring", () => {
    const input = thermalCase();
    input.anomalies.push({
      id: "foreign-vibration", assetId: "motor-2", signal: "vibration", label: "其他设备振动", observedAt: "2026-08-30T10:00:00Z",
      direction: "high", deviationScore: 10, quality: "valid", qualityScore: 1, source: "historian",
    });
    input.events.push({ id: "late-trip", kind: "interlock", code: "trip", label: "时间窗外跳闸", occurredAt: "2026-08-31T10:00:00Z", source: "plc" });
    const result = analyzeAlarmRca(input);
    expect(result.excludedRecordIds).toEqual(expect.arrayContaining(["foreign-vibration", "late-trip"]));
    expect(result.candidates.flatMap((item) => item.evidence.map((evidence) => evidence.id))).not.toContain("foreign-vibration");
  });

  it("degrades to insufficient data and still produces a human-owned draft", () => {
    const input = thermalCase();
    input.alarm = { ...input.alarm, code: "GENERIC", label: "一般告警", severity: "info" };
    input.events = [];
    input.anomalies = [];
    input.maintenanceHistory = [];
    const result = analyzeAlarmRca(input);
    expect(result).toMatchObject({ decisionStatus: "insufficient-data", confidence: 0, confidenceBand: "insufficient", candidates: [] });
    expect(result.missingEvidence).toEqual(expect.arrayContaining(["告警时间窗内没有有效过程测点异常", "设备没有可用维护历史"]));
    expect(result.workOrderDraft.closePolicy).toBe("human-only");
  });

  it("keeps optional AI limited to explanation of the frozen result", () => {
    const result = analyzeAlarmRca(thermalCase());
    const envelope = buildAlarmRcaExplanationEnvelope(result);
    expect(envelope.instructions).toContain("不得宣称因果");
    expect(envelope.instructions).toContain("不得");
    expect(envelope.evidenceFingerprint).toBe(result.evidenceFingerprint);
    expect(JSON.parse(envelope.input)).not.toHaveProperty("workOrderDraft");
  });

  it("rejects invalid windows, duplicate evidence and nonfinite measurements", () => {
    expect(() => analyzeAlarmRca({ ...thermalCase(), window: { startAt: "2026-09-01T00:00:00Z", endAt: "2026-08-01T00:00:00Z" } })).toThrow(AlarmRcaInputError);
    const duplicate = thermalCase();
    duplicate.events[0] = { ...duplicate.events[0]!, id: duplicate.anomalies[0]!.id };
    expect(() => analyzeAlarmRca(duplicate)).toThrow("ID 必须唯一");
    const invalid = thermalCase();
    invalid.anomalies[0] = { ...invalid.anomalies[0]!, deviationScore: Number.NaN };
    expect(() => analyzeAlarmRca(invalid)).toThrow("偏差或质量分无效");
  });

  it("uses invalid-quality measurements only as measurement-chain evidence", () => {
    const input = thermalCase();
    input.alarm = { ...input.alarm, code: "SENSOR_QUALITY", label: "温度信号质量无效" };
    input.anomalies = [{
      ...input.anomalies[0]!, id: "temperature-invalid", signal: "temperature_signal", label: "温度信号缺失",
      direction: "missing", quality: "invalid", qualityScore: 0,
    }];
    input.events = [{ id: "comm-timeout", kind: "communication", code: "TIMEOUT", label: "采集网关超时", occurredAt: "2026-08-30T09:59:00Z", source: "gateway" }];
    const result = analyzeAlarmRca(input);
    expect(result.candidates[0]?.id).toBe("sensor-communication");
    expect(result.candidates.find((item) => item.id === "thermal-load")?.evidence.map((item) => item.id) ?? []).not.toContain("temperature-invalid");
  });
});
