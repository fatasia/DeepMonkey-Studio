import { describe, expect, it } from "vitest";
import type { TopologyNode } from "@bim-studio/contracts";
import { createTopologyRuntimeFailure, createTopologyRuntimeSnapshot, groupTopologyRuntimeBindings, mergeTopologyRuntimeAcknowledgements } from "./topologyRuntime";

const nodes: TopologyNode[] = [
  {
    id: "pump-1",
    kind: "pump",
    x: 0,
    y: 0,
    properties: {
      label: "循环泵",
      dataBinding: { productType: "dataset", productId: "telemetry", field: "pressure" },
      scada: { tag: "P-101.PV", unit: "bar", highAlarm: 6, alarmSeverity: "critical" }
    }
  },
  {
    id: "meter-1",
    kind: "meter",
    x: 100,
    y: 0,
    properties: {
      dataBinding: { productType: "dataset", productId: "telemetry", field: "flow" },
      scada: { tag: "FT-101.PV", unit: "m³/h", alarmSeverity: "warning" }
    }
  },
  { id: "note-1", kind: "device", x: 0, y: 100, properties: { dataBinding: { productType: "dataset", productId: "ignored", field: "value" } } }
];

describe("topology runtime adapter", () => {
  it("groups SCADA bindings so one data product is fetched once", () => {
    expect(groupTopologyRuntimeBindings(nodes)).toEqual([{
      key: "dataset:telemetry",
      productType: "dataset",
      productId: "telemetry",
      nodes: nodes.slice(0, 2)
    }]);
  });

  it("maps product fields, timestamps, quality and thresholds into ephemeral SCADA state", () => {
    const result = createTopologyRuntimeSnapshot(nodes.slice(0, 2), {
      fields: [],
      rows: [{ pressure: 7.2, pressure_quality: "good", flow: 18, status: "online", timestamp: "2026-08-27T10:00:00.000Z" }]
    }, "2026-08-27T10:01:00.000Z");

    expect(result["pump-1"]).toMatchObject({ state: "alarm", value: 7.2, unit: "bar", quality: "good", updatedAt: "2026-08-27T10:00:00.000Z" });
    expect(result["pump-1"]?.alarm).toMatchObject({ id: "pump-1:high", active: true, severity: "critical" });
    expect(result["meter-1"]).toMatchObject({ state: "running", value: 18, unit: "m³/h" });
  });

  it("marks failed product reads offline without persisting runtime values", () => {
    expect(createTopologyRuntimeFailure(nodes.slice(0, 1), "2026-08-27T10:00:00.000Z")).toEqual({
      "pump-1": { state: "offline", quality: "bad", updatedAt: "2026-08-27T10:00:00.000Z" }
    });
  });

  it("keeps acknowledgement while the same alarm stays active and clears it after recovery", () => {
    const current = { "pump-1": { state: "alarm" as const, alarm: { id: "pump-1:high", active: true, severity: "critical" as const, message: "高压", acknowledged: true, acknowledgedAt: "2026-08-27T10:00:00.000Z", acknowledgedBy: "operator" } } };
    const same = { "pump-1": { state: "alarm" as const, alarm: { id: "pump-1:high", active: true, severity: "critical" as const, message: "仍然高压" } } };
    expect(mergeTopologyRuntimeAcknowledgements(current, same)["pump-1"]?.alarm).toMatchObject({ acknowledged: true, acknowledgedBy: "operator" });
    expect(mergeTopologyRuntimeAcknowledgements(current, { "pump-1": { state: "running" } })["pump-1"]?.alarm).toBeUndefined();
  });
});
