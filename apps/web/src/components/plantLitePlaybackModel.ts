import type {
  PlantLiteModel,
  PlantLiteReplicationTrace,
  PlantLiteTraceEvent,
} from "@bim-studio/contracts";
import { indexPlantLiteTransport, type PlantLiteTransportInterval } from "./plantLiteTransportPlayback";

export type PlantLitePlaybackItemState = "queued" | "changeover" | "processing" | "moving" | "completed";
type ItemTraceEvent = Extract<PlantLiteTraceEvent, { itemId: string }>;
type ResourceTraceEvent = Extract<PlantLiteTraceEvent, { resourceId: string }>;

export interface PlantLitePlaybackItem {
  itemId: string;
  nodeId: string;
  xPercent: number;
  lane: number;
  state: PlantLitePlaybackItemState;
  transport?: { toNodeId: string; progress: number };
}

export interface PlantLitePlaybackFrame {
  atMinute: number;
  activeItems: number;
  completedItems: number;
  scrappedItems: number;
  failedResourceIds: string[];
  unavailableResourceUnits: Record<string, number>;
  items: PlantLitePlaybackItem[];
  /** 当前时刻仍等待的已记录物料数；不是事件次数、持续占用或全量队列。 */
  waitingByNode?: Record<string, number>;
  sceneLayers?: { heatmap: boolean; trails: boolean };
  latestEvent?: PlantLiteTraceEvent;
}

interface PreparedResourceEvent {
  event: ResourceTraceEvent;
  unavailableAfter: number;
}

/** 不可变回放索引；组件只在 trace/model 改变时创建一次。 */
export interface PreparedPlantLitePlayback {
  duration: number;
  orderedEvents: PlantLiteTraceEvent[];
  itemIds: string[];
  itemTimelines: Map<string, ItemTraceEvent[]>;
  transportBySequence: Map<number, PlantLiteTransportInterval>;
  resourceTimelines: Map<string, PreparedResourceEvent[]>;
  sinkIds: Set<string>;
  nodeIndexById: Map<string, number>;
  model: PlantLiteModel;
}

export function plantLiteTraceDuration(trace: PlantLiteReplicationTrace): number {
  return trace.events.reduce((maximum, event) => Math.max(maximum, event.atMinute), 0);
}

export function preparePlantLitePlayback(trace: PlantLiteReplicationTrace, model: PlantLiteModel): PreparedPlantLitePlayback {
  const orderedEvents = [...trace.events].sort(byTimeAndSequence);
  const itemTimelines = new Map<string, ItemTraceEvent[]>();
  const rawResourceTimelines = new Map<string, ResourceTraceEvent[]>();
  for (const event of orderedEvents) {
    if ("itemId" in event) appendToMap(itemTimelines, event.itemId, event);
    else appendToMap(rawResourceTimelines, event.resourceId, event);
  }
  const resourceTimelines = new Map<string, PreparedResourceEvent[]>();
  for (const [resourceId, timeline] of rawResourceTimelines) {
    const capacity = model.resources?.find((resource) => resource.id === resourceId)?.capacity ?? 1;
    resourceTimelines.set(resourceId, indexResourceFailures(timeline, capacity));
  }
  return {
    duration: orderedEvents.at(-1)?.atMinute ?? 0,
    orderedEvents,
    itemIds: [...itemTimelines.keys()].sort(),
    itemTimelines,
    transportBySequence: indexPlantLiteTransport(itemTimelines, model),
    resourceTimelines,
    sinkIds: new Set(model.nodes.filter((node) => node.kind === "sink").map((node) => node.id)),
    nodeIndexById: new Map(model.nodes.map((node, index) => [node.id, index])),
    model,
  };
}

/** 兼容纯函数调用；高频播放应复用 preparePlantLitePlayback 的结果。 */
export function derivePlantLitePlaybackFrame(
  trace: PlantLiteReplicationTrace,
  model: PlantLiteModel,
  requestedMinute: number,
  visibleItemLimit = 18,
): PlantLitePlaybackFrame {
  return selectPlantLitePlaybackFrame(preparePlantLitePlayback(trace, model), requestedMinute, visibleItemLimit);
}

export function selectPlantLitePlaybackFrame(
  prepared: PreparedPlantLitePlayback,
  requestedMinute: number,
  visibleItemLimit = 18,
): PlantLitePlaybackFrame {
  const atMinute = clamp(requestedMinute, 0, prepared.duration);
  const limit = Math.max(1, visibleItemLimit);
  const active: PlantLitePlaybackItem[] = [];
  const completed: PlantLitePlaybackItem[] = [];
  let activeItems = 0;
  let completedItems = 0;
  let scrappedItems = 0;
  const waitingByNode: Record<string, number> = {};
  for (const itemId of prepared.itemIds) {
    const timeline = prepared.itemTimelines.get(itemId)!;
    const eventIndex = upperBoundByMinute(timeline, atMinute) - 1;
    if (eventIndex < 0) continue;
    const current = timeline[eventIndex]!;
    const isCompleted = current.type === "item-complete" && prepared.sinkIds.has(current.nodeId);
    const isScrapped = current.type === "item-scrap";
    if (isCompleted) completedItems += 1;
    else if (isScrapped) scrappedItems += 1;
    else activeItems += 1;
    if (isScrapped) continue;
    const item = toPlaybackItem(prepared, itemId, current, atMinute, isCompleted);
    const node = prepared.model.nodes[prepared.nodeIndexById.get(current.nodeId) ?? -1];
    if (!isCompleted && item.state === "queued" && node && node.kind !== "source" && node.kind !== "sink") {
      waitingByNode[current.nodeId] = (waitingByNode[current.nodeId] ?? 0) + 1;
    }
    const target = isCompleted ? completed : active;
    if (target.length < limit) target.push(item);
  }
  const unavailableResourceUnits = Object.fromEntries([...prepared.resourceTimelines]
    .map(([resourceId, timeline]) => {
      const index = upperBoundPreparedResource(timeline, atMinute) - 1;
      return [resourceId, index >= 0 ? timeline[index]!.unavailableAfter : 0] as const;
    })
    .filter(([, unavailable]) => unavailable > 0));
  const failedResourceIds = Object.keys(unavailableResourceUnits).sort();
  const latestIndex = upperBoundByMinute(prepared.orderedEvents, atMinute) - 1;
  const latestEvent = latestIndex >= 0 ? prepared.orderedEvents[latestIndex] : undefined;
  return {
    atMinute,
    activeItems,
    completedItems,
    scrappedItems,
    failedResourceIds,
    unavailableResourceUnits,
    waitingByNode,
    items: [...active, ...completed.slice(0, Math.max(0, limit - active.length))],
    ...(latestEvent ? { latestEvent } : {}),
  };
}

export function describePlantLiteTraceEvent(event: PlantLiteTraceEvent | undefined, model: PlantLiteModel): string {
  if (!event) return "等待首个事件";
  if ("resourceId" in event) {
    const resource = model.resources?.find((item) => item.id === event.resourceId);
    const action = event.type === "resource-failure" ? "发生故障" : "完成修复";
    const unit = event.unitIndex === undefined ? "" : ` · ${event.unitIndex + 1} 号单元`;
    const availability = event.unavailableUnits === undefined ? "" : ` · ${event.unavailableUnits}/${resource?.capacity ?? "?"} 台不可用`;
    return `${resource?.name ?? event.resourceId}${unit}${action}${availability}`;
  }
  const node = model.nodes.find((item) => item.id === event.nodeId);
  const product = event.productTypeId
    ? `（${model.productTypes?.find((item) => item.id === event.productTypeId)?.name ?? event.productTypeId}）`
    : "";
  const action = event.type === "item-enter"
    ? "进入"
    : event.type === "item-changeover-start"
      ? `开始换型 ${productTypeName(model, event.changeover?.fromProductTypeId)} → ${productTypeName(model, event.changeover?.toProductTypeId)}`
      : event.type === "item-changeover-complete"
        ? "完成换型"
    : event.type === "item-start"
      ? "开始处理"
      : event.type === "item-complete"
        ? "完成"
        : event.type === "item-scrap"
          ? `判定报废（配置良率 ${((event.quality?.configuredYieldRate ?? 1) * 100).toFixed(1)}%）`
        : "离开";
  return `${shortItemId(event.itemId)}${product} ${action} ${node?.name ?? event.nodeId}`;
}

function productTypeName(model: PlantLiteModel, id: string | undefined): string {
  if (!id) return "未知产品";
  return model.productTypes?.find((item) => item.id === id)?.name ?? id;
}

export function formatPlantLiteMinute(value: number): string {
  const minute = Math.max(0, value);
  const hours = Math.floor(minute / 60);
  const remainder = Math.floor(minute % 60);
  const seconds = Math.floor((minute - Math.floor(minute)) * 60);
  return `${String(hours).padStart(2, "0")}:${String(remainder).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function toPlaybackItem(
  prepared: PreparedPlantLitePlayback,
  itemId: string,
  current: ItemTraceEvent,
  atMinute: number,
  completed: boolean,
): PlantLitePlaybackItem {
  const nodeIndex = prepared.nodeIndexById.get(current.nodeId) ?? 0;
  const baseX = nodePosition(nodeIndex, prepared.model.nodes.length);
  const node = prepared.model.nodes[nodeIndex];
  const interval = prepared.transportBySequence.get(current.sequence);
  const targetId = interval?.toNodeId;
  const targetIndex = targetId ? prepared.nodeIndexById.get(targetId) ?? -1 : -1;
  const travelProgress = interval && targetIndex >= 0
    ? clamp((atMinute - interval.startMinute) / (interval.endMinute - interval.startMinute), 0, 1)
    : 0;
  const xPercent = targetIndex >= 0 && travelProgress > 0
    ? baseX + (nodePosition(targetIndex, prepared.model.nodes.length) - baseX) * travelProgress
    : baseX;
  const state: PlantLitePlaybackItemState = completed
    ? "completed"
    : current.type === "item-changeover-start" || current.type === "item-changeover-complete"
      ? "changeover"
    : node?.kind === "transport" && current.type === "item-start"
      ? "moving"
      : current.type === "item-start"
        ? "processing"
        : current.type === "item-exit"
          ? "moving"
          : "queued";
  return { itemId, nodeId: current.nodeId, xPercent, lane: stableLane(itemId), state, ...(interval ? { transport: { toNodeId: interval.toNodeId, progress: travelProgress } } : {}) };
}

function indexResourceFailures(timeline: ResourceTraceEvent[], capacity: number): PreparedResourceEvent[] {
  const failedUnits = new Set<number>();
  let legacyUnavailable = 0;
  return timeline.map((event) => {
    if (event.unitIndex !== undefined) {
      if (event.type === "resource-failure") failedUnits.add(event.unitIndex);
      else failedUnits.delete(event.unitIndex);
    }
    if (event.unavailableUnits !== undefined) {
      legacyUnavailable = clamp(event.unavailableUnits, 0, capacity);
    } else if (event.unitIndex !== undefined) {
      legacyUnavailable = failedUnits.size;
    } else {
      legacyUnavailable = event.type === "resource-failure" ? capacity : 0;
    }
    return { event, unavailableAfter: legacyUnavailable };
  });
}

function appendToMap<T>(map: Map<string, T[]>, key: string, value: T): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function upperBoundByMinute<T extends { atMinute: number }>(values: T[], minute: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]!.atMinute <= minute) low = middle + 1;
    else high = middle;
  }
  return low;
}

function upperBoundPreparedResource(values: PreparedResourceEvent[], minute: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]!.event.atMinute <= minute) low = middle + 1;
    else high = middle;
  }
  return low;
}

function nodePosition(index: number, count: number): number {
  if (count <= 1) return 50;
  return 5 + (index / (count - 1)) * 90;
}

function stableLane(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash * 31) + value.charCodeAt(index)) | 0;
  return Math.abs(hash) % 4;
}

function shortItemId(value: string): string {
  const segments = value.split(":");
  return `物料 ${segments.at(-1) ?? value}`;
}

function byTimeAndSequence(left: PlantLiteTraceEvent, right: PlantLiteTraceEvent): number {
  return left.atMinute - right.atMinute || left.sequence - right.sequence;
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}
