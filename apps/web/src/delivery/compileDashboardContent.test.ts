import { describe, expect, it } from "vitest";
import { assertDashboardDocument, type DashboardDataWidgetNode, type DashboardDocument } from "@bim-studio/contracts";
import { validateDeep2dDisplayList } from "@bim-studio/deep-engine";
import { readFileSync } from "node:fs";
import source from "../../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { compileDashboardContent } from "./compileDashboardContent";
import { filterGlyphBundle } from "./dashboardFilterGlyphs";

function fixture() {
  const input: unknown = structuredClone(source);
  assertDashboardDocument(input);
  const document: DashboardDocument = input;
  document.application.scripts = []; document.application.interactions = [];
  const shape: DashboardDataWidgetNode = { id: "shape", kind: "data-widget", zIndex: 3,
    frame: { x: 20, y: 30, width: 234, height: 134 },
    widget: { title: "形状", key: "shape", unit: "", type: "shape", shape: "rectangle", color: "#1234", borderWidth: 0 } };
  document.application.pages[0]!.nodes = [shape];
  return { document, shape };
}

describe("Dashboard widget content lowering", () => {
  it("rebuilds the same authored content golden used by Native", () => {
    const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../../packages/deep-engine/fixtures/${name}.json`, import.meta.url), "utf8"));
    const result = compileDashboardContent(read("dashboard-content-source-v1"));
    expect(result).toEqual(read("dashboard-content-v1"));
    const runtime = read("dashboard-content-runtime-v1");
    expect(runtime.payloads[runtime.entrypoints.deep2d].displayList).toEqual(result.displayList);
  });
  it("compiles container chrome under the shape content with real defaults", () => {
    const { document } = fixture(), result = compileDashboardContent(document);
    // 命令 0:容器背景(整框,Web 默认 #172126 @ 0.86);命令 1:形状内容填充(内容框)。
    expect(result.displayList.commands[0]).toMatchObject({ transform: [1, 0, 0, 1, 20, 30], zOrder: 3,
      fill: [0.008568125618069307, 0.01520851442291271, 0.019382360956935723, 0.86] });
    expect(result.displayList.commands[1]).toMatchObject({ transform: [1, 0, 0, 1, 37, 47], zOrder: 3,
      fill: [0.005605391624202723, 0.01599629336550963, 0.033104766570885055, 68 / 255] });
    expect(result.displayList.commands[0]!.id).not.toBe(result.displayList.commands[1]!.id);
    expect(result.publicationReady).toBe(false);
    expect(result.capabilityReport).toMatchObject({ degraded: 1, blocked: 0, contentCompiled: 1, chromeOnly: 0 });
    expect(result.capabilityReport.objects[0]!.deferredFields).toContain("widget.title");
    expect(result.capabilityReport.objects[0]!.reasons.join()).toContain("尚未编译");
  });
  it.each(["rounded", "ellipse"] as const)("keeps %s curves in vector IR", shapeType => {
    const { document, shape } = fixture(); shape.widget.shape = shapeType;
    const result = compileDashboardContent(document);
    expect(result.displayList.resources[1]).toMatchObject({ verbs: expect.arrayContaining([expect.objectContaining({ op: "cubic" })]) });
    expect(result.capabilityReport.blocked).toBe(0);
  });
  it("compiles an authored border as an inner stroke with explicit color", () => {
    const { document, shape } = fixture();
    shape.widget.borderWidth = 2; shape.widget.borderColor = "#ff0000";
    const result = compileDashboardContent(document);
    expect(result.displayList.commands[2]).toMatchObject({ kind: "path", pathId: `${result.displayList.resources[1]!.id}`,
      stroke: [1, 0, 0, 1], strokeWidth: 2, transform: [1, 0, 0, 1, 37, 47] });
    expect(result.capabilityReport.objects[0]!.compiledFields).toContain("widget.borderColor");
  });
  it("omits hidden pixels while preserving the object report and stable IDs", () => {
    const { document, shape } = fixture(), first = compileDashboardContent(document);
    shape.visible = false;
    const hidden = compileDashboardContent(document);
    expect(hidden.displayList.commands).toEqual([]); expect(hidden.displayList.resources).toEqual([]);
    expect(hidden.capabilityReport.objects).toHaveLength(1);
    shape.visible = true; shape.frame.x += 10;
    const moved = compileDashboardContent(document);
    expect(moved.displayList.commands[0]!.id).toBe(first.displayList.commands[0]!.id);
    expect(moved.targetArtifactHash).not.toBe(first.targetArtifactHash);
  });
  it.each([
    { color: "var(--accent)" }, { shape: "line" as const }, { type: "video" as const }, { type: "gauge" as const },
  ])("keeps chrome pixels but blocks or degrades unsupported content explicitly: %j", patch => {
    const { document, shape } = fixture(); Object.assign(shape.widget, patch);
    const result = compileDashboardContent(document);
    // 容器背景始终受支持;内容像素按类型明确缺位,原因逐字登记。
    expect(result.displayList.commands).toHaveLength(1);
    expect(result.capabilityReport.degraded + result.capabilityReport.blocked).toBe(1);
    expect(result.capabilityReport.contentCompiled).toBe(0);
    expect(result.capabilityReport.objects[0]!.reasons.length).toBeGreaterThan(0);
  });
  it("binds source semantics separately from target pixels and clones output", () => {
    const { document, shape } = fixture(), first = compileDashboardContent(document);
    shape.widget.title = "新标题";
    const next = compileDashboardContent(document);
    expect(next.sourceSemanticHash).not.toBe(first.sourceSemanticHash);
    expect(next.compileGraphHash).not.toBe(first.compileGraphHash);
    expect(next.targetArtifactHash).toBe(first.targetArtifactHash);
    shape.frame.width = 300;
    expect(first.displayList.resources[1]).toMatchObject({ verbs: expect.arrayContaining([{ op: "line", x: 200, y: 100 }]) });
  });
  it("reports each mixed node and refuses a collapsed content box", () => {
    const { document, shape } = fixture(); shape.frame.width = 30;
    const other: unknown = structuredClone(source); assertDashboardDocument(other);
    document.application.pages[0]!.nodes.push(other.application.pages[0]!.nodes[0]!);
    const result = compileDashboardContent(document);
    // 场景视口编译为 blocked(三维通道),塌缩内容框的形状仍产出容器背景。
    expect(result.capabilityReport.blocked).toBe(1);
    expect(result.capabilityReport.objects.map(object => object.nodeId)).toEqual(["shape", "widget-scene-main"]);
    expect(result.capabilityReport.objects[1]!.reasons[0]).toContain("三维");
  });
});

describe("Dashboard text content lowering", () => {
  /** 与 runtime/DashboardCanvasNode 的真实默认一致:text 28px/600、textColor 回退 #eef2f4。 */
  function textFixture(patch: Partial<DashboardDataWidgetNode["widget"]> = {}) {
    const document = fixture().document;
    // 字段集合对齐 `dashboardWorkspaceModel` 建组件时的真实出厂配置,而不是只写最小子集,
    // 否则 deferredFields 会因为「字段本来就不存在」而假绿。
    const node: DashboardDataWidgetNode = { id: "text", kind: "data-widget", zIndex: 5, visible: true,
      frame: { x: 20, y: 30, width: 234, height: 134 },
      widget: { title: "标题", key: "text", unit: "", type: "text", content: "告警文本",
        color: "#d4a84f", backgroundColor: "#172126", backgroundOpacity: 0.86,
        textColor: "#eef2f4", fontSize: 28, fontWeight: 600, textAlign: "left", ...patch } };
    document.application.pages[0]!.nodes = [node];
    return document;
  }
  const textCommand = (result: ReturnType<typeof compileDashboardContent>) =>
    result.displayList.commands.find(command => command.kind === "text");

  it("keeps text pixels out of the display list while the glyph run is missing", () => {
    const result = compileDashboardContent(textFixture());
    // 关键诚实边界:native validate_text 要求 atlasId+bakedGlyphs,裸 text 命令会被渲染前拒绝,
    // 因此这里绝不能产出「TS 通过、native 拒收」的伪支持产物。
    expect(textCommand(result)).toBeUndefined();
    expect(result.displayList.resources.some(resource => resource.kind === "font")).toBe(false);
    expect(result.capabilityReport.contentCompiled).toBe(0);
    expect(result.capabilityReport.chromeOnly).toBe(1);
    expect(result.capabilityReport.objects[0]!.reasons.join()).toContain("P1-18");
    expect(result.displayList.commands, "容器铬层仍然编译").toHaveLength(1);
  });

  it("reports text fields as deferred rather than compiled", () => {
    const result = compileDashboardContent(textFixture());
    const report = result.capabilityReport.objects[0]!;
    // 只有身份字段与容器铬层字段算编译;文字样式/内容,以及不驱动像素的编辑器元数据一律 deferred。
    expect(report.compiledFields).toEqual(["id", "frame", "zIndex", "visible", "widget.type",
      "widget.backgroundColor", "widget.backgroundOpacity"]);
    expect(report.deferredFields).toEqual(["kind", "widget.title", "widget.key", "widget.unit",
      "widget.content", "widget.color", "widget.textColor", "widget.fontSize", "widget.fontWeight", "widget.textAlign"]);
    for (const field of ["widget.content", "widget.textColor", "widget.fontSize", "widget.fontWeight", "widget.textAlign"]) {
      expect(report.compiledFields).not.toContain(field);
    }
  });

  it("still degrades unsupported text details explicitly", () => {
    const cssVariable = compileDashboardContent(textFixture({ textColor: "var(--accent)" }));
    expect(cssVariable.capabilityReport.objects[0]!.reasons.join()).toContain("已解算为默认色");
    const animated = compileDashboardContent(textFixture({ animation: "fade" }));
    expect(animated.capabilityReport.objects[0]!.reasons.join()).toContain("CSS 关键帧");
  });

  it("reports empty and collapsed text widgets with distinct reasons", () => {
    const empty = compileDashboardContent(textFixture({ content: "" }));
    expect(empty.capabilityReport.objects[0]!.reasons.join()).toContain("空文本");
    const document = textFixture(); document.application.pages[0]!.nodes[0]!.frame.width = 30;
    const collapsed = compileDashboardContent(document);
    expect(collapsed.capabilityReport.objects[0]!.reasons.join()).toContain("内容框为空");
  });

  it("compiles the value widget chrome only and refuses to invent the bound number", () => {
    const result = compileDashboardContent(textFixture({ type: "value", title: "有功功率", unit: "MW" }));
    expect(textCommand(result)).toBeUndefined();
    const reasons = result.capabilityReport.objects[0]!.reasons.join();
    expect(reasons).toContain("数据绑定");
    expect(reasons).toContain("P1-18");
    expect(result.capabilityReport.contentCompiled).toBe(0);
  });

  it("keeps a collapsed value frame reported instead of throwing", () => {
    const document = textFixture({ type: "value" });
    document.application.pages[0]!.nodes[0]!.frame.height = 20;
    const result = compileDashboardContent(document);
    expect(result.capabilityReport.objects[0]!.reasons.join()).toContain("内容框为空");
  });
});

describe("Dashboard filter option glyph runs (P1-18)", () => {
  const OPTIONS = ["华东", "华南", "华北"];

  function filterFixture(patch: Partial<DashboardDataWidgetNode["widget"]> = {}) {
    const document = fixture().document;
    const node: DashboardDataWidgetNode = { id: "filter", kind: "data-widget", zIndex: 6, visible: true,
      frame: { x: 20, y: 30, width: 234, height: 134 },
      widget: { title: "区域筛选", key: "region", unit: "", type: "filter", options: [...OPTIONS],
        filterMode: "select", textColor: "#eef2f4", fontSize: 14, ...patch } };
    document.application.pages[0]!.nodes = [node];
    return document;
  }

  const font = { kind: "font" as const, id: "font:filter-test:400:normal", revision: 1,
    assetId: "filter-test", family: "Test Sans", weight: 400, style: "normal" as const };
  /** 结构与 native measure 产物一致的合成实测:每簇 24px 前进、20×20 图集盒。 */
  function measuredOptions(options: readonly string[]) {
    const atlas = { width: 256, height: 64 };
    return {
      schema: "deep-engine.glyph-measure-result", schemaVersion: 1,
      producer: "cosmic-text-0.19.0-frozen-v1", sourceSha256: "0".repeat(64),
      atlas: { ...atlas, format: "r8unorm", dataBase64: "AAAA", coverageSha256: "0".repeat(64) },
      lines: options.map(text => ({
        text, layoutWidth: text.length * 24,
        glyphs: Array.from(text).map((_char, index) => ({
          cluster: index, source: [index * 24, 0, 20, 20] as const,
          destination: [index * 24, 3, 20, 20] as const,
        })),
      })),
    };
  }
  const bundle = (options: readonly string[] = OPTIONS) => filterGlyphBundle({
    measure: measuredOptions(options), fontResource: font, fontSize: 14,
    textColor: "#eef2f4", atlasId: "atlas:filter", atlasRevision: 3,
  });

  it("keeps option text deferred when no measured glyphs are injected", () => {
    const result = compileDashboardContent(filterFixture());
    expect(result.displayList.commands.filter(command => command.kind === "text")).toHaveLength(0);
    expect(result.displayList.atlases ?? []).toHaveLength(0);
    expect(result.capabilityReport.objects[0]!.compiledFields).not.toContain("widget.options.text");
    expect(result.capabilityReport.objects[0]!.reasons.join()).toContain("等待字形图集通道(P1-18)");
  });

  it("compiles measured option rows into baked glyph runs end to end", () => {
    const result = compileDashboardContent(filterFixture(), undefined, { filter: bundle() });
    const textCommands = result.displayList.commands.filter(command => command.kind === "text");
    expect(textCommands).toHaveLength(OPTIONS.length);
    expect(textCommands[0]).toMatchObject({ text: "华东", atlasId: "atlas:filter",
      fontId: font.id, fontSize: 14, baseline: "top",
      bakedGlyphs: expect.arrayContaining([expect.objectContaining({ cluster: 0 })]) });
    expect(result.displayList.atlases).toHaveLength(1);
    expect(result.displayList.atlases?.[0]).toMatchObject({ id: "atlas:filter", kind: "glyph", format: "r8unorm" });
    expect(result.displayList.resources.some(resource => resource.kind === "font" && resource.id === font.id)).toBe(true);
    expect(result.capabilityReport.objects[0]!.compiledFields).toContain("widget.options.text");
    expect(result.capabilityReport.objects[0]!.reasons.join()).toContain("实测字形运行");
    // 编译函数内部已跑 validateDeep2dDisplayList;此处显式复核图集与命令互指。
    const validation = validateDeep2dDisplayList(result.displayList);
    expect(validation.valid).toBe(true);
  });

  it("defers only the rows that lack measured glyphs and reports them", () => {
    const partial = measuredOptions(OPTIONS);
    (partial.lines[1] as { glyphs: unknown[] }).glyphs = [];
    const result = compileDashboardContent(filterFixture(), undefined,
      { filter: filterGlyphBundle({ measure: partial, fontResource: font, fontSize: 14,
        textColor: "#eef2f4", atlasId: "atlas:filter", atlasRevision: 3 }) });
    const textCommands = result.displayList.commands.filter(command => command.kind === "text");
    expect(textCommands.map(command => (command as { text: string }).text)).toEqual(["华东", "华北"]);
    expect(result.capabilityReport.objects[0]!.reasons.join()).toContain("选项 1 缺实测字形度量");
  });

  it("rejects a metrics injection whose structure is not native-measured output", () => {
    const broken = measuredOptions(OPTIONS) as Record<string, unknown>;
    broken.schema = "deep-engine.text-raster-result";
    expect(() => filterGlyphBundle({ measure: broken, fontResource: font, fontSize: 14,
      textColor: "#eef2f4", atlasId: "atlas:filter", atlasRevision: 3 })).toThrow(/筛选字形度量被拒绝/);
    const outOfAtlas = measuredOptions(OPTIONS);
    outOfAtlas.lines[0]!.glyphs[0]!.source = [250, 0, 20, 20];
    expect(() => filterGlyphBundle({ measure: outOfAtlas, fontResource: font, fontSize: 14,
      textColor: "#eef2f4", atlasId: "atlas:filter", atlasRevision: 3 })).toThrow(/图集内正面积/);
  });
});
