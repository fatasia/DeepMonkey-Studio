import type { AlarmRcaInput } from "./alarmRcaTypes.js";

export function thermalAlarmRcaCase(): AlarmRcaInput {
  return {
    schemaVersion: 1,
    asset: { id: "motor-1", name: "一号循环泵电机", type: "motor", criticality: "high" },
    alarm: { id: "alarm-1", code: "MOTOR_OVERHEAT", label: "电机温度过高", severity: "critical", triggeredAt: "2026-08-30T10:00:00Z", source: "plc-1" },
    window: { startAt: "2026-08-30T09:00:00Z", endAt: "2026-08-30T11:00:00Z" },
    anomalies: [
      { id: "temperature-high", assetId: "motor-1", signal: "bearing_temperature", label: "轴承温度", observedAt: "2026-08-30T09:58:00Z", direction: "high", deviationScore: 3.2, quality: "valid", qualityScore: .98, source: "historian", observedValue: 92, baselineValue: 60, unit: "°C" },
      { id: "current-high", assetId: "motor-1", signal: "phase_current", label: "相电流", observedAt: "2026-08-30T09:56:00Z", direction: "high", deviationScore: 2.5, quality: "valid", qualityScore: .95, source: "power-meter" },
      { id: "cooling-flow-low", assetId: "motor-1", signal: "cooling_flow", label: "冷却流量", observedAt: "2026-08-30T09:55:00Z", direction: "low", deviationScore: 2.8, quality: "valid", qualityScore: .9, source: "flow-meter" },
    ],
    events: [
      { id: "fan-trip", assetId: "motor-1", kind: "interlock", code: "COOLING_FAN_TRIP", label: "冷却风机跳闸", occurredAt: "2026-08-30T09:54:00Z", source: "plc-1", qualityScore: .95 },
    ],
    maintenanceHistory: [
      { id: "maint-1", assetId: "motor-1", category: "inspection", summary: "月度点检正常", status: "completed", startedAt: "2026-08-20T02:00:00Z", completedAt: "2026-08-20T03:00:00Z" },
    ],
  };
}
