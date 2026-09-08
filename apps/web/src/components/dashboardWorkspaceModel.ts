import {
  DASHBOARD_PAGE_MAX_SIZE,
  DASHBOARD_PAGE_MIN_SIZE,
  type ApplicationDocument,
  type DashboardDataWidgetConfig,
  type DashboardPageDocument,
  type JsonValue,
  type SceneDashboardWidgetType,
  type WidgetFrame,
  type WidgetNode,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

/* 大屏工作区的纯数据模型与几何计算，避免把渲染组件和编辑算法混在一起。 */
export const DATA_WIDGET_TYPES: SceneDashboardWidgetType[] = [
  "text",
  "shape",
  "decoration",
  "value",
  "digital-flip",
  "liquid-fill",
  "progress",
  "status",
  "gauge",
  "line",
  "area",
  "bar",
  "combo",
  "pie",
  "scatter",
  "radar",
  "funnel",
  "sankey",
  "sunburst",
  "treemap",
  "graph",
  "map",
  "rank",
  "table",
  "scroll-table",
  "filter",
  "record-form",
  "image",
  "video",
  "monitor",
  "url",
  "unity",
  "topology",
];
export const DATA_WIDGET_CATEGORIES: Array<{ id: string; zh: string; en: string; types: SceneDashboardWidgetType[] }> = [
  {
    id: "analysis",
    zh: "图表",
    en: "Charts",
    types: ["line", "area", "bar", "combo", "pie", "scatter", "radar", "funnel", "gauge", "sankey", "sunburst", "treemap", "graph", "map"],
  },
  { id: "indicator", zh: "指标与表格", en: "Metrics & tables", types: ["value", "digital-flip", "liquid-fill", "progress", "status", "rank", "table", "scroll-table"] },
  { id: "control", zh: "筛选与内容", en: "Controls & content", types: ["filter", "record-form", "text", "shape", "decoration"] },
  { id: "media", zh: "媒体与扩展", en: "Media & extensions", types: ["image", "video", "monitor", "url", "unity", "topology"] },
];
export const DECORATION_ASSETS: Array<{ style: NonNullable<DashboardDataWidgetConfig["decorationStyle"]>; zh: string; en: string }> = [
  { style: "title", zh: "双翼标题", en: "Wing title" },
  { style: "header-wing", zh: "机械标题", en: "Mechanical title" },
  { style: "border", zh: "科技边框", en: "Tech border" },
  { style: "frame-notch", zh: "缺口边框", en: "Notched frame" },
  { style: "corner", zh: "直角边框", en: "Corner frame" },
  { style: "bracket", zh: "括号边框", en: "Bracket frame" },
  { style: "neon", zh: "霓虹光框", en: "Neon frame" },
  { style: "scan", zh: "扫描光框", en: "Scanning frame" },
  { style: "divider", zh: "渐变分割线", en: "Gradient divider" },
  { style: "segment", zh: "分段线", en: "Segment divider" },
  { style: "dots", zh: "点阵线", en: "Dot divider" },
  { style: "diagonal", zh: "斜纹线", en: "Stripe divider" },
];

export function dataWidgetTypeLabel(locale: AppLocale, type: SceneDashboardWidgetType): string {
  const labels: Record<SceneDashboardWidgetType, [string, string]> = {
    text: ["文本", "Text"],
    shape: ["形状", "Shape"],
    decoration: ["装饰", "Decoration"],
    value: ["指标卡", "Metric"],
    "digital-flip": ["数字翻牌", "Digital flip"],
    "liquid-fill": ["液位水球", "Liquid level"],
    progress: ["进度条", "Progress"],
    gauge: ["仪表盘", "Gauge"],
    status: ["状态卡", "Status"],
    line: ["折线图", "Line"],
    area: ["面积图", "Area"],
    bar: ["柱状图", "Bar"],
    combo: ["双轴组合图", "Dual-axis combo"],
    pie: ["饼/环图", "Pie / donut"],
    scatter: ["散点图", "Scatter"],
    radar: ["雷达图", "Radar"],
    funnel: ["漏斗图", "Funnel"],
    sankey: ["桑基图", "Sankey"],
    sunburst: ["旭日图", "Sunburst"],
    treemap: ["矩形树图", "Treemap"],
    graph: ["关系图", "Graph"],
    map: ["地图", "Map"],
    rank: ["排行列表", "Ranking"],
    table: ["明细表", "Table"],
    "scroll-table": ["滚动表格", "Scrolling table"],
    filter: ["筛选器", "Filter"],
    "record-form": ["填报表单", "Record form"],
    image: ["图片", "Image"],
    video: ["视频", "Video"],
    monitor: ["实时监控", "Monitor"],
    url: ["网页", "Web page"],
    unity: ["Unity 场景", "Unity scene"],
    topology: ["拓扑", "Topology"],
  };
  return tr(locale, ...labels[type]);
}
export function canSelectDataWidgetType(type: SceneDashboardWidgetType, widget: DashboardDataWidgetConfig): boolean {
  return type !== "record-form" || !(widget.pipelineId || widget.directBinding || widget.sampleData || widget.semanticBinding);
}
export const DASHBOARD_RESOLUTION_PRESETS = [
  { id: "fhd", width: 1920, height: 1080, label: "Full HD · 1920 × 1080" },
  { id: "ultrawide", width: 3840, height: 1080, label: "双联大屏 · 3840 × 1080" },
  { id: "4k", width: 3840, height: 2160, label: "4K · 3840 × 2160" },
] as const;
export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ActiveSnapLines {
  x: number[];
  y: number[];
}
export interface DashboardContextMenuState {
  x: number;
  y: number;
  nodeId: string;
  /** 右键点下方全部遮挡组件 id（含被遮者），zIndex 降序；供"选择"子菜单切换（EX-001A）。 */
  stack?: string[];
}
export type InspectorTab = "content" | "data" | "style" | "animation" | "interaction";
export const RULER_SIZE = 24;
export const CANVAS_MARGIN = 72;
export const SNAP_THRESHOLD_PX = 6;
export const TEMPLATE_FAVORITES_KEY = "bim-studio.dashboard-template-favorites";

export function dashboardNodeLabel(node: WidgetNode): string {
  return node.name ?? (node.kind === "scene-viewport" ? `3D · ${node.sceneId}` : node.widget.title);
}

export function dashboardNodeIdentity(node: WidgetNode): string {
  return node.name?.trim() || (node.kind === "scene-viewport" ? `3D · ${node.sceneId}` : node.widget.title.trim()) || node.id;
}

export function uniqueDashboardNodeName(base: string, usedNames: ReadonlySet<string>): string {
  const normalizedBase = base.trim() || "Component";
  if (!usedNames.has(normalizedBase.toLocaleLowerCase())) return normalizedBase;
  let suffix = 2;
  while (usedNames.has(`${normalizedBase} ${suffix}`.toLocaleLowerCase())) suffix += 1;
  return `${normalizedBase} ${suffix}`;
}

/** 插入目录资源后沿用用户刚看到的资源名，避免图层树退化为大量“指标卡/折线图”。 */
export function dashboardInsertedNodeName(
  locale: AppLocale,
  type: SceneDashboardWidgetType,
  widget: Partial<DashboardDataWidgetConfig>,
  nameHint: string | undefined,
  existingNodes: readonly WidgetNode[],
): string {
  const base = nameHint?.trim() || widget.title?.trim() || dataWidgetTypeLabel(locale, type);
  return uniqueDashboardNodeName(base, new Set(existingNodes.map((node) => dashboardNodeIdentity(node).toLocaleLowerCase())));
}

export function normalizeDashboardSize(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(DASHBOARD_PAGE_MAX_SIZE, Math.max(DASHBOARD_PAGE_MIN_SIZE, Math.round(value)));
}

export function dashboardSceneName(application: ApplicationDocument, sceneId: string): string {
  return application.scenes.find((scene) => scene.id === sceneId)?.name ?? sceneId;
}

export function createDefaultDataWidget(locale: AppLocale, type: SceneDashboardWidgetType): DashboardDataWidgetConfig {
  const media = type === "image" || type === "video" || type === "monitor" || type === "url" || type === "unity";
  const staticWidget = type === "text" || type === "shape" || type === "decoration";
  return {
    title: dataWidgetTypeLabel(locale, type),
    key: media || staticWidget || type === "topology" ? "" : "value",
    type,
    unit: "",
    color: "#d4a84f",
    backgroundColor: "#172126",
    backgroundOpacity: 0.86,
    ...(type === "text" ? { content: tr(locale, "文本内容", "Text content"), fontSize: 28, fontWeight: 600, textAlign: "left" as const, backgroundOpacity: 0 } : {}),
    ...(type === "shape" ? { shape: "rounded" as const, content: "", color: "#d4a84f", borderColor: "#f0cd78", borderWidth: 1, backgroundOpacity: 0 } : {}),
    ...(type === "decoration" ? { decorationStyle: "title" as const, content: tr(locale, "看板标题", "Dashboard title"), backgroundOpacity: 0 } : {}),
    ...(type === "filter" ? { options: [tr(locale, "全部", "All"), tr(locale, "正常", "Normal"), tr(locale, "告警", "Alarm")] } : {}),
    ...(type === "record-form" ? { recordForm: { recordId: "" }, backgroundOpacity: 0 } : {}),
    ...(type === "gauge" || type === "liquid-fill" ? { min: 0, max: 100 } : {}),
    ...(type === "digital-flip" ? { fontSize: 38, fontWeight: 700, textColor: "#eef2f4" } : {}),
    ...(type === "scroll-table" ? { report: { mode: "detail" as const, pageSize: 6 } } : {}),
    ...(type === "image" ? { imageFit: "cover" as const } : {}),
    ...(type === "video" ? { videoFit: "contain" as const, videoAutoplay: true, videoMuted: true, videoLoop: true } : {}),
    ...(type === "monitor" ? { monitorProtocol: "hls" as const, videoFit: "cover" as const, videoAutoplay: true, videoMuted: true, videoLoop: true } : {}),
    ...(type === "url" ? { url: "https://example.com" } : {}),
    ...(type === "unity" ? { unityUrl: "", unityVersion: "", unityBridgeVersion: 1, unityScenes: [], unityEventNames: [] } : {}),
  };
}

export interface DashboardRuntimeViewport {
  scaleX: number;
  scaleY: number;
  stageWidth: number;
  stageHeight: number;
  offsetX: number;
  offsetY: number;
}

export type DashboardEditorFocusMode = "smart" | "page" | "content";

export interface DashboardEditorFocus {
  zoom: number;
  centerX: number;
  centerY: number;
  target: "page" | "content";
}

type DashboardFocusNode = Pick<WidgetNode, "frame" | "visible"> & {
  kind?: WidgetNode["kind"];
  widget?: Pick<DashboardDataWidgetConfig, "type">;
};

export function calculateDashboardRuntimeViewport(
  page: Pick<DashboardPageDocument, "width" | "height" | "viewportFit">,
  surfaceWidth: number,
  surfaceHeight: number,
): DashboardRuntimeViewport {
  const availableWidth = Math.max(1, surfaceWidth);
  const availableHeight = Math.max(1, surfaceHeight);
  const widthScale = availableWidth / page.width;
  const heightScale = availableHeight / page.height;
  if (page.viewportFit === "stretch") {
    return { scaleX: widthScale, scaleY: heightScale, stageWidth: availableWidth, stageHeight: availableHeight, offsetX: 0, offsetY: 0 };
  }
  if (page.viewportFit === "fixed") {
    return { scaleX: 1, scaleY: 1, stageWidth: page.width, stageHeight: page.height, offsetX: 0, offsetY: 0 };
  }
  const scale = Math.max(0.01, page.viewportFit === "cover" ? Math.max(widthScale, heightScale) : Math.min(widthScale, heightScale));
  const scaledWidth = page.width * scale;
  const scaledHeight = page.height * scale;
  return page.viewportFit === "cover"
    ? {
        scaleX: scale,
        scaleY: scale,
        stageWidth: availableWidth,
        stageHeight: availableHeight,
        offsetX: (availableWidth - scaledWidth) / 2,
        offsetY: (availableHeight - scaledHeight) / 2,
      }
    : { scaleX: scale, scaleY: scale, stageWidth: scaledWidth, stageHeight: scaledHeight, offsetX: 0, offsetY: 0 };
}

export function calculateDashboardEditorZoom(page: Pick<DashboardPageDocument, "width" | "height">, surfaceWidth: number, surfaceHeight: number): number {
  const availableWidth = Math.max(120, surfaceWidth - 84);
  const availableHeight = Math.max(120, surfaceHeight - 84);
  return Math.max(0.1, Math.min(2, Number(Math.min(availableWidth / page.width, availableHeight / page.height).toFixed(3))));
}

/**
 * 首次进入优先聚焦实际内容；组件已经铺满页面时才展示完整画布。
 * 超宽逻辑分辨率因此不会把少量组件压缩成难以编辑的缩略图，同时仍保留显式“完整显示”入口。
 */
export function calculateDashboardEditorFocus(
  page: Pick<DashboardPageDocument, "width" | "height">,
  nodes: readonly DashboardFocusNode[],
  surfaceWidth: number,
  surfaceHeight: number,
  mode: DashboardEditorFocusMode = "smart",
): DashboardEditorFocus {
  const pageZoom = calculateDashboardEditorZoom(page, surfaceWidth, surfaceHeight);
  const visibleFrames = nodes
    .filter((node) => node.visible !== false)
    .filter((node) => !isLargeDecoration(node, page, nodes.length))
    .map((node) => intersectFrameWithPage(node.frame, page))
    .filter((frame): frame is WidgetFrame => Boolean(frame));
  if (mode === "page" || visibleFrames.length === 0) return pageEditorFocus(page, pageZoom);

  // 少量越界诊断或孤立组件不应把主要业务区再次压成缩略图。
  const focusFrames = mode === "smart" ? dominantContentFrames(visibleFrames, page) : visibleFrames;
  const bounds = focusFrames.reduce(
    (current, frame) => ({
      left: Math.min(current.left, frame.x),
      top: Math.min(current.top, frame.y),
      right: Math.max(current.right, frame.x + frame.width),
      bottom: Math.max(current.bottom, frame.y + frame.height),
    }),
    { left: page.width, top: page.height, right: 0, bottom: 0 },
  );
  const padding = Math.max(48, Math.min(160, Math.min(page.width, page.height) * 0.04));
  const target = {
    x: Math.max(0, bounds.left - padding),
    y: Math.max(0, bounds.top - padding),
    width: Math.min(page.width, bounds.right + padding) - Math.max(0, bounds.left - padding),
    height: Math.min(page.height, bounds.bottom + padding) - Math.max(0, bounds.top - padding),
  };
  const contentZoom = Math.min(1.25, calculateDashboardEditorZoom(target, surfaceWidth, surfaceHeight));
  const contentCoverage = (target.width * target.height) / Math.max(1, page.width * page.height);
  const shouldFocusContent = mode === "content" || (contentCoverage < 0.7 && contentZoom >= pageZoom * 1.25);
  if (shouldFocusContent) {
    return {
      zoom: contentZoom,
      centerX: target.x + target.width / 2,
      centerY: target.y + target.height / 2,
      target: "content",
    };
  }
  const ultraWidePage = page.width / Math.max(1, page.height) >= 2.4;
  // Ultra-wide dashboards are authored as horizontal chapters. Fitting the entire
  // page on entry turns controls and labels into a thumbnail, even when the page is
  // already densely populated. Start at a readable chapter and leave full-page fit
  // as the explicit secondary action in the canvas toolbar.
  if (mode === "smart" && ultraWidePage && pageZoom < 0.5) {
    const readableZoom = 0.5;
    const visibleLogicalWidth = Math.max(1, (surfaceWidth - 84) / readableZoom);
    const halfViewport = visibleLogicalWidth / 2;
    return {
      zoom: readableZoom,
      centerX: Math.min(page.width - halfViewport, Math.max(halfViewport, target.x + halfViewport)),
      centerY: target.y + target.height / 2,
      target: "content",
    };
  }
  return pageEditorFocus(page, pageZoom);
}

function dominantContentFrames(frames: readonly WidgetFrame[], page: Pick<DashboardPageDocument, "width" | "height">): readonly WidgetFrame[] {
  if (frames.length < 3) return frames;
  const linkGap = Math.max(72, Math.min(180, Math.min(page.width, page.height) * 0.13));
  const unvisited = new Set(frames.map((_, index) => index));
  const groups: WidgetFrame[][] = [];
  while (unvisited.size > 0) {
    const first = unvisited.values().next().value as number;
    const queue = [first];
    const group: WidgetFrame[] = [];
    unvisited.delete(first);
    while (queue.length > 0) {
      const index = queue.shift()!;
      const frame = frames[index]!;
      group.push(frame);
      for (const candidate of [...unvisited]) {
        if (!framesAreNearby(frame, frames[candidate]!, linkGap)) continue;
        unvisited.delete(candidate);
        queue.push(candidate);
      }
    }
    groups.push(group);
  }
  groups.sort((left, right) => right.length - left.length || frameArea(right) - frameArea(left));
  const dominant = groups[0] ?? [];
  return dominant.length >= 2 && dominant.length / frames.length >= 0.6 ? dominant : frames;
}

function framesAreNearby(left: WidgetFrame, right: WidgetFrame, gap: number): boolean {
  const horizontalGap = Math.max(0, left.x - (right.x + right.width), right.x - (left.x + left.width));
  const verticalGap = Math.max(0, left.y - (right.y + right.height), right.y - (left.y + left.height));
  return horizontalGap <= gap && verticalGap <= gap;
}

function frameArea(frames: readonly WidgetFrame[]): number {
  return frames.reduce((total, frame) => total + frame.width * frame.height, 0);
}

function isLargeDecoration(node: DashboardFocusNode, page: Pick<DashboardPageDocument, "width" | "height">, nodeCount: number): boolean {
  if (nodeCount < 2 || node.kind !== "data-widget" || !["shape", "decoration"].includes(node.widget?.type ?? "")) return false;
  return (node.frame.width * node.frame.height) / Math.max(1, page.width * page.height) >= 0.55;
}

function pageEditorFocus(page: Pick<DashboardPageDocument, "width" | "height">, zoom: number): DashboardEditorFocus {
  return { zoom, centerX: page.width / 2, centerY: page.height / 2, target: "page" };
}

function intersectFrameWithPage(frame: WidgetFrame, page: Pick<DashboardPageDocument, "width" | "height">): WidgetFrame | undefined {
  const x = Math.max(0, frame.x);
  const y = Math.max(0, frame.y);
  const right = Math.min(page.width, frame.x + Math.max(1, frame.width));
  const bottom = Math.min(page.height, frame.y + Math.max(1, frame.height));
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}

export function dashboardNodeSelection(nodes: readonly WidgetNode[], nodeId: string, current: readonly string[], additive: boolean): string[] {
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.locked) return [...current];
  if (!additive && node.groupId) {
    return nodes.filter((candidate) => candidate.groupId === node.groupId && candidate.locked !== true).map((candidate) => candidate.id);
  }
  if (!additive) return [node.id];
  return current.includes(node.id) ? current.filter((id) => id !== node.id) : [...current, node.id];
}

export function updateDashboardParameterDraft(
  current: Readonly<Record<string, JsonValue>>,
  widgets: readonly DashboardDataWidgetConfig[],
  key: string,
  value: JsonValue | undefined,
): Record<string, JsonValue> {
  const next = { ...current };
  if (value === undefined) delete next[key];
  else next[key] = value;
  const cleared = new Set([key]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const widget of widgets) {
      if (!widget.parentFilterKey || !cleared.has(widget.parentFilterKey) || cleared.has(widget.key)) continue;
      delete next[widget.key];
      cleared.add(widget.key);
      changed = true;
    }
  }
  return next;
}

export function snapDashboardFrame(
  frame: WidgetFrame,
  mode: "move" | "resize",
  xCandidates: readonly number[],
  yCandidates: readonly number[],
  threshold: number,
): { frame: WidgetFrame; lines: ActiveSnapLines } {
  const xAnchors = mode === "move" ? [frame.x, frame.x + frame.width / 2, frame.x + frame.width] : [frame.x + frame.width];
  const yAnchors = mode === "move" ? [frame.y, frame.y + frame.height / 2, frame.y + frame.height] : [frame.y + frame.height];
  const xSnap = nearestSnap(xAnchors, xCandidates, threshold);
  const ySnap = nearestSnap(yAnchors, yCandidates, threshold);
  return {
    frame:
      mode === "move"
        ? { ...frame, x: frame.x + (xSnap?.delta ?? 0), y: frame.y + (ySnap?.delta ?? 0) }
        : { ...frame, width: Math.max(40, frame.width + (xSnap?.delta ?? 0)), height: Math.max(40, frame.height + (ySnap?.delta ?? 0)) },
    lines: { x: xSnap ? [xSnap.candidate] : [], y: ySnap ? [ySnap.candidate] : [] },
  };
}

function nearestSnap(anchors: readonly number[], candidates: readonly number[], threshold: number): { delta: number; candidate: number } | undefined {
  let result: { delta: number; candidate: number } | undefined;
  for (const anchor of anchors)
    for (const candidate of candidates) {
      const delta = candidate - anchor;
      if (Math.abs(delta) <= threshold && (!result || Math.abs(delta) < Math.abs(result.delta))) result = { delta, candidate };
    }
  return result;
}

export function readTemplateFavorites(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(TEMPLATE_FAVORITES_KEY) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}
