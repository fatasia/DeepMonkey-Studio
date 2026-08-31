import type {
  ConfidenceInterval,
  PlantLiteExperimentResult,
  PlantLiteReplication,
  PlantLiteModel,
} from "./model.js";
import { confidenceInterval95 } from "./statistics.js";
import type { Runtime } from "./runtimeTypes.js";

export function replicationMetrics(
  runtime: Runtime,
  replication: number,
  seed: number,
  termination: PlantLiteReplication["termination"],
  reason?: PlantLiteReplication["reason"],
): PlantLiteReplication {
  const duration = runtime.now || 1;
  const nodes = runtime.model.nodes.map((node) => {
    const state = required(runtime.states.get(node.id), `unknown node ${node.id}`);
    return {
      nodeId: node.id,
      utilization: isResourceNode(node) && state.availableArea ? state.busyArea / state.availableArea : 0,
      averageQueueLength: state.queueArea / duration,
      blockedMinutes: state.blocked,
      starvedMinutes: state.starved,
    };
  });
  const resources = (runtime.model.resources ?? []).map((resource) => {
    const state = required(runtime.resources.get(resource.id), `unknown resource ${resource.id}`);
    return {
      resourceId: resource.id,
      utilization: state.availableArea ? state.busyArea / state.availableArea : 0,
      failedMinutes: state.failedArea,
    };
  });
  const bottleneck = selectBottleneck(runtime.model, nodes);
  return {
    replication,
    seed,
    termination,
    ...(reason ? { reason } : {}),
    simulatedMinutes: runtime.now,
    processedEvents: runtime.eventsProcessed,
    completedItems: runtime.completed,
    throughputPerHour: runtime.completed * 60 / duration,
    averageWip: runtime.wipArea / duration,
    averageLeadTimeMinutes: runtime.completed ? runtime.leadTotal / runtime.completed : 0,
    ...(bottleneck ? { bottleneckNodeId: bottleneck.nodeId } : {}),
    nodes,
    resources,
  };
}

export function summarizeExperiment(seed: string | number, runs: PlantLiteReplication[]): PlantLiteExperimentResult {
  const complete = runs.filter((run) => run.termination === "completed");
  const ci = (select: (run: PlantLiteReplication) => number) => confidenceInterval95(complete.map(select));
  return {
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
    deterministic: true,
    seed,
    replications: runs,
    confidence95: {
      throughputPerHour: ci((run) => run.throughputPerHour),
      averageWip: ci((run) => run.averageWip),
      averageLeadTimeMinutes: ci((run) => run.averageLeadTimeMinutes),
    },
    nodeMetrics95: nodeMetrics(complete, ci),
    resourceUtilization95: resourceMetrics(complete, ci),
    bottlenecks: bottleneckFrequencies(complete),
  };
}

function nodeMetrics(runs: PlantLiteReplication[], ci: (select: (run: PlantLiteReplication) => number) => ConfidenceInterval): PlantLiteExperimentResult["nodeMetrics95"] {
  const result: PlantLiteExperimentResult["nodeMetrics95"] = {};
  const nodeIds = new Set(runs.flatMap((run) => run.nodes.map((node) => node.nodeId)));
  for (const nodeId of nodeIds) {
    result[nodeId] = {
      utilization: ci((run) => findNodeMetric(run, nodeId).utilization),
      averageQueueLength: ci((run) => findNodeMetric(run, nodeId).averageQueueLength),
      blockedMinutes: ci((run) => findNodeMetric(run, nodeId).blockedMinutes),
      starvedMinutes: ci((run) => findNodeMetric(run, nodeId).starvedMinutes),
    };
  }
  return result;
}

function resourceMetrics(runs: PlantLiteReplication[], ci: (select: (run: PlantLiteReplication) => number) => ConfidenceInterval): Record<string, ConfidenceInterval> {
  const result: Record<string, ConfidenceInterval> = {};
  const resourceIds = new Set(runs.flatMap((run) => run.resources.map((resource) => resource.resourceId)));
  for (const resourceId of resourceIds) {
    result[resourceId] = ci((run) => run.resources.find((resource) => resource.resourceId === resourceId)?.utilization ?? 0);
  }
  return result;
}

function bottleneckFrequencies(runs: PlantLiteReplication[]): PlantLiteExperimentResult["bottlenecks"] {
  const counts = new Map<string, number>();
  for (const run of runs) {
    if (run.bottleneckNodeId) counts.set(run.bottleneckNodeId, (counts.get(run.bottleneckNodeId) ?? 0) + 1);
  }
  return [...counts]
    .map(([nodeId, occurrences]) => ({ nodeId, occurrences, probability: occurrences / Math.max(1, runs.length) }))
    .sort((left, right) => right.occurrences - left.occurrences || left.nodeId.localeCompare(right.nodeId));
}

function selectBottleneck(model: PlantLiteModel, metrics: PlantLiteReplication["nodes"]) {
  return metrics
    .filter((metric) => model.nodes.some((node) => node.id === metric.nodeId && isResourceNode(node)))
    .sort((left, right) => right.utilization - left.utilization || right.blockedMinutes - left.blockedMinutes || left.nodeId.localeCompare(right.nodeId))[0];
}

function findNodeMetric(run: PlantLiteReplication, nodeId: string) {
  return required(run.nodes.find((node) => node.nodeId === nodeId), `missing node metric ${nodeId}`);
}

function isResourceNode(node: PlantLiteModel["nodes"][number]): boolean {
  return node.kind === "station" || node.kind === "transport";
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
