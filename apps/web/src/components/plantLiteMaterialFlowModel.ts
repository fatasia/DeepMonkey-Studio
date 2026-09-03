import type {
  PlantLiteModel,
  PlantLiteReplicationTrace,
  PlantLiteTraceEvent,
} from "@bim-studio/contracts";

type ItemTraceEvent = Extract<PlantLiteTraceEvent, { itemId: string }>;
type TimedNodeKind = "station" | "transport";
type TimedPlantLiteNode = Extract<PlantLiteModel["nodes"][number], { kind: TimedNodeKind }>;

export interface PlantLiteDurationDistribution {
  samples: number;
  meanMinutes: number;
  p50Minutes: number;
  p95Minutes: number;
  minimumMinutes: number;
  maximumMinutes: number;
}

export interface PlantLiteEdgeFlow {
  edgeId: string;
  fromNodeId: string;
  fromNodeName: string;
  toNodeId: string;
  toNodeName: string;
  /** 并行边没有 edgeId 事件证据时为 null，避免把同一次转移重复归给多条边。 */
  capturedTransferCount: number | null;
  routeCapturedTransferCount: number;
  attribution: "exact" | "parallel-route-total";
}

export interface PlantLiteNodeTiming {
  nodeId: string;
  nodeName: string;
  kind: TimedNodeKind;
  waiting: PlantLiteDurationDistribution | null;
  processing: PlantLiteDurationDistribution | null;
}

export interface PlantLiteMaterialFlowResult {
  edgeFlows: PlantLiteEdgeFlow[];
  nodeTimings: PlantLiteNodeTiming[];
  pairedTransferCount: number;
  unpairedExitCount: number;
  transfersOutsideModel: number;
  capturedItemCount: number;
  omittedEventCount: number;
  truncated: boolean;
}

interface NodeVisit {
  enteredAt: number;
  changeoverStartedAt: number | undefined;
  startedAt: number | undefined;
  completedAt: number | undefined;
}

export function derivePlantLiteMaterialFlowAnalysis(
  model: PlantLiteModel,
  trace: PlantLiteReplicationTrace,
): PlantLiteMaterialFlowResult {
  const itemEvents = groupItemEvents(trace.events);
  const routeCounts = new Map<string, number>();
  let pairedTransferCount = 0;
  let unpairedExitCount = 0;

  for (const events of itemEvents.values()) {
    let pendingExit: ItemTraceEvent | undefined;
    for (const event of events) {
      if (event.type === "item-exit") {
        if (pendingExit) unpairedExitCount += 1;
        pendingExit = event;
        continue;
      }
      if (event.type !== "item-enter" || !pendingExit) continue;
      const route = routeKey(pendingExit.nodeId, event.nodeId);
      routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1);
      pairedTransferCount += 1;
      pendingExit = undefined;
    }
    if (pendingExit) unpairedExitCount += 1;
  }

  const edgeIdsByRoute = new Map<string, string[]>();
  for (const edge of model.edges) {
    const route = routeKey(edge.from, edge.to);
    edgeIdsByRoute.set(route, [...(edgeIdsByRoute.get(route) ?? []), edge.id]);
  }
  const knownRoutes = new Set(edgeIdsByRoute.keys());
  const transfersOutsideModel = [...routeCounts.entries()]
    .filter(([route]) => !knownRoutes.has(route))
    .reduce((total, [, count]) => total + count, 0);
  const nodeNames = new Map(model.nodes.map((node) => [node.id, node.name]));

  return {
    edgeFlows: model.edges.map((edge) => {
      const route = routeKey(edge.from, edge.to);
      const routeCapturedTransferCount = routeCounts.get(route) ?? 0;
      const exact = edgeIdsByRoute.get(route)?.length === 1;
      return {
        edgeId: edge.id,
        fromNodeId: edge.from,
        fromNodeName: nodeNames.get(edge.from) ?? edge.from,
        toNodeId: edge.to,
        toNodeName: nodeNames.get(edge.to) ?? edge.to,
        capturedTransferCount: exact ? routeCapturedTransferCount : null,
        routeCapturedTransferCount,
        attribution: exact ? "exact" : "parallel-route-total",
      };
    }),
    nodeTimings: deriveNodeTimings(model, itemEvents),
    pairedTransferCount,
    unpairedExitCount,
    transfersOutsideModel,
    capturedItemCount: trace.capturedItemCount,
    omittedEventCount: trace.omittedEventCount,
    truncated: trace.truncated,
  };
}

function deriveNodeTimings(
  model: PlantLiteModel,
  itemEvents: Map<string, ItemTraceEvent[]>,
): PlantLiteNodeTiming[] {
  const timedNodes = model.nodes.filter((node): node is TimedPlantLiteNode =>
    node.kind === "station" || node.kind === "transport");
  const timedNodeIds = new Set(timedNodes.map((node) => node.id));
  const visitsByNode = new Map<string, NodeVisit[]>();

  for (const events of itemEvents.values()) {
    const itemVisits = new Map<string, NodeVisit[]>();
    for (const event of events) {
      if (!timedNodeIds.has(event.nodeId)) continue;
      const visits = itemVisits.get(event.nodeId) ?? [];
      if (event.type === "item-enter") {
        visits.push({ enteredAt: event.atMinute, changeoverStartedAt: undefined, startedAt: undefined, completedAt: undefined });
        itemVisits.set(event.nodeId, visits);
        continue;
      }
      if (event.type === "item-changeover-start") {
        const visit = visits.findLast((candidate) => candidate.startedAt === undefined && event.atMinute >= candidate.enteredAt);
        if (visit) visit.changeoverStartedAt = event.atMinute;
        continue;
      }
      if (event.type === "item-start") {
        const visit = visits.findLast((candidate) => candidate.startedAt === undefined && event.atMinute >= candidate.enteredAt);
        if (visit) visit.startedAt = event.atMinute;
        continue;
      }
      if (event.type === "item-complete") {
        const visit = visits.findLast((candidate) => candidate.startedAt !== undefined && candidate.completedAt === undefined && event.atMinute >= candidate.startedAt);
        if (visit) visit.completedAt = event.atMinute;
      }
    }
    for (const [nodeId, visits] of itemVisits) {
      visitsByNode.set(nodeId, [...(visitsByNode.get(nodeId) ?? []), ...visits]);
    }
  }

  return timedNodes.map((node) => {
    const visits = visitsByNode.get(node.id) ?? [];
    const waitingSamples = visits.flatMap((visit) =>
      visit.startedAt === undefined ? [] : [(visit.changeoverStartedAt ?? visit.startedAt) - visit.enteredAt]);
    const processingSamples = visits.flatMap((visit) =>
      visit.startedAt === undefined || visit.completedAt === undefined ? [] : [visit.completedAt - visit.startedAt]);
    return {
      nodeId: node.id,
      nodeName: node.name,
      kind: node.kind,
      waiting: summarizeDurations(waitingSamples),
      processing: summarizeDurations(processingSamples),
    };
  });
}

function summarizeDurations(samples: number[]): PlantLiteDurationDistribution | null {
  const ordered = samples.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (!ordered.length) return null;
  return {
    samples: ordered.length,
    meanMinutes: ordered.reduce((total, value) => total + value, 0) / ordered.length,
    p50Minutes: percentile(ordered, 0.5),
    p95Minutes: percentile(ordered, 0.95),
    minimumMinutes: ordered[0]!,
    maximumMinutes: ordered.at(-1)!,
  };
}

function groupItemEvents(events: PlantLiteTraceEvent[]): Map<string, ItemTraceEvent[]> {
  const grouped = new Map<string, ItemTraceEvent[]>();
  for (const event of events) {
    if (!("itemId" in event) || !Number.isFinite(event.atMinute)) continue;
    grouped.set(event.itemId, [...(grouped.get(event.itemId) ?? []), event]);
  }
  for (const itemEvents of grouped.values()) itemEvents.sort(byTimeAndSequence);
  return grouped;
}

function percentile(ordered: number[], ratio: number): number {
  if (ordered.length === 1) return ordered[0]!;
  const position = (ordered.length - 1) * ratio;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = ordered[lowerIndex]!;
  const upper = ordered[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

function routeKey(fromNodeId: string, toNodeId: string): string {
  return JSON.stringify([fromNodeId, toNodeId]);
}

function byTimeAndSequence(left: ItemTraceEvent, right: ItemTraceEvent): number {
  return left.atMinute - right.atMinute || left.sequence - right.sequence;
}
