import type {
  PlantLiteModel,
  PlantLiteReplicationTrace,
  PlantLiteTraceEvent,
} from "@bim-studio/contracts";

type ItemEvent = Extract<PlantLiteTraceEvent, { itemId: string }>;
type ResourceEvent = Extract<PlantLiteTraceEvent, { resourceId: string }>;

export interface PlantLiteTimelineInterval {
  id: string;
  startMinute: number;
  endMinute: number;
  lane: number;
  kind: "processing" | "transport" | "changeover" | "failure";
  label: string;
  incomplete: boolean;
}

export interface PlantLiteTimelineRow {
  id: string;
  label: string;
  kind: "station" | "transport" | "resource";
  laneCount: number;
  intervals: PlantLiteTimelineInterval[];
}

export interface PlantLiteResourceTimeline {
  durationMinutes: number;
  intervalCount: number;
  omittedIntervalCount: number;
  rows: PlantLiteTimelineRow[];
}

const DEFAULT_MAX_INTERVALS = 600;

/**
 * Builds a bounded Gantt view from one captured DES replication. It never
 * promotes this representative trace to an aggregate or a complete record.
 */
export function derivePlantLiteResourceTimeline(
  trace: PlantLiteReplicationTrace,
  model: PlantLiteModel,
  maxIntervals = DEFAULT_MAX_INTERVALS,
): PlantLiteResourceTimeline {
  const ordered = [...trace.events].sort(byTimeAndSequence);
  const durationMinutes = ordered.at(-1)?.atMinute ?? 0;
  const rawRows = new Map<string, Omit<PlantLiteTimelineRow, "laneCount">>();
  const starts = new Map<string, ItemEvent>();
  const changeovers = new Map<string, ItemEvent>();
  const failures = new Map<string, ResourceEvent>();

  for (const node of model.nodes) {
    if (node.kind !== "station" && node.kind !== "transport") continue;
    rawRows.set(`node:${node.id}`, {
      id: `node:${node.id}`,
      label: node.name,
      kind: node.kind,
      intervals: [],
    });
  }
  for (const resource of model.resources ?? []) {
    rawRows.set(`resource:${resource.id}`, {
      id: `resource:${resource.id}`,
      label: `${resource.name} · 故障`,
      kind: "resource",
      intervals: [],
    });
  }

  for (const event of ordered) {
    if ("itemId" in event) indexItemEvent(event, model, starts, changeovers, rawRows);
    else indexResourceEvent(event, model, failures, rawRows);
  }

  for (const start of starts.values()) {
    appendItemInterval(start, durationMinutes, model, rawRows, true);
  }
  for (const start of changeovers.values()) {
    appendChangeoverInterval(start, durationMinutes, model, rawRows, true);
  }
  for (const failure of failures.values()) {
    appendFailureInterval(failure, durationMinutes, model, rawRows, true);
  }

  const allRows = [...rawRows.values()]
    .map((row) => ({ ...row, intervals: row.intervals.sort(byIntervalStart) }))
    .filter((row) => row.intervals.length > 0);
  const intervalCount = allRows.reduce((total, row) => total + row.intervals.length, 0);
  const bounded = boundIntervals(allRows, Math.max(1, Math.floor(maxIntervals)));
  return {
    durationMinutes,
    intervalCount,
    omittedIntervalCount: intervalCount - bounded.reduce((total, row) => total + row.intervals.length, 0),
    rows: bounded.map(assignLanes),
  };
}

function indexItemEvent(
  event: ItemEvent,
  model: PlantLiteModel,
  starts: Map<string, ItemEvent>,
  changeovers: Map<string, ItemEvent>,
  rows: Map<string, Omit<PlantLiteTimelineRow, "laneCount">>,
): void {
  const node = model.nodes.find((candidate) => candidate.id === event.nodeId);
  if (node?.kind !== "station" && node?.kind !== "transport") return;
  const key = `${event.itemId}\u0000${event.nodeId}`;
  if (event.type === "item-changeover-start") {
    changeovers.set(key, event);
    return;
  }
  if (event.type === "item-changeover-complete") {
    const start = changeovers.get(key);
    if (!start) return;
    changeovers.delete(key);
    appendChangeoverInterval(start, Math.max(start.atMinute, event.atMinute), model, rows, false);
    return;
  }
  if (event.type === "item-start") {
    starts.set(key, event);
    return;
  }
  if (event.type !== "item-complete") return;
  const start = starts.get(key);
  if (!start) return;
  starts.delete(key);
  appendItemInterval(start, Math.max(start.atMinute, event.atMinute), model, rows, false);
}

function appendChangeoverInterval(
  start: ItemEvent,
  endMinute: number,
  model: PlantLiteModel,
  rows: Map<string, Omit<PlantLiteTimelineRow, "laneCount">>,
  incomplete: boolean,
): void {
  const node = model.nodes.find((candidate) => candidate.id === start.nodeId);
  if (node?.kind !== "station") return;
  const from = productName(model, start.changeover?.fromProductTypeId);
  const to = productName(model, start.changeover?.toProductTypeId);
  rows.get(`node:${node.id}`)?.intervals.push({
    id: `${start.sequence}:${start.itemId}:changeover`,
    startMinute: start.atMinute,
    endMinute: Math.max(start.atMinute, endMinute),
    lane: 0,
    kind: "changeover",
    label: `${from} → ${to} · 换型`,
    incomplete,
  });
}

function appendItemInterval(
  start: ItemEvent,
  endMinute: number,
  model: PlantLiteModel,
  rows: Map<string, Omit<PlantLiteTimelineRow, "laneCount">>,
  incomplete: boolean,
): void {
  const node = model.nodes.find((candidate) => candidate.id === start.nodeId);
  if (node?.kind !== "station" && node?.kind !== "transport") return;
  rows.get(`node:${node.id}`)?.intervals.push({
    id: `${start.sequence}:${start.itemId}`,
    startMinute: start.atMinute,
    endMinute: Math.max(start.atMinute, endMinute),
    lane: 0,
    kind: node.kind === "transport" ? "transport" : "processing",
    label: `${shortItemId(start.itemId)} · ${node.name}`,
    incomplete,
  });
}

function indexResourceEvent(
  event: ResourceEvent,
  model: PlantLiteModel,
  failures: Map<string, ResourceEvent>,
  rows: Map<string, Omit<PlantLiteTimelineRow, "laneCount">>,
): void {
  if (!model.resources?.some((resource) => resource.id === event.resourceId)) return;
  const key = resourceUnitKey(event);
  if (event.type === "resource-failure") {
    failures.set(key, event);
    return;
  }
  const start = failures.get(key);
  if (!start) return;
  failures.delete(key);
  appendFailureInterval(start, Math.max(start.atMinute, event.atMinute), model, rows, false);
}

function appendFailureInterval(
  start: ResourceEvent,
  endMinute: number,
  model: PlantLiteModel,
  rows: Map<string, Omit<PlantLiteTimelineRow, "laneCount">>,
  incomplete: boolean,
): void {
  const resource = model.resources?.find((candidate) => candidate.id === start.resourceId);
  if (!resource) return;
  const unit = start.unitIndex === undefined ? "全部单元" : `${start.unitIndex + 1} 号单元`;
  rows.get(`resource:${resource.id}`)?.intervals.push({
    id: `${start.sequence}:${resource.id}:${start.unitIndex ?? "all"}`,
    startMinute: start.atMinute,
    endMinute: Math.max(start.atMinute, endMinute),
    lane: 0,
    kind: "failure",
    label: `${resource.name} · ${unit}`,
    incomplete,
  });
}

function boundIntervals(
  rows: Array<Omit<PlantLiteTimelineRow, "laneCount">>,
  maximum: number,
): Array<Omit<PlantLiteTimelineRow, "laneCount">> {
  const selected = rows.map((row) => ({ ...row, intervals: [] as PlantLiteTimelineInterval[] }));
  let count = 0;
  let depth = 0;
  while (count < maximum) {
    let found = false;
    for (let rowIndex = 0; rowIndex < rows.length && count < maximum; rowIndex += 1) {
      const interval = rows[rowIndex]!.intervals[depth];
      if (!interval) continue;
      selected[rowIndex]!.intervals.push(interval);
      count += 1;
      found = true;
    }
    if (!found) break;
    depth += 1;
  }
  return selected.filter((row) => row.intervals.length > 0);
}

function assignLanes(row: Omit<PlantLiteTimelineRow, "laneCount">): PlantLiteTimelineRow {
  const laneEnds: number[] = [];
  const intervals = row.intervals.map((interval) => {
    let lane = laneEnds.findIndex((end) => end <= interval.startMinute);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = interval.endMinute;
    return { ...interval, lane };
  });
  return { ...row, laneCount: Math.max(1, laneEnds.length), intervals };
}

function resourceUnitKey(event: ResourceEvent): string {
  return `${event.resourceId}\u0000${event.unitIndex ?? "all"}`;
}

function shortItemId(value: string): string {
  const suffix = value.split(":").at(-1) ?? value;
  return `物料 ${suffix}`;
}

function productName(model: PlantLiteModel, id: string | undefined): string {
  if (!id) return "未知产品";
  return model.productTypes?.find((product) => product.id === id)?.name ?? id;
}

function byTimeAndSequence(left: PlantLiteTraceEvent, right: PlantLiteTraceEvent): number {
  return left.atMinute - right.atMinute || left.sequence - right.sequence;
}

function byIntervalStart(left: PlantLiteTimelineInterval, right: PlantLiteTimelineInterval): number {
  return left.startMinute - right.startMinute || left.endMinute - right.endMinute || left.id.localeCompare(right.id);
}
