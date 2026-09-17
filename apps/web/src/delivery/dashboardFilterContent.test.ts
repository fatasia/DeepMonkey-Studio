import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig, DashboardDataWidgetNode } from "@bim-studio/contracts";
import { lowerDashboardWidget } from "./dashboardWidgetContent";

function filterNode(overrides: Partial<DashboardDataWidgetConfig> = {}): DashboardDataWidgetNode {
  return { id: "filter-a", kind: "data-widget", zIndex: 4, frame: { x: 20, y: 30, width: 200, height: 220 },
    widget: { type: "filter", title: "产线", key: "line", unit: "",
      options: ["一线", "二线", "三线"], filterMode: "select", ...overrides } } as DashboardDataWidgetNode;
}

describe("filter widget chrome lowering (G02 slice 1)", () => {
  it("compiles the selected-option highlight as vector chrome and declares filter fields", () => {
    const lowering = lowerDashboardWidget(filterNode(), "flt", 3);
    expect(lowering.contentCompiled).toBe(true);
    const highlight = lowering.commands.find(command => command.id === "flt.option-selected.draw");
    expect(highlight).toBeDefined();
    expect(lowering.commands.map(command => command.hitId).filter(Boolean)).toEqual([
      "filter-a:option:0", "filter-a:option:1", "filter-a:option:2",
    ]);
    expect(lowerDashboardWidget(filterNode(), "another-binding", 4).commands
      .map(command => command.hitId).filter(Boolean)).toEqual([
        "filter-a:option:0", "filter-a:option:1", "filter-a:option:2",
      ]);
    expect(lowering.compiledFields).toEqual(expect.arrayContaining(["widget.options", "widget.filterMode", "widget.title"]));
    // 选项文字等待字形通道,原因如实登记而非静默
    expect(lowering.reasons.join()).toContain("P1-18");
  });

  it("fails honestly with empty options and truncates beyond 16", () => {
    const empty = lowerDashboardWidget(filterNode({ options: [] }), "flt", 3);
    expect(empty.contentCompiled).toBe(false);
    // 容器背景照常编译;无选项则没有选中高亮
    expect(empty.commands.some(command => command.id === "flt.option-selected.draw")).toBe(false);
    const many = lowerDashboardWidget(filterNode({ options: Array.from({ length: 20 }, (_value, index) => `选项${index}`) }), "flt", 3);
    expect(many.reasons.join()).toContain("超过 16 项");
    expect(many.compiledFields.filter(field => field === "widget.options").length).toBe(16);
    expect(many.commands.filter(command => command.hitId).at(-1)?.hitId).toBe("filter-a:option:15");
  });

  it("records the parent-parameter disabled state instead of pretending it is interactive", () => {
    const gated = lowerDashboardWidget(filterNode({ parentFilterKey: "region" }), "flt", 3);
    expect(gated.reasons.join()).toContain("父参数");
  });

  it("locks transparent option rows to the existing Deep2D filled-path hit contract", () => {
    const lowering = lowerDashboardWidget(filterNode(), "flt", 3);
    const unselected = lowering.commands.find(command => command.hitId === "filter-a:option:1");
    // Deep2D path hit index treats fill presence as hit geometry and content_hit gates command opacity,
    // not fill alpha. There is no hit-only primitive yet, so alpha-zero fill is the explicit slice boundary.
    expect(unselected).toMatchObject({ kind: "path", fill: [0, 0, 0, 0], hitId: "filter-a:option:1" });
    expect(unselected).not.toHaveProperty("opacity");
  });
});
