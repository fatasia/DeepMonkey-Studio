import type { ApplicationDocument, DashboardDataWidgetConfig, DashboardDataWidgetNode, DashboardPageDocument, DataDatasetRecord } from "@bim-studio/contracts";
import { applyStudioCommand, createPatchDashboardNodesCommand, type DashboardNodeChange } from "@bim-studio/studio-core";

const TYPES = new Set(["value", "gauge", "line", "area", "bar", "pie", "table", "status"]);
const WIDGET_KEYS = ["type", "title", "key", "unit", "datasetId", "field", "min", "max", "fontSize", "analysis", "chart"];
const AGGREGATIONS = new Set(["none", "count", "distinct-count", "sum", "average", "minimum", "maximum"]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须为对象。`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const extra = Object.keys(value).find(key => !allowed.includes(key));
  if (extra) throw new Error(`${label}包含不支持的字段：${extra}`);
}
function text(value: unknown, label: string, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > 160) throw new Error(`${label}无效或过长。`);
  return value;
}

function widgetPatch(raw: unknown): Partial<DashboardDataWidgetConfig> {
  const value = object(raw, "组件配置"); keys(value, WIDGET_KEYS, "组件配置");
  for (const key of ["title", "key", "unit", "datasetId", "field"]) if (key in value) text(value[key], key, key === "unit");
  if ("type" in value && !TYPES.has(String(value.type))) throw new Error("该组件类型不支持 AI 草案。");
  for (const key of ["min", "max", "fontSize"]) if (key in value && (typeof value[key] !== "number" || !Number.isFinite(value[key]))) throw new Error(`${key}必须是有限数字。`);
  if (typeof value.fontSize === "number" && (value.fontSize < 12 || value.fontSize > 96)) throw new Error("设计字号需在 12–96px。 ");
  if ("analysis" in value) {
    const analysis = object(value.analysis, "分析配置"); keys(analysis, ["aggregation", "dimensionField"], "分析配置");
    if (!AGGREGATIONS.has(String(analysis.aggregation))) throw new Error("聚合方式无效。");
    if ("dimensionField" in analysis) text(analysis.dimensionField, "维度字段");
  }
  if ("chart" in value) {
    const chart = object(value.chart, "图表配置"); keys(chart, ["showLegend", "showLabels"], "图表配置");
    if (Object.values(chart).some(item => typeof item !== "boolean")) throw new Error("图表开关必须是布尔值。");
  }
  return structuredClone(value) as Partial<DashboardDataWidgetConfig>;
}

function validateBinding(widget: DashboardDataWidgetConfig, projectId: string, datasets: readonly DataDatasetRecord[]) {
  if (!TYPES.has(widget.type) || widget.directBinding || widget.pipelineId || widget.semanticBinding || widget.sampleData) throw new Error("本次仅支持普通数据集组件，不修改直连、管道、语义或样本组件。");
  text(widget.title, "标题"); text(widget.key, "键"); text(widget.unit, "单位", true);
  if (!widget.datasetId) {
    if (widget.field || widget.analysis?.dimensionField) throw new Error("字段必须绑定当前项目的数据集。");
    return;
  }
  const dataset = datasets.find(item => item.id === widget.datasetId && item.projectId === projectId);
  if (!dataset) throw new Error(`数据集不在当前项目目录：${widget.datasetId}`);
  for (const field of [widget.field, widget.analysis?.dimensionField, widget.analysis?.measureField, widget.analysis?.seriesField]) {
    if (field && !dataset.fields.some(item => item.key === field)) throw new Error(`数据集不存在字段：${field}`);
  }
  if (widget.type !== "table" && !widget.field) throw new Error("指标或图表必须明确数值字段。");
  const field = dataset.fields.find(item => item.key === widget.field);
  if (field && widget.type !== "status" && widget.type !== "table" && field.type !== "number" && widget.analysis?.aggregation !== "count") throw new Error(`数值组件不能绑定非数值字段：${field.key}`);
}

export interface DashboardDraftDiff { op: "add" | "update" | "delete"; id: string; title: string; before?: DashboardDataWidgetNode; after?: DashboardDataWidgetNode; }

export function validateDashboardDraft(raw: unknown, document: ApplicationDocument, page: DashboardPageDocument, datasets: readonly DataDatasetRecord[]) {
  const draft = object(raw, "看板草案"); keys(draft, ["version", "pageId", "changes"], "看板草案");
  if (draft.version !== 1 || draft.pageId !== page.id) throw new Error("草案版本未知或目标页面不匹配。");
  if (!Array.isArray(draft.changes) || draft.changes.length > 64) throw new Error("草案最多支持 64 项变更。");
  const changes: DashboardNodeChange[] = [], diff: DashboardDraftDiff[] = [];
  const seen = new Set<string>();
  for (const rawChange of draft.changes) {
    const item = object(rawChange, "变更"); keys(item, ["op", "id", "frame", "widget", "name"], "变更");
    const id = text(item.id, "组件 ID");
    if (seen.has(id) || !/^[\p{L}\p{N}_:.\-]+$/u.test(id)) throw new Error("组件 ID 重复或无效。");
    seen.add(id);
    if (!["add", "update", "delete"].includes(String(item.op))) throw new Error("未知变更操作。");
    const old = page.nodes.find(node => node.id === id);
    if (item.op !== "add" && (!old || old.kind !== "data-widget" || old.locked)) throw new Error(`组件不存在、已锁定或不支持修改：${id}`);
    const before = old?.kind === "data-widget" ? old : undefined;
    if (before) validateBinding(before.widget, document.metadata.projectId, datasets);
    if (item.op === "delete") {
      keys(item, ["op", "id"], "删除操作");
      changes.push({ op: "delete", nodeId: id }); diff.push({ op: "delete", id, title: before!.widget.title, before: before! }); continue;
    }
    if (item.op === "add" && old) throw new Error(`组件已存在：${id}`);
    if (item.op === "update" && !item.frame && !item.widget && !item.name) throw new Error("更新操作没有明确变更。");
    const frame = item.frame === undefined ? before?.frame : object(item.frame, "布局");
    if (!frame) throw new Error("新增组件缺少布局。");
    keys(frame as unknown as Record<string, unknown>, ["x", "y", "width", "height"], "布局");
    if (![frame.x, frame.y, frame.width, frame.height].every(value => typeof value === "number" && Number.isFinite(value))) throw new Error("组件布局必须是有限数字。");
    const widget = { ...(before?.widget ?? { type: "value", title: "", key: "", unit: "", fontSize: 24 }), ...(item.widget === undefined ? {} : widgetPatch(item.widget)) } as DashboardDataWidgetConfig;
    if (widget.analysis?.dimensionField && widget.field) widget.analysis = { ...widget.analysis, measureField: widget.field };
    validateBinding(widget, document.metadata.projectId, datasets);
    // 复用平台数据产品的指标寻址，不让模型猜测 key；修改既有绑定仍由命令拒绝静默断线。
    if (widget.datasetId) {
      const field = widget.field ?? datasets.find(dataset => dataset.id === widget.datasetId)?.fields[0]?.key;
      if (!field) throw new Error("数据集没有可用字段，请先配置字段。");
      widget.key = `${widget.datasetId}.${field}`;
    }
    const node: DashboardDataWidgetNode = { ...(before ?? {}), id, kind: "data-widget", frame: structuredClone(frame) as DashboardDataWidgetNode["frame"],
      zIndex: before?.zIndex ?? Math.max(0, ...page.nodes.map(node => node.zIndex)) + changes.length + 1, widget,
      ...(item.name === undefined ? {} : { name: text(item.name, "组件名称") }) };
    if (before && JSON.stringify(before) === JSON.stringify(node)) continue;
    const op = item.op as "add" | "update";
    changes.push({ op, node }); diff.push({ op, id, title: widget.title, ...(before ? { before } : {}), after: node });
  }
  if (!changes.length) return { diff, command: undefined };
  const command = createPatchDashboardNodesCommand(document, page, changes);
  applyStudioCommand(document, command);
  return { diff, command };
}

/** 只给模型布局和可编辑字段，不携带直连凭据、脚本、样本行或其他场景内容。 */
export function dashboardDraftPageContext(page: DashboardPageDocument) {
  return { id: page.id, name: page.name, width: page.width, height: page.height,
    nodes: page.nodes.map(node => ({ id: node.id, kind: node.kind, name: node.name, locked: node.locked, frame: node.frame,
      ...(node.kind === "data-widget" ? { widget: Object.fromEntries(Object.entries(node.widget).filter(([key]) => WIDGET_KEYS.includes(key))),
        editable: TYPES.has(node.widget.type) && !node.locked && !node.widget.directBinding && !node.widget.pipelineId && !node.widget.semanticBinding && !node.widget.sampleData } : { editable: false }) })) };
}
