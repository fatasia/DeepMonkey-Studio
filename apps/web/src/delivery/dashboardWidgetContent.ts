import type { DashboardDataWidgetNode, WidgetFrame } from "@bim-studio/contracts";
import type { Deep2dColor, Deep2dCommand, Deep2dDisplayListAtlas, Deep2dResource } from "@bim-studio/deep-engine";
import { DASHBOARD_CONTENT_INSET, lowerDashboardShape, parseHexColor } from "./dashboardShapeContent";
import { lowerDashboardText, lowerDashboardValueText } from "./dashboardTextContent";
import { buildTextGlyphRunCommands, type FrozenGlyphAtlasIdentity, type MeasuredLineGlyphs } from "./dashboardGlyphRun";
import { cssSrgbToLinearColor } from "./dashboardColor";

/** Web 运行时 widgetBackground 的默认值;编译必须与真实渲染一致,不允许臆造颜色。 */
const WIDGET_BACKGROUND_DEFAULT = "#172126";
const WIDGET_BACKGROUND_OPACITY_DEFAULT = 0.86;
const CHART_WIDGET_TYPES = new Set(["line", "area", "bar", "combo", "pie", "scatter", "radar",
  "funnel", "sankey", "sunburst", "treemap", "graph", "map", "wordcloud", "boxplot"]);
const TEXT_DATA_WIDGET_TYPES = new Set(["text", "value", "digital-flip", "liquid-fill",
  "progress", "status", "gauge"]);

export interface WidgetContentLowering {
  readonly resources: Deep2dResource[];
  /** 字形/图片图集资源,归显示列表顶层 `atlases`(与 path/font/image 资源分列)。 */
  readonly atlases: readonly Deep2dDisplayListAtlas[];
  readonly commands: Deep2dCommand[];
  readonly compiledFields: readonly string[];
  readonly reasons: readonly string[];
  /** false 表示该对象没有产出任何受支持像素,能力报告记 blocked。 */
  readonly contentCompiled: boolean;
}

/** 筛选选项文字的实测字形度量(P1-18 接线)。度量必须来自 P1-17 measure 或冻结字体目录;
 *  不注入时选项文字保持既有 deferred 登记,不产出任何文字像素。 */
export interface FilterOptionGlyphMetrics {
  readonly fontId: string;
  readonly fontSize: number;
  readonly color: Deep2dColor;
  readonly atlas: FrozenGlyphAtlasIdentity;
  /** 与选项等长;第 i 项为 undefined 表示该选项缺实测度量,该行文字退回 deferred。 */
  readonly measuredGlyphs: readonly (MeasuredLineGlyphs | undefined)[];
}

/**
 * 组件容器铬层(背景)与可几何化内容的第一批 lowering。
 * 文字、图表与数据绑定内容分别等 TextDocument(P1-18)与 ChartIR 组合通道,显式登记原因。
 */
export function lowerDashboardWidget(node: DashboardDataWidgetNode, bindingId: string, revision: number,
  optionGlyphs?: FilterOptionGlyphMetrics): WidgetContentLowering {
  const widget = node.widget;
  const resources: Deep2dResource[] = [], atlases: Deep2dDisplayListAtlas[] = [], commands: Deep2dCommand[] = [];
  const compiledFields = ["id", "frame", "zIndex", "widget.type"];
  // `visible` 只在作者显式声明时才算「已编译的字段」:省略该字段的节点不应假装编译了它,
  // 否则能力报告会把没写过的字段列进已编译清单。
  if (node.visible !== undefined) compiledFields.splice(3, 0, "visible");
  const reasons: string[] = [];
  const draw = (command: Deep2dCommand, resource?: Deep2dResource): void => {
    if (resource) resources.push(resource);
    commands.push(command);
  };
  let contentCompiled = false;
  if (node.visible !== false) {
    const background = containerBackground(widget.backgroundColor, widget.backgroundOpacity);
    if (background) {
      draw({ kind: "path", id: `${bindingId}.bg.draw`, pathId: `${bindingId}.bg`, zOrder: node.zIndex,
        transform: [1, 0, 0, 1, node.frame.x, node.frame.y], fill: background },
      { kind: "path", id: `${bindingId}.bg`, revision, verbs: rectangle(node.frame.width, node.frame.height) });
      compiledFields.push("widget.backgroundColor", "widget.backgroundOpacity");
    } else {
      reasons.push("容器背景需要解析后的十六进制颜色;CSS 变量与渐变尚未编译");
    }
    contentCompiled = lowerWidgetContent(node, bindingId, revision, draw, compiledFields, reasons, atlases, optionGlyphs);
  }
  // 已知未编译域统一登记:文字排版、数据绑定、阴影与运行时行为属于后续切片。
  reasons.push("组件文字排版、数据绑定内容、容器阴影与运行时行为尚未编译");
  return { resources, atlases, commands, compiledFields, reasons, contentCompiled };
}

function lowerWidgetContent(
  node: DashboardDataWidgetNode, bindingId: string, revision: number,
  draw: (command: Deep2dCommand, resource?: Deep2dResource) => void,
  compiledFields: string[], reasons: string[], atlases: Deep2dDisplayListAtlas[],
  optionGlyphs?: FilterOptionGlyphMetrics,
): boolean {
  const widget = node.widget;
  if (widget.type === "shape") {
    try {
      const shape = lowerDashboardShape(node);
      const id = `${bindingId}.content`;
      draw({ kind: "path", id: `${id}.draw`, pathId: id, zOrder: node.zIndex,
        transform: [1, 0, 0, 1, shape.x, shape.y], fill: shape.fill },
      { kind: "path", id, revision, verbs: shape.verbs });
      compiledFields.push("widget.shape", "widget.color", "widget.borderWidth");
      lowerShapeBorder(node, id, shape.x, shape.y, draw, compiledFields, reasons);
      if (widget.content) reasons.push("形状文字需要字体编译");
      if (widget.semanticBinding) reasons.push("语义绑定需要先解析为冻结组件快照");
      return true;
    } catch (error) {
      reasons.push(error instanceof Error ? error.message : String(error));
      return false;
    }
  }
  const box = contentBox(node.frame);
  if (!box) { reasons.push("组件内容框为空"); return false; }
  if (widget.type === "filter") {
    // G02 切片 1:筛选 chrome(选中高亮条为矢量可编译);选项文字走字形延迟通道(P1-18),原因如实登记。
    const options = (widget.options ?? []).slice(0, 16);
    if ((widget.options ?? []).length > 16) reasons.push("选项超过 16 项,首切片截断渲染");
    const inset = DASHBOARD_CONTENT_INSET;
    const rowHeight = Math.max(18, Math.floor((node.frame.height - inset * 2) / Math.max(options.length, 1)));
    options.forEach((_option, index) => {
      // G02 切片 2:每一行都保留真实几何命中区；透明行仍由 Native path hit index 命中，
      // hitId 只依赖作者 node id 与原始 option index，不依赖编译期 binding identity。
      const id = index === 0 ? `${bindingId}.option-selected` : `${bindingId}.option-${index}`;
      draw({ kind: "path", id: `${id}.draw`, pathId: id, zOrder: node.zIndex,
        transform: [1, 0, 0, 1, node.frame.x + inset, node.frame.y + inset + index * rowHeight],
        fill: index === 0 ? [0.84, 0.67, 0.30, 0.28] : [0, 0, 0, 0],
        hitId: `${node.id}:option:${index}` },
      { kind: "path", id, revision, verbs: rectangle(node.frame.width - inset * 2, rowHeight) });
      compiledFields.push("widget.options");
    });
    if (widget.filterMode) compiledFields.push("widget.filterMode");
    if (widget.title) compiledFields.push("widget.title");
    if (widget.parentFilterKey) reasons.push("父参数未编译:父参数就绪前该控件为禁用态,交互语义归 G01 宿主");
    compileFilterOptionGlyphRuns(node, bindingId, options, inset, rowHeight, optionGlyphs, draw, atlases, compiledFields, reasons);
    return options.length > 0;
  }
  if (CHART_WIDGET_TYPES.has(widget.type)) {
    reasons.push("图表内容经 ChartIR 动态通道编译,Dashboard 组合尚未接线");
    return false;
  }
  // 文字类组件只有 text 是纯作者文本:value 的数值、status 的信号、gauge/progress 的量程
  // 都要先解析数据绑定,把编译期未知的显示值编成静态文字就是臆造。
  // 两者目前都只解算样式/排版事实,不产出像素:字形运行(P1-18)未就绪时下发 text 命令
  // 会得到 native 拒收的伪支持产物(详见 dashboardTextContent 头注释)。
  const text = widget.type === "text" ? lowerDashboardText(node, revision)
    : widget.type === "value" ? lowerDashboardValueText(node) : null;
  if (text) {
    reasons.push(...text.reasons);
    return false;
  }
  if (TEXT_DATA_WIDGET_TYPES.has(widget.type)) {
    reasons.push("文字与数值内容等待 TextDocument/字体编译通道");
    return false;
  }
  if (widget.type === "decoration") { reasons.push("装饰样式为 CSS 效果,矢量翻译尚未编译"); return false; }
  reasons.push(`组件类型 ${widget.type} 尚无内容编译器`);
  return false;
}

/**
 * P1-18 接线:注入实测字形度量时,按行构造 `atlasId + bakedGlyphs` 字形运行命令(图集资源只
 * 登记一次);行原点取选项行框左上角,字形真实偏移全部由度量表携带,编译期不做任何字形估算。
 * 未注入度量(或缺某行度量)的行保持 deferred 登记,原因如实声明,不产出裸 text 命令。
 */
function compileFilterOptionGlyphRuns(
  node: DashboardDataWidgetNode, bindingId: string, options: readonly string[],
  inset: number, rowHeight: number, optionGlyphs: FilterOptionGlyphMetrics | undefined,
  draw: (command: Deep2dCommand, resource?: Deep2dResource) => void, atlases: Deep2dDisplayListAtlas[],
  compiledFields: string[], reasons: string[],
): void {
  if (!optionGlyphs) {
    reasons.push("选项文字等待字形图集通道(P1-18);筛选命中已编译,setFilter 消费归 G01 宿主");
    return;
  }
  const runs = buildTextGlyphRunCommands({
    commandIdPrefix: `${bindingId}.option`, zOrder: node.zIndex,
    lineOrigins: options.map((_option, index) => ({ x: node.frame.x + inset, y: node.frame.y + inset + index * rowHeight })),
    style: { fontId: optionGlyphs.fontId, fontSize: optionGlyphs.fontSize, color: optionGlyphs.color, align: "start" },
    atlas: optionGlyphs.atlas,
    lines: options.map((text) => ({ text, top: 0 })),
    // 度量表按选项数归一化:多余项截断、缺项补 undefined(该行退回 deferred)。
    measuredGlyphs: options.map((_option, index) => optionGlyphs.measuredGlyphs[index]),
  });
  if (runs.commands.length === 0) {
    reasons.push("筛选选项无可编译的文字行(空选项或缺实测字形度量),选项文字保持 deferred(P1-18)");
    return;
  }
  atlases.push(runs.atlas);
  for (const command of runs.commands) draw(command);
  compiledFields.push("widget.options.text");
  for (const index of options.keys()) {
    if (!runs.compiledLineIndexes.includes(index) && options[index]!.length > 0) {
      reasons.push(`选项 ${index} 缺实测字形度量,该行文字保持 deferred(P1-18)`);
    }
  }
  reasons.push("选项文字按实测字形运行编译;图集像素上传与 setFilter 交互消费归 G01 宿主,能力报告不因本片改记 supported");
}

/** 作者边框绘制在形状内容框上(CSS 内描语义);缺色或不可解析时跳过并登记,不猜颜色。 */
function lowerShapeBorder(
  node: DashboardDataWidgetNode, id: string, x: number, y: number,
  draw: (command: Deep2dCommand, resource?: Deep2dResource) => void,
  compiledFields: string[], reasons: string[],
): void {
  const borderWidth = node.widget.borderWidth ?? 0;
  if (borderWidth <= 0) return;
  if (!node.widget.borderColor) { reasons.push("边框宽度已编译,但缺少 borderColor"); return; }
  const border = parseHexColorLoose(node.widget.borderColor);
  if (!border) { reasons.push("边框颜色需要解析后的十六进制颜色"); return; }
  draw({ kind: "path", id: `${id}.stroke`, pathId: id, zOrder: node.zIndex,
    transform: [1, 0, 0, 1, x, y], stroke: border, strokeWidth: borderWidth });
  compiledFields.push("widget.borderColor");
}

function contentBox(frame: WidgetFrame) {
  const width = frame.width - DASHBOARD_CONTENT_INSET * 2, height = frame.height - DASHBOARD_CONTENT_INSET * 2;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function containerBackground(color: string | undefined, opacity: number | undefined): Deep2dColor | null {
  const parsed = parseHexColorLoose(color ?? WIDGET_BACKGROUND_DEFAULT);
  if (!parsed) return null;
  return [parsed[0], parsed[1], parsed[2], parsed[3] * (opacity ?? WIDGET_BACKGROUND_OPACITY_DEFAULT)];
}

function parseHexColorLoose(value: string): Deep2dColor | null {
  if (!/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(value)) return null;
  try { return cssSrgbToLinearColor(parseHexColor(value)); } catch { return null; }
}

function rectangle(width: number, height: number) {
  return [
    { op: "move" as const, x: 0, y: 0 }, { op: "line" as const, x: width, y: 0 },
    { op: "line" as const, x: width, y: height }, { op: "line" as const, x: 0, y: height }, { op: "close" as const },
  ];
}
