/**
 * Plant 平替渲染数据层(矩阵 P0-B;Plant Simulation 标配输出):
 * Sankey 物料流决策图 + Gantt 订单/工序时序,输出 contracts/plantAnalytics.ts 合同对象;ECharts option 为第二层纯函数(不引 echarts 包)。
 * 预热剔除与内核同口径:窗口坐标 = 日历分钟 - warmup,warmup = simulatedMinutes - measurementMinutes。
 * 流量守恒:仅统计正式窗口内抵达 sink 的工件完整路径,source 流出链和 = 窗口完工件数;
 * 报废件路径不完整、不参与流量(残差 = 窗口报废件数),轨迹截断时按截断残差处理。
 */import type {
  PlantAnalyticsGanttAnalysis,
  PlantAnalyticsGanttRow,
  PlantAnalyticsGanttSegment,
  PlantAnalyticsGanttSegmentKind,
  PlantAnalyticsSankeyAnalysis,
  PlantAnalyticsSankeyLink,
  PlantAnalyticsSankeyNode,
} from "@bim-studio/contracts";
import type {
  PlantLiteExperimentResult,
  PlantLiteModel,
  PlantLiteNode,
  PlantLiteReplication,
  PlantLiteReplicationTrace,
  PlantLiteTraceEvent,
} from "./model.js";

type ProcessingNode = Extract<PlantLiteNode, { kind: "station" | "transport" }>;
type ItemTraceEvent = Extract<PlantLiteTraceEvent, { itemId: string }>;
const KIND_ORDER: readonly PlantAnalyticsGanttSegmentKind[] = ["occupied", "blocked", "failed", "changeover"];

export function buildSankeyAnalysis(result: PlantLiteExperimentResult, model: PlantLiteModel): PlantAnalyticsSankeyAnalysis {
  const trace = result.representativeTrace;
  const { replication, windowMinutes } = analyticsContext(result);
  const nodes: PlantAnalyticsSankeyNode[] = model.nodes.map((node) => ({ id: node.id, label: node.name }));
  return {
    nodes,
    links: trace ? traceSankeyLinks(trace, model, replication) : estimateSankeyLinks(model, replication),
    windowMinutes,
    estimated: !trace,
    generatedFrom: { modelId: model.id, replications: result.replications.length },
  };
}

export function buildGanttAnalysis(result: PlantLiteExperimentResult, model: PlantLiteModel): PlantAnalyticsGanttAnalysis {
  const { trace, replication, warmup, windowMinutes } = analyticsContext(result);
  const rows = model.nodes
    .filter((node): node is ProcessingNode => node.kind === "station" || node.kind === "transport")
    .map((node) => trace ? traceGanttRow(node, trace, warmup, windowMinutes, model) : estimatedGanttRow(node, replication, model, windowMinutes));
  const taktMinutes = replication.completedItems > 0 ? windowMinutes / replication.completedItems : undefined;
  return { rows, windowMinutes, ...(taktMinutes !== undefined ? { taktMinutes } : {}) };
}

/** trace.replication 对应的重复与窗口口径;无 replication 视为输入损坏,立即抛错。 */
function analyticsContext(result: PlantLiteExperimentResult) {
  const trace = result.representativeTrace;
  const replication = (trace ? result.replications[trace.replication] : undefined) ?? result.replications[0];
  if (!replication) throw new Error("实验结果缺少 replication,无法构建渲染分析");
  const warmup = Math.max(0, replication.simulatedMinutes - replication.measurementMinutes);
  return { ...(trace ? { trace } : {}), replication, warmup, windowMinutes: replication.measurementMinutes };
}

/** 真实流:按工件聚合事件;窗口内抵达 sink 的工件,其完整路径(含预热期跳数)每条边 +1。 */function traceSankeyLinks(trace: PlantLiteReplicationTrace, model: PlantLiteModel, replication: PlantLiteReplication): PlantAnalyticsSankeyLink[] {
  const warmup = Math.max(0, replication.simulatedMinutes - replication.measurementMinutes);
  const sinkIds = new Set(model.nodes.filter((node) => node.kind === "sink").map((node) => node.id));
  const eventsByItem = new Map<string, PlantLiteTraceEvent[]>();
  for (const event of trace.events) {
    if (!("itemId" in event)) continue;
    const bucket = eventsByItem.get(event.itemId);
    if (bucket) bucket.push(event);
    else eventsByItem.set(event.itemId, [event]);
  }
  const counts = new Map<string, number>();
  for (const events of eventsByItem.values()) {
    const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
    const completedInWindow = ordered.some((event) =>
      event.type === "item-complete" && sinkIds.has(event.nodeId) && event.atMinute >= warmup);
    if (!completedInWindow) continue;
    const enters = ordered.filter((event): event is ItemTraceEvent => event.type === "item-enter");
    for (let index = 1; index < enters.length; index += 1) {
      const key = `${enters[index - 1]!.nodeId}>${enters[index]!.nodeId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return sortLinks(model, [...counts].map(([key, value]) => {
    const [source, target] = key.split(">");
    return { source: source!, target: target!, value };
  }));
}

/** 估算流:source 流出 = 窗口完工数,沿边传播;split 按 routeDelivered/份额分流,工位按良率衰减。 */
function estimateSankeyLinks(model: PlantLiteModel, replication: PlantLiteReplication): PlantAnalyticsSankeyLink[] {
  const base = replication.completedItems;
  const nodeById = new Map(model.nodes.map((node) => [node.id, node] as const));
  const metricByNode = new Map(replication.nodes.map((metric) => [metric.nodeId, metric] as const));
  const flows = new Map<string, number>();
  const edgeWeight = (from: string, to: string): number => {
    const total = flows.get(from) ?? 0;
    const node = nodeById.get(from);
    if (node?.kind !== "split") return total;
    const route = node.routes.find((candidate) => candidate.to === to);
    const delivered = metricByNode.get(from)?.routeDelivered;
    if (delivered?.length) {
      const deliveredTotal = delivered.reduce((sum, entry) => sum + entry.items, 0);
      return deliveredTotal > 0 ? total * (delivered.find((entry) => entry.to === to)?.items ?? 0) / deliveredTotal : 0;
    }
    if (node.routes.every((candidate) => candidate.share !== undefined)) return total * (route?.share ?? 0);
    return total / Math.max(1, node.routes.length);
  };
  const through = (node: PlantLiteNode): number => {
    if (node.kind === "source") return base;
    let inflow = model.edges.filter((edge) => edge.to === node.id).reduce((sum, edge) => sum + edgeWeight(edge.from, node.id), 0);
    for (const candidate of model.nodes) {
      if (candidate.kind === "split" && candidate.routes.some((route) => route.to === node.id)) inflow += edgeWeight(candidate.id, node.id);
    }
    return node.kind === "station" ? inflow * (node.yieldRate ?? 1) : inflow;
  };
  for (let pass = 0; pass <= model.nodes.length; pass += 1) {
    for (const node of model.nodes) flows.set(node.id, through(node));
  }
  const links: PlantAnalyticsSankeyLink[] = model.edges
    .map((edge) => ({ source: edge.from, target: edge.to, value: edgeWeight(edge.from, edge.to) }));
  for (const node of model.nodes) {
    if (node.kind === "split") for (const route of node.routes) links.push({ source: node.id, target: route.to, value: edgeWeight(node.id, route.to) });
  }
  return sortLinks(model, links.map((link) => ({ ...link, value: Math.round(link.value) })));
}

function sortLinks(model: PlantLiteModel, links: PlantAnalyticsSankeyLink[]): PlantAnalyticsSankeyLink[] {
  const order = new Map(model.nodes.map((node, index) => [node.id, index] as const));
  return links.sort((left, right) => (order.get(left.source) ?? 0) - (order.get(right.source) ?? 0)
    || (order.get(left.target) ?? 0) - (order.get(right.target) ?? 0));
}

/**
 * 事件对齐切分:occupied = item-start→complete;blocked = complete→exit 停留(item-scrap * 与完工同刻,立即关闭);changeover = 换型事件自带区间;failed = (resourceId, unitIndex)
 * 配对后按行合并重叠;仿真结束未闭合的区间延至窗口尾(在制与持有是真实状态,不是缺数据)。
 */
function traceGanttRow(node: ProcessingNode, trace: PlantLiteReplicationTrace, warmup: number, windowMinutes: number, model: PlantLiteModel): PlantAnalyticsGanttRow {
  const segments: PlantAnalyticsGanttSegment[] = [];
  const horizon = warmup + windowMinutes;
  const push = (kind: PlantAnalyticsGanttSegmentKind, start: number, end: number) => {
    const from = Math.max(0, start - warmup);
    const to = Math.min(windowMinutes, end - warmup);
    if (to > from) segments.push({ startMinute: from, endMinute: to, kind });
  };
  const startedByItem = new Map<string, number>();
  const completedByItem = new Map<string, number>();
  const failureOpen = new Map<string, number>();
  const failedSpans: Array<[number, number]> = [];
  const resources = boundResourceIds(node);
  for (const event of trace.events) {
    if ("itemId" in event && event.nodeId === node.id) {
      if (event.type === "item-start") startedByItem.set(event.itemId, event.atMinute);
      else if (event.type === "item-complete") {
        const started = startedByItem.get(event.itemId);
        startedByItem.delete(event.itemId);
        if (started !== undefined) push("occupied", started, event.atMinute);
        completedByItem.set(event.itemId, event.atMinute);
      } else if (event.type === "item-exit") {
        const completed = completedByItem.get(event.itemId);
        completedByItem.delete(event.itemId);
        if (completed !== undefined) push("blocked", completed, event.atMinute);
      } else if (event.type === "item-scrap") completedByItem.delete(event.itemId);
      else if (event.type === "item-changeover-start" && event.changeover) {
        push("changeover", event.changeover.startMinute, event.changeover.startMinute + event.changeover.durationMinutes);
      }
    } else if ("resourceId" in event && resources.has(event.resourceId)) {
      const key = `${event.resourceId}|${event.unitIndex ?? 0}`;
      if (event.type === "resource-failure") failureOpen.set(key, event.atMinute);
      else {
        const start = failureOpen.get(key);
        if (start !== undefined) { failureOpen.delete(key); failedSpans.push([start, event.atMinute]); }
      }
    }
  }
  for (const started of startedByItem.values()) push("occupied", started, horizon);
  for (const completed of completedByItem.values()) push("blocked", completed, horizon);
  for (const start of failureOpen.values()) failedSpans.push([start, horizon]);
  for (const [start, end] of mergeSpans(failedSpans)) push("failed", start, end);
  const kindRank = (kind: PlantAnalyticsGanttSegmentKind) => KIND_ORDER.indexOf(kind);
  segments.sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute || kindRank(left.kind) - kindRank(right.kind));
  return { id: node.id, label: node.name, estimated: false, segments };
}

/** 指标占比铺段:changeover/blocked/failed 按指标刻出,occupied 为在场残差(忙+工位空闲);各段和恰为窗口长。 */
function estimatedGanttRow(node: ProcessingNode, replication: PlantLiteReplication, model: PlantLiteModel, windowMinutes: number): PlantAnalyticsGanttRow {
  const metric = replication.nodes.find((candidate) => candidate.nodeId === node.id);
  const clamp = (value: number) => Math.min(windowMinutes, Math.max(0, value));
  let changeover = clamp(metric?.changeoverMinutes ?? 0);
  let blocked = clamp(metric?.blockedMinutes ?? 0);
  let failed = clamp(estimatedFailedMinutes(node, replication, model));
  const others = changeover + blocked + failed;
  if (others > windowMinutes && others > 0) {
    const scale = windowMinutes / others; // 病态输入(指标合计超窗)等比收缩,保证铺段和=窗口。
    changeover *= scale; blocked *= scale; failed *= scale;
  }
  const occupied = windowMinutes - changeover - blocked - failed;
  const segments: PlantAnalyticsGanttSegment[] = [];
  let cursor = 0;
  const lay = (kind: PlantAnalyticsGanttSegmentKind, minutes: number, label: string) => {
    if (minutes <= 1e-9) return;
    segments.push({ startMinute: cursor, endMinute: cursor + minutes, kind, label });
    cursor += minutes;
  };
  lay("occupied", occupied, "estimated:在场时长(忙+空闲,指标残差)");
  lay("changeover", changeover, "estimated:换型占用指标");
  lay("blocked", blocked, "estimated:阻塞指标");
  lay("failed", failed, "estimated:故障停机指标");
  return { id: node.id, label: node.name, estimated: true, segments };
}

function estimatedFailedMinutes(node: ProcessingNode, replication: PlantLiteReplication, model: PlantLiteModel): number {
  return [...boundResourceIds(node)].reduce((total, resourceId) => {
    const resource = model.resources?.find((candidate) => candidate.id === resourceId);
    const metric = replication.resources.find((candidate) => candidate.resourceId === resourceId);
    return total + (metric ? metric.failedMinutes / Math.max(1, resource?.capacity ?? 1) : 0);
  }, 0);
}

function boundResourceIds(node: ProcessingNode): Set<string> {
  const ids = new Set<string>();
  if (node.kind === "transport") ids.add(node.resourceId);
  if (node.kind === "station") {
    if (node.resourceId !== undefined) ids.add(node.resourceId);
    if (node.workerResourceId !== undefined) ids.add(node.workerResourceId);
  }
  return ids;
}

function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const span of [...spans].sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  return merged;
}

// ---------- ECharts option 组装(纯函数,不引 echarts 包) ----------

/**
 * Sankey option(纯 JSON)。ECharts sankey 以 name 关联 links;label 重名时回退用 id 作
 * name,原始 label 放入自定义字段供 tooltip 格式化。
 */
export function buildEChartsSankeyOption(analysis: PlantAnalyticsSankeyAnalysis): Record<string, unknown> {
  const labelCounts = new Map<string, number>();
  for (const node of analysis.nodes) labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1);
  const nameById = new Map(analysis.nodes.map((node) => [node.id, labelCounts.get(node.label) === 1 ? node.label : node.id] as const));
  return {
    tooltip: { trigger: "item" },
    series: [{
      type: "sankey", left: 8, top: 8, right: 120, bottom: 8, nodeWidth: 14, nodeGap: 10, nodeAlign: "justify",
      emphasis: { focus: "adjacency" }, lineStyle: { color: "gradient", curveness: 0.5 },
      data: analysis.nodes.map((node) => ({ name: nameById.get(node.id)!, nodeId: node.id, label: node.label })),
      links: analysis.links.map((link) => ({
        source: nameById.get(link.source)!, target: nameById.get(link.target)!, value: link.value,
        ...(link.unit ? { unit: link.unit } : {}),
      })),
    }],
  };
}

/**
 * 甘特 option。ECharts 原生无 Gantt,官方推荐 custom series 逐段画矩形;renderItem 是函数,
 * 使整个 option 不可 JSON.stringify —— 纯数据字段(data/xAxis/yAxis/encode)保持纯 JSON,
 * 消费端如需纯 JSON 传输可剥离 renderItem,按 data[i].value =
 * [行号, 起点分钟, 时长分钟, 类型索引] 的起点跨度编码自绘,或改用堆叠透明偏移条
 * (每段两条 series,段多时 series 爆炸,不推荐)。
 * 默认配色仅为数据层建议值;正式消费端必须用 base.css 设计令牌(--accent 派生)覆盖。
 */
const GANTT_KIND_COLORS: Record<PlantAnalyticsGanttSegmentKind, string> = { occupied: "#3b82f6", blocked: "#f59e0b", failed: "#ef4444", changeover: "#8b5cf6" };

interface GanttRenderApi {
  value: (dimensionIndex: number) => number;
  coord: (point: readonly [number, number]) => [number, number];
  size: (extent: readonly [number, number]) => [number, number];
}

export function buildEChartsGanttOption(analysis: PlantAnalyticsGanttAnalysis): Record<string, unknown> {
  return {
    grid: { left: 96, top: 24, right: 24, bottom: 36 },
    tooltip: { trigger: "item" },
    xAxis: { type: "value", min: 0, max: analysis.windowMinutes, name: "分钟", nameLocation: "middle", nameGap: 24 },
    yAxis: { type: "category", inverse: true, data: analysis.rows.map((row) => row.label) },
    series: [{
      type: "custom",
      encode: { x: [1, 2], y: 0 },
      renderItem: (_params: unknown, api: GanttRenderApi) => {
        const start = api.coord([api.value(1), api.value(0)]);
        const end = api.coord([api.value(1) + api.value(2), api.value(0)]);
        const barHeight = Math.min(18, api.size([0, 1])[1] * 0.6);
        return { type: "rect", shape: { x: start[0], y: start[1] - barHeight / 2, width: Math.max(1, end[0] - start[0]), height: barHeight }, style: { fill: GANTT_KIND_COLORS[KIND_ORDER[api.value(3)] ?? "occupied"] } };
      },
      data: analysis.rows.flatMap((row, rowIndex) => row.segments.map((segment) => ({
        name: segment.label ?? `${row.label}·${segment.kind}`,
        value: [rowIndex, segment.startMinute, segment.endMinute - segment.startMinute, KIND_ORDER.indexOf(segment.kind)],
      }))),
    }],
  };
}
