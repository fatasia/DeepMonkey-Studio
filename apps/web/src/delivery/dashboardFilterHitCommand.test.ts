import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetNode, JsonValue } from "@bim-studio/contracts";
import { dashboardFilterHitCommand, type DashboardFilterActivation } from "./dashboardFilterHitCommand";

function filterNode(overrides: Partial<DashboardDataWidgetNode> = {}): DashboardDataWidgetNode {
  return { id: "filter-a", kind: "data-widget", zIndex: 4, frame: { x: 20, y: 30, width: 200, height: 220 },
    widget: { type: "filter", title: "产线", key: "line", unit: "", options: ["全部", "一线", "二线"], filterMode: "select" },
    ...overrides } as DashboardDataWidgetNode;
}
const pointer = (patch: Partial<DashboardFilterActivation> = {}): DashboardFilterActivation => ({
  source: "pointer", nodeId: "filter-a", widgetKey: "line", hitId: "filter-a:option:1", ...patch,
} as DashboardFilterActivation);
const filters: Readonly<Record<string, JsonValue>> = {};

describe("dashboard filter hit command (G02 slice 2)", () => {
  it("maps pointer and activation keys to the same whitelisted setFilter command", () => {
    const node = filterNode();
    const expected = { ok: true, command: { kind: "setFilter", key: "line", value: "一线" } };
    expect(dashboardFilterHitCommand(node, pointer(), filters)).toEqual(expected);
    for (const key of ["Enter", " "]) {
      expect(dashboardFilterHitCommand(node, { ...pointer(), source: "key", key }, filters)).toEqual(expected);
    }
  });

  it("rejects foreign node and widget identities before producing a command", () => {
    const node = filterNode();
    expect(dashboardFilterHitCommand(node, pointer({ nodeId: "filter-b" }), filters)).toEqual({ ok: false, reason: "foreign-node" });
    expect(dashboardFilterHitCommand(node, pointer({ widgetKey: "other" }), filters)).toEqual({ ok: false, reason: "foreign-key" });
    expect(dashboardFilterHitCommand(node, pointer({ hitId: "filter-b:option:1" }), filters)).toEqual({ ok: false, reason: "foreign-node" });
  });

  it("rejects malformed, missing, negative, truncated and oversized option indices", () => {
    const node = filterNode();
    for (const hitId of ["filter-a", "filter-a:option:-1", "filter-a:option:1x", "filter-a:option:3"]) {
      const result = dashboardFilterHitCommand(node, pointer({ hitId }), filters);
      expect(result.ok).toBe(false);
    }
    const many = filterNode({ widget: { ...node.widget, options: Array.from({ length: 20 }, (_value, index) => `选项${index}`) } });
    expect(dashboardFilterHitCommand(many, pointer({ hitId: "filter-a:option:15" }), filters).ok).toBe(true);
    expect(dashboardFilterHitCommand(many, pointer({ hitId: "filter-a:option:16" }), filters)).toEqual({ ok: false, reason: "out-of-range" });
  });

  it("rejects hidden, parent-blocked and non-select controls", () => {
    expect(dashboardFilterHitCommand(filterNode({ visible: false }), pointer(), filters)).toEqual({ ok: false, reason: "hidden" });
    const parented = filterNode({ widget: { ...filterNode().widget, parentFilterKey: "region" } });
    const inactive: Array<JsonValue | undefined> = [undefined, null, "", [], "全部", "All", ["全部", "All"]];
    for (const parentValue of inactive) {
      const current = parentValue === undefined ? {} : { region: parentValue };
      expect(dashboardFilterHitCommand(parented, pointer(), current)).toEqual({ ok: false, reason: "parent-not-ready" });
    }
    expect(dashboardFilterHitCommand(parented, pointer(), Object.create({ region: "inherited" }) as Record<string, JsonValue>))
      .toEqual({ ok: false, reason: "parent-not-ready" });
    const active: JsonValue[] = ["华东", 0, false, ["全部", "华东"]];
    for (const parentValue of active) {
      expect(dashboardFilterHitCommand(parented, pointer(), { region: parentValue })).toMatchObject({ ok: true });
    }
    const multi = filterNode({ widget: { ...filterNode().widget, filterMode: "multi-select" } });
    expect(dashboardFilterHitCommand(multi, pointer(), filters)).toEqual({ ok: false, reason: "unsupported-mode" });
  });

  it("rejects non-activation keys without broadening the command whitelist", () => {
    const activation = { ...pointer(), source: "key" as const, key: "ArrowDown" };
    expect(dashboardFilterHitCommand(filterNode(), activation, filters)).toEqual({ ok: false, reason: "unsupported-key" });
  });
});
