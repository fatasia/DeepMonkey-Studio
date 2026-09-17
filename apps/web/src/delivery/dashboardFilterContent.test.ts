import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig, DashboardDataWidgetNode } from "@bim-studio/contracts";
import {
  DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, validateDeep2dDisplayList, type Deep2dDisplayList,
} from "@bim-studio/deep-engine";
import { lowerDashboardWidget } from "./dashboardWidgetContent";
import type { FilterOptionGlyphMetrics } from "./dashboardWidgetContent";
import { fontIdentity } from "./dashboardTextContent";
import type { MeasuredLineGlyphs } from "./dashboardGlyphRun";

function filterNode(overrides: Partial<DashboardDataWidgetConfig> = {}): DashboardDataWidgetNode {
  return { id: "filter-a", kind: "data-widget", zIndex: 4, frame: { x: 20, y: 30, width: 200, height: 220 },
    widget: { type: "filter", title: "产线", key: "line", unit: "",
      options: ["一线", "二线", "三线"], filterMode: "select", ...overrides } } as DashboardDataWidgetNode;
}

const OPTION_TEXTS = ["一线", "二线", "三线"];
const atlas = { id: "atlas:filter", revision: 2, width: 256, height: 64, dataBase64: "AAAA" };
const font = fontIdentity(3, 400, "normal");

function measured(text: string): MeasuredLineGlyphs {
  return { text, glyphs: Array.from(text).map((_char, index) => ({
    cluster: index, source: [index * 14, 0, 14, 14] as const, destination: [index * 14, 2, 14, 14] as const })) };
}

function optionGlyphs(patch: Partial<FilterOptionGlyphMetrics> = {}): FilterOptionGlyphMetrics {
  return {
    fontId: font.id, fontSize: 14, color: [0xee / 255, 0xf2 / 255, 0xf4 / 255, 1], atlas,
    measuredGlyphs: OPTION_TEXTS.map(measured), ...patch,
  };
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

describe("filter option glyph runs (P1-18 wiring)", () => {
  it("emits baked-glyph text commands when measured metrics are injected, validator-clean end to end", () => {
    const lowering = lowerDashboardWidget(filterNode(), "flt", 3, optionGlyphs());
    const textCommands = lowering.commands.filter(command => command.kind === "text");
    expect(textCommands).toHaveLength(3);
    expect(textCommands[0]).toMatchObject({
      kind: "text", id: "flt.option.line0", atlasId: atlas.id, fontId: font.id,
    });
    expect(textCommands[0]!.bakedGlyphs).toEqual([
      { cluster: 0, source: [0, 0, 14, 14], destination: [0, 2, 14, 14] },
      { cluster: 1, source: [14, 0, 14, 14], destination: [14, 2, 14, 14] },
    ]);
    // 图集资源恰好登记一次,且归显示列表顶层 atlases(与 path/font/image 资源分列);
    // 选项行命中区仍是 path 命令,不因文字新增 hit。
    expect(lowering.atlases).toEqual([{ kind: "glyph", format: "r8unorm", sampling: "nearest", ...atlas }]);
    expect(lowering.resources.filter(resource => resource.id === atlas.id)).toHaveLength(0);
    expect(lowering.commands.filter(command => command.hitId === "filter-a:option:2")).toHaveLength(1);
    expect(lowering.compiledFields).toContain("widget.options.text");
    expect(lowering.reasons.join()).toContain("按实测字形运行编译");
    expect(lowering.reasons.join()).not.toContain("等待字形图集通道");
    expect(lowering.contentCompiled).toBe(true);
    const displayList: Deep2dDisplayList = {
      schemaVersion: DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, id: "dashboard:filter", revision: 3,
      logicalWidth: 1280, logicalHeight: 720, scaleFactor: 1,
      resources: [...lowering.resources, font], atlases: lowering.atlases, commands: lowering.commands,
    };
    const validation = validateDeep2dDisplayList(displayList);
    expect(validation.issues).toEqual([]);
    expect(validation.valid).toBe(true);
  });

  it("keeps unmeasured rows deferred with per-row reasons instead of emitting bare text", () => {
    const partial = optionGlyphs({ measuredGlyphs: [measured("一线"), undefined, measured("三线")] });
    const lowering = lowerDashboardWidget(filterNode(), "flt", 3, partial);
    expect(lowering.commands.filter(command => command.kind === "text")).toHaveLength(2);
    expect(lowering.reasons.join()).toContain("选项 1 缺实测字形度量");
    expect(lowering.reasons.join()).not.toContain("选项 0 缺实测字形度量");
  });

  it("stays fully deferred when no metrics are injected at all", () => {
    const lowering = lowerDashboardWidget(filterNode({ options: [] }), "flt", 3, optionGlyphs());
    expect(lowering.commands.filter(command => command.kind === "text")).toHaveLength(0);
    expect(lowering.reasons.join()).toContain("无可编译的文字行");
    const unmeasured = lowerDashboardWidget(filterNode(), "flt", 3);
    expect(unmeasured.commands.filter(command => command.kind === "text")).toHaveLength(0);
    expect(unmeasured.reasons.join()).toContain("选项文字等待字形图集通道(P1-18)");
  });
});
