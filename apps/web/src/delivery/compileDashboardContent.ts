import type { DashboardDocument } from "@bim-studio/contracts";
import { validateDeep2dDisplayList, type Deep2dCommand, type Deep2dDisplayList, type Deep2dDisplayListAtlas, type Deep2dResource } from "@bim-studio/deep-engine";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { compileDashboardLayout } from "./compileDashboardLayout";
import { DASHBOARD_LINE_HEIGHT_FACTOR } from "./dashboardTextContent";
import { lowerDashboardWidget } from "./dashboardWidgetContent";
import type { FilterGlyphBundle } from "./dashboardFilterGlyphs";

export interface DashboardContentObjectReport {
  readonly nodeId: string;
  readonly status: "degraded" | "blocked";
  /** 产出的受支持像素是否覆盖该组件的内容(而非仅容器铬层)。 */
  readonly contentCompiled: boolean;
  readonly compiledFields: readonly string[];
  readonly deferredFields: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * 内容 pass,不是发布批准:文字、图表组合、阴影与运行时行为仍是显式缺口,
 * 以对象级报告与 coverage 数字呈现,不用布尔 approved 概括。
 *
 * `optionGlyphs` 是 P1-18 筛选选项文字的唯一编译入口:只接受**实测**字形度量
 * (冻结字体目录经 native `--measure-glyph-run` 产出,见 dashboardFilterGlyphs),
 * 按 node id 注入。未注入或缺某组件度量的筛选保持 deferred fail-closed——
 * 这正是无冻结字体的发布形态,不是降级事故。
 */
export function compileDashboardContent(input: DashboardDocument, pageId = input.entryPageId,
  optionGlyphs?: Readonly<Record<string, FilterGlyphBundle>>) {
  const layout = compileDashboardLayout(input, pageId);
  const page = layout.source.application.pages.find(page => page.id === pageId)!;
  const resources: Deep2dResource[] = [], commands: Deep2dCommand[] = [], objects: DashboardContentObjectReport[] = [];
  const atlases: Deep2dDisplayListAtlas[] = [];
  for (const [index, node] of page.nodes.entries()) {
    const binding = layout.nodeBindings[index]!;
    if (node.kind !== "data-widget") {
      objects.push({ nodeId: node.id, status: "blocked", contentCompiled: false,
        compiledFields: ["id", "frame", "zIndex", "visible"],
        deferredFields: Object.keys(node).filter(field => field !== "id"),
        reasons: ["场景视口需要独立三维编译"] });
      continue;
    }
    // 度量束先登记字体资源(命令 fontId 要解析到它),再交给 widget 编译;
    // 隐藏节点没有文字命令,不登记闲置字体资源。
    const bundle = optionGlyphs?.[node.id];
    if (bundle && node.visible !== false) resources.push(bundle.fontResource);
    const lowering = lowerDashboardWidget(node, `${binding.layoutId}.content`, layout.tree.revision,
      bundle?.metrics);
    resources.push(...lowering.resources);
    atlases.push(...lowering.atlases);
    commands.push(...lowering.commands);
    objects.push({ nodeId: node.id, status: lowering.commands.length ? "degraded" : "blocked",
      contentCompiled: lowering.contentCompiled, compiledFields: lowering.compiledFields,
      deferredFields: deferred(node, lowering.compiledFields), reasons: lowering.reasons });
  }
  // 图集仅在存在时写入:legacy 显示列表(无 atlases 字段)保持逐字节不变,内容哈希不漂移。
  const displayList: Deep2dDisplayList = { schemaVersion: 1, id: `${layout.tree.id}.content`,
    revision: layout.tree.revision, logicalWidth: page.width, logicalHeight: page.height,
    scaleFactor: 1, resources, commands,
    ...(atlases.length > 0 ? { atlases } : {}) };
  const validation = validateDeep2dDisplayList(displayList);
  if (!validation.valid) throw new Error(`二维内容不符合显示合同：${validation.issues[0]?.message}`);
  const sourceSemanticHash = runtimeContentSha256(layout.source);
  const pass = { id: "dashboard-widget-content", version: 4, pageId,
    contentInset: 17, chromeDefaults: { background: "#172126", opacity: 0.86 },
    // v3:文字组件进入样式/排版解算,但字形运行未就绪,像素产出显式 deferred;
    // 文本折行宽度与行高为声明式口径(见 dashboardTextContent),不是实测结论。
    textPass: { glyphRun: "deferred", wrapWidth: "declared", lineHeightFactor: DASHBOARD_LINE_HEIGHT_FACTOR } };
  return { schemaVersion: 1 as const, scope: "dashboard-widget-content" as const, publicationReady: false as const,
    sourceSemanticHash, compileGraphHash: runtimeContentSha256({ sourceSemanticHash, pass }),
    targetArtifactHash: runtimeContentSha256(displayList), displayList,
    capabilityReport: { objects, degraded: objects.filter(object => object.status === "degraded").length,
      blocked: objects.filter(object => object.status === "blocked").length,
      contentCompiled: objects.filter(object => object.contentCompiled).length,
      chromeOnly: objects.filter(object => object.status === "degraded" && !object.contentCompiled).length },
    deferredPageFields: layout.deferredPageFields };
}

/**
 * 逐字段未编译清单。必须先汇总 node 与 widget 的全部字段再按已编译集合过滤:
 * 早先实现在过滤之后才追加 `widget.*`,导致 widget 侧被编译的字段虽然从 node 侧滤掉,
 * 其余 widget 字段(如 textColor/fontSize/textAlign)根本不进清单——能力报告会漏报缺口。
 */
function deferred(node: DashboardDocument["application"]["pages"][number]["nodes"][number], compiled: readonly string[]) {
  const fields = Object.keys(node).filter(field => field !== "widget");
  if (node.kind === "data-widget") fields.push(...Object.keys(node.widget).map(field => `widget.${field}`));
  return fields.filter(field => !compiled.includes(field));
}
