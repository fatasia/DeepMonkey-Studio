import type {
  PlantLiteModel,
  PlantLiteReplicationTrace,
  PlantLiteTraceEvent,
} from "@bim-studio/contracts";
import {
  boundPlantLiteStepPoints,
  boundedPlantLiteSeriesOption,
  orderPlantLiteTraceEvents,
  readPlantLiteTraceCaptureEvidence,
} from "./plantLiteFlowSeriesSupport";

type ItemEvent = Extract<PlantLiteTraceEvent, { itemId: string }>;
type TrackOrigin = "entered" | "inferred";

export interface PlantLiteFlowPoint {
  atMinute: number;
  sequence: number;
  wip: number;
  completedItems: number;
}

export interface PlantLiteOccupancyPoint {
  atMinute: number;
  sequence: number;
  occupancy: number;
}

export interface PlantLiteNodeOccupancySeries {
  nodeId: string;
  nodeName: string;
  nodeKind: "station" | "transport" | "buffer";
  peakOccupancy: number;
  finalOccupancy: number;
  occupiedItemMinutes: number;
  points: PlantLiteOccupancyPoint[];
}

export interface PlantLiteFlowEvidence {
  captureStatus: "complete" | "truncated" | "unknown";
  replication: number | null;
  capturedItemCount: number;
  omittedEventCount: number | null;
  limits: { maxEvents: number; maxItems: number } | null;
  invalidEventCount: number;
  inferredTransitionCount: number;
  unmatchedExitCount: number;
}

export interface PlantLiteFlowSeriesResult {
  durationMinutes: number;
  peakWip: number;
  completedItems: number;
  scrappedItems: number;
  flowPoints: PlantLiteFlowPoint[];
  nodeSeries: PlantLiteNodeOccupancySeries[];
  activeNodeCount: number;
  omittedNodeSeriesCount: number;
  omittedVisualizationPointCount: number;
  evidence: PlantLiteFlowEvidence;
}

export interface PlantLiteFlowSeriesOptions {
  maxNodeSeries?: number;
  maxPointsPerSeries?: number;
}

interface ItemLocation {
  nodeId: string;
  origin: TrackOrigin;
}

interface MutableNodeTrack {
  nodeId: string;
  nodeName: string;
  nodeKind: PlantLiteNodeOccupancySeries["nodeKind"];
  modelIndex: number;
  occupancy: number;
  peakOccupancy: number;
  points: PlantLiteOccupancyPoint[];
}

const DEFAULT_MAX_NODE_SERIES = 4;
const DEFAULT_MAX_POINTS_PER_SERIES = 360;

/**
 * Derives a bounded chart from one saved DES trace. Values are captured-event
 * evidence only; this function never promotes a representative replication to
 * aggregate study statistics.
 */
export function derivePlantLiteFlowSeries(
  trace: PlantLiteReplicationTrace,
  model: PlantLiteModel,
  options: PlantLiteFlowSeriesOptions = {},
): PlantLiteFlowSeriesResult {
  const maxNodeSeries = boundedPlantLiteSeriesOption(options.maxNodeSeries, DEFAULT_MAX_NODE_SERIES, 1, 6);
  const maxPointsPerSeries = boundedPlantLiteSeriesOption(options.maxPointsPerSeries, DEFAULT_MAX_POINTS_PER_SERIES, 8, 1_000);
  const nodeIds = new Set(model.nodes.map((node) => node.id));
  const sourceIds = new Set(model.nodes.filter((node) => node.kind === "source").map((node) => node.id));
  const sinkIds = new Set(model.nodes.filter((node) => node.kind === "sink").map((node) => node.id));
  const nodeTracks = createNodeTracks(model);
  const looseTrace = trace as Partial<PlantLiteReplicationTrace>;
  const orderedTrace = orderPlantLiteTraceEvents(looseTrace);
  let { invalidEventCount } = orderedTrace;
  const { ordered } = orderedTrace;
  const durationMinutes = ordered.at(-1)?.event.atMinute ?? 0;

  const activeItems = new Set<string>();
  const completedItems = new Set<string>();
  const scrappedItems = new Set<string>();
  const recordedItems = new Set<string>();
  const locations = new Map<string, ItemLocation>();
  const flowPoints: PlantLiteFlowPoint[] = [{ atMinute: 0, sequence: -1, wip: 0, completedItems: 0 }];
  let inferredTransitionCount = 0;
  let unmatchedExitCount = 0;
  let peakWip = 0;

  const appendNodePoint = (track: MutableNodeTrack, atMinute: number, sequence: number) => {
    track.peakOccupancy = Math.max(track.peakOccupancy, track.occupancy);
    const previous = track.points.at(-1);
    if (previous?.occupancy === track.occupancy) return;
    track.points.push({ atMinute, sequence, occupancy: track.occupancy });
  };

  const removeLocation = (itemId: string, atMinute: number, sequence: number): boolean => {
    const location = locations.get(itemId);
    if (!location) return false;
    locations.delete(itemId);
    const track = nodeTracks.get(location.nodeId);
    if (track) {
      track.occupancy = Math.max(0, track.occupancy - 1);
      appendNodePoint(track, atMinute, sequence);
    }
    return true;
  };

  const moveLocation = (itemId: string, nodeId: string, origin: TrackOrigin, atMinute: number, sequence: number) => {
    const previous = locations.get(itemId);
    if (previous?.nodeId === nodeId) {
      if (origin === "entered") locations.set(itemId, { nodeId, origin });
      return;
    }
    if (previous) removeLocation(itemId, atMinute, sequence);
    locations.set(itemId, { nodeId, origin });
    const track = nodeTracks.get(nodeId);
    if (track) {
      track.occupancy += 1;
      appendNodePoint(track, atMinute, sequence);
    }
  };

  for (const { event, sequence } of ordered) {
    if (!("itemId" in event)) continue;
    if (!event.itemId || !nodeIds.has(event.nodeId)) {
      invalidEventCount += 1;
      continue;
    }
    recordedItems.add(event.itemId);
    const nodeIsSink = sinkIds.has(event.nodeId);
    const nodeIsSource = sourceIds.has(event.nodeId);
    let flowChanged = false;

    if (event.type === "item-enter" && nodeIsSource) {
      if (!completedItems.has(event.itemId) && !activeItems.has(event.itemId)) {
        activeItems.add(event.itemId);
        flowChanged = true;
      }
    } else if (!activeItems.has(event.itemId) && !completedItems.has(event.itemId) && !scrappedItems.has(event.itemId) && event.type !== "item-complete" && event.type !== "item-scrap") {
      activeItems.add(event.itemId);
      inferredTransitionCount += 1;
      flowChanged = true;
    }

    if (event.type === "item-enter") {
      const previous = locations.get(event.itemId);
      if (previous && previous.nodeId !== event.nodeId) inferredTransitionCount += 1;
      moveLocation(event.itemId, event.nodeId, "entered", event.atMinute, sequence);
    } else if (event.type === "item-exit") {
      const location = locations.get(event.itemId);
      if (!location || location.nodeId !== event.nodeId) unmatchedExitCount += 1;
      else removeLocation(event.itemId, event.atMinute, sequence);
    } else if (event.type === "item-start" || event.type === "item-changeover-start") {
      const location = locations.get(event.itemId);
      if (!location || location.nodeId !== event.nodeId) {
        moveLocation(event.itemId, event.nodeId, "inferred", event.atMinute, sequence);
        inferredTransitionCount += 1;
      }
    } else if (event.type === "item-complete" && nodeIsSink) {
      removeLocation(event.itemId, event.atMinute, sequence);
      if (!completedItems.has(event.itemId)) {
        completedItems.add(event.itemId);
        if (activeItems.delete(event.itemId)) flowChanged = true;
        else inferredTransitionCount += 1;
        flowChanged = true;
      }
    } else if (event.type === "item-complete") {
      const location = locations.get(event.itemId);
      if (location?.nodeId === event.nodeId && location.origin === "inferred") {
        removeLocation(event.itemId, event.atMinute, sequence);
      }
    } else if (event.type === "item-scrap") {
      removeLocation(event.itemId, event.atMinute, sequence);
      if (!scrappedItems.has(event.itemId)) {
        scrappedItems.add(event.itemId);
        if (activeItems.delete(event.itemId)) flowChanged = true;
        else inferredTransitionCount += 1;
      }
    }

    if (flowChanged) {
      peakWip = Math.max(peakWip, activeItems.size);
      appendFlowPoint(flowPoints, event.atMinute, sequence, activeItems.size, completedItems.size);
    }
  }

  appendFlowEndpoint(flowPoints, durationMinutes);
  for (const track of nodeTracks.values()) appendNodeEndpoint(track, durationMinutes);
  const activeTracks = [...nodeTracks.values()].filter((track) => track.peakOccupancy > 0);
  activeTracks.sort((left, right) =>
    right.peakOccupancy - left.peakOccupancy
    || occupiedItemMinutes(right.points, durationMinutes) - occupiedItemMinutes(left.points, durationMinutes)
    || left.modelIndex - right.modelIndex);
  const selectedTracks = activeTracks.slice(0, maxNodeSeries);
  let omittedVisualizationPointCount = 0;
  const boundedFlow = boundPlantLiteStepPoints(flowPoints, maxPointsPerSeries, (point) => point.wip);
  omittedVisualizationPointCount += flowPoints.length - boundedFlow.length;
  const nodeSeries = selectedTracks.map((track): PlantLiteNodeOccupancySeries => {
    const bounded = boundPlantLiteStepPoints(track.points, maxPointsPerSeries, (point) => point.occupancy);
    omittedVisualizationPointCount += track.points.length - bounded.length;
    return {
      nodeId: track.nodeId,
      nodeName: track.nodeName,
      nodeKind: track.nodeKind,
      peakOccupancy: track.peakOccupancy,
      finalOccupancy: track.occupancy,
      occupiedItemMinutes: occupiedItemMinutes(track.points, durationMinutes),
      points: bounded,
    };
  });

  return {
    durationMinutes,
    peakWip,
    completedItems: completedItems.size,
    scrappedItems: scrappedItems.size,
    flowPoints: boundedFlow,
    nodeSeries,
    activeNodeCount: activeTracks.length,
    omittedNodeSeriesCount: Math.max(0, activeTracks.length - selectedTracks.length),
    omittedVisualizationPointCount,
    evidence: {
      ...readPlantLiteTraceCaptureEvidence(looseTrace, recordedItems.size),
      invalidEventCount,
      inferredTransitionCount,
      unmatchedExitCount,
    },
  };
}

function createNodeTracks(model: PlantLiteModel): Map<string, MutableNodeTrack> {
  const tracks = new Map<string, MutableNodeTrack>();
  model.nodes.forEach((node, modelIndex) => {
    if (node.kind !== "station" && node.kind !== "transport" && node.kind !== "buffer" && node.kind !== "queue-buffer") return;
    tracks.set(node.id, {
      nodeId: node.id,
      nodeName: node.name,
      nodeKind: node.kind === "queue-buffer" ? "buffer" : node.kind,
      modelIndex,
      occupancy: 0,
      peakOccupancy: 0,
      points: [{ atMinute: 0, sequence: -1, occupancy: 0 }],
    });
  });
  return tracks;
}

function appendFlowPoint(points: PlantLiteFlowPoint[], atMinute: number, sequence: number, wip: number, completedItems: number): void {
  const previous = points.at(-1);
  if (previous?.wip === wip && previous.completedItems === completedItems) return;
  points.push({ atMinute, sequence, wip: Math.max(0, wip), completedItems: Math.max(0, completedItems) });
}

function appendFlowEndpoint(points: PlantLiteFlowPoint[], durationMinutes: number): void {
  const previous = points.at(-1)!;
  if (durationMinutes > previous.atMinute) points.push({ ...previous, atMinute: durationMinutes, sequence: Number.MAX_SAFE_INTEGER });
}

function appendNodeEndpoint(track: MutableNodeTrack, durationMinutes: number): void {
  const previous = track.points.at(-1)!;
  if (durationMinutes > previous.atMinute) track.points.push({ ...previous, atMinute: durationMinutes, sequence: Number.MAX_SAFE_INTEGER });
}

function occupiedItemMinutes(points: PlantLiteOccupancyPoint[], durationMinutes: number): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index]!;
    const nextMinute = points[index + 1]?.atMinute ?? durationMinutes;
    area += point.occupancy * Math.max(0, nextMinute - point.atMinute);
  }
  return area;
}
