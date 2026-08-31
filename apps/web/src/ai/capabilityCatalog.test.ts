import { describe, expect, it } from "vitest";
import type { CapabilityDescriptor } from "../api";
import { capabilityWorkspaceTask, capabilityWritePolicy, summarizeCapabilityCatalog } from "./capabilityCatalog";

function capability(id: string, label: string): CapabilityDescriptor {
  return {
    id,
    label,
    version: "1.0.0",
    kind: "analysis",
    execution: "in-process",
    permissions: [],
    timeoutMs: 1_000,
    inputSchemaVersion: "1.0",
    outputSchemaVersion: "1.0",
    inputSchema: {},
    outputSchema: {},
  };
}

describe("summarizeCapabilityCatalog", () => {
  it("keeps namespace breadth and removes invalid or duplicate descriptors", () => {
    const summary = summarizeCapabilityCatalog(
      [
        capability("maintenance.assess", "预测维护"),
        capability("battery.soh", "SOH 预测"),
        capability("maintenance.assess", "重复能力"),
        capability("", "无标识"),
      ],
      1,
    );

    expect(summary.total).toBe(2);
    expect(summary.visible.map((item) => item.id)).toEqual([
      "maintenance.assess",
    ]);
    expect(summary.hiddenCount).toBe(1);
    expect(summary.readOnlyCount).toBe(2);
    expect(summary.actionCount).toBe(0);
  });

  it("only links capabilities backed by an existing task workflow", () => {
    expect(capabilityWorkspaceTask("simulation.virtual-debug.run")).toEqual({
      workspace: "operations",
      tab: "commissioning",
    });
    expect(capabilityWorkspaceTask("battery.soh.predict")).toEqual({
      workspace: "operations",
      tab: "battery",
    });
    expect(capabilityWorkspaceTask("data.query.read")).toEqual({ workspace: "ask-data" });
    expect(capabilityWorkspaceTask("model.conversion.submit")).toBeUndefined();
  });

  it("requires confirmation only for state-changing capabilities", () => {
    expect(capabilityWritePolicy("query")).toBe("read-only");
    expect(capabilityWritePolicy("simulation")).toBe("read-only");
    expect(capabilityWritePolicy("action")).toBe("confirm-required");
  });
});
