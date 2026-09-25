import type {
  ConfidenceInterval,
  PlantLiteExperimentResult,
  PlantLiteReplication,
  PlantLiteModel,
} from "./model.js";
import { confidenceInterval95 } from "./statistics.js";
import { plantLiteEnergyMetrics } from "./energyRuntime.js";
import { isKanbanBuffer } from "./kanbanRuntime.js";
import type { NodeState, Runtime } from "./runtimeTypes.js";

export function replicationMetrics(
  runtime: Runtime,
  replication: number,
  seed: number,
  termination: PlantLiteReplication["termination"],
  reason?: PlantLiteReplication["reason"],
): PlantLiteReplication {
  const measurementMinutes = Math.max(0, runtime.now - runtime.limits.warmupMinutes);
  const duration = measurementMinutes || 1;
  const nodes = runtime.model.nodes.map((node) => {
    const state = required(runtime.states.get(node.id), `unknown node ${node.id}`);
    return {
      nodeId: node.id,
      utilization: nodeUtilization(node, state, duration),
      averageQueueLength: state.queueArea / duration,
      blockedMinutes: state.blocked,
      starvedMinutes: state.starved,
      changeoverCount: state.changeoverCount,
      changeoverMinutes: state.changeoverArea,
      // 仅 split 与看板缓冲输出扩展指标；旧模型输出保持逐位不变。
      ...(node.kind === "split" && state.routeDelivered
        ? { routeDelivered: node.routes.map((route, index) => ({ to: route.to, items: state.routeDelivered![index] ?? 0 })) }
        : {}),
      ...(isKanbanBuffer(node) ? { kanbanWithdrawn: state.withdrawn ?? 0 } : {}),
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
  const bottleneck = selectBottleneck(runtime.model, nodes, duration);
  const energy = plantLiteEnergyMetrics(runtime);
  const productTypes = (runtime.model.productTypes ?? []).map((productType) => {
    const completedItems = runtime.completedByProductType.get(productType.id) ?? 0;
    return {
      productTypeId: productType.id,
      completedItems,
      completionShare: runtime.measuredCompleted ? completedItems / runtime.measuredCompleted : 0,
      throughputPerHour: completedItems * 60 / duration,
    };
  });
  const productionOrders = (runtime.model.productionOrders ?? []).map((order) => {
    const state = runtime.productionOrders.get(order.id);
    const completedItems = state?.completedItems ?? 0;
    const fullyCompleted = completedItems >= order.quantity;
    const completionMinute = state?.lastCompletionMinute === undefined
      ? undefined
      : Math.max(0, state.lastCompletionMinute - runtime.limits.warmupMinutes);
    const observedMinute = fullyCompleted ? completionMinute ?? 0 : Math.max(0, runtime.now - runtime.limits.warmupMinutes);
    return {
      orderId: order.id,
      plannedItems: order.quantity,
      releasedItems: state?.releasedItems ?? 0,
      completedItems,
      scrappedItems: state?.scrappedItems ?? 0,
      completedOnTimeItems: state?.completedOnTimeItems ?? 0,
      completionRate: completedItems / order.quantity,
      onTimeFulfillmentRate: (state?.completedOnTimeItems ?? 0) / order.quantity,
      fullyCompleted,
      ...(fullyCompleted && completionMinute !== undefined ? { completionMinute } : {}),
      observedTardinessMinutes: Math.max(0, observedMinute - order.dueMinute),
    };
  });
  const quality = runtime.qualityEnabled ? {
    goodOutputItems: runtime.measuredCompleted,
    scrapItems: runtime.measuredScrapped,
    dispositionItems: runtime.measuredCompleted + runtime.measuredScrapped,
    firstPassYield: qualityRatio(runtime.measuredCompleted, runtime.measuredCompleted + runtime.measuredScrapped),
    stations: runtime.model.nodes.flatMap((node) => {
      if (node.kind !== "station" || node.yieldRate === undefined) return [];
      const state = required(runtime.states.get(node.id), `unknown node ${node.id}`);
      return [{
        nodeId: node.id,
        inspectedItems: state.qualityInspected,
        goodItems: state.qualityPassed,
        scrapItems: state.qualityScrapped,
        firstPassYield: qualityRatio(state.qualityPassed, state.qualityInspected),
      }];
    }),
  } : undefined;
  return {
    replication,
    seed,
    termination,
    ...(reason ? { reason } : {}),
    simulatedMinutes: runtime.now,
    measurementMinutes,
    processedEvents: runtime.eventsProcessed,
    completedItems: runtime.measuredCompleted,
    throughputPerHour: runtime.measuredCompleted * 60 / duration,
    averageWip: runtime.wipArea / duration,
    averageLeadTimeMinutes: runtime.measuredCompleted ? runtime.leadTotal / runtime.measuredCompleted : 0,
    ...(bottleneck ? { bottleneckNodeId: bottleneck.nodeId } : {}),
    nodes,
    resources,
    productTypes,
    productionOrders,
    ...(quality ? { quality } : {}),
    ...(energy ? { energy } : {}),
  };
}

export function summarizeExperiment(seed: string | number, runs: PlantLiteReplication[]): PlantLiteExperimentResult {
  const complete = runs.filter((run) => run.termination === "completed");
  const ci = (select: (run: PlantLiteReplication) => number) => confidenceInterval95(complete.map(select));
  const energy95 = experimentEnergyMetrics(complete, ci);
  const quality95 = experimentQualityMetrics(complete, ci);
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
    resourceFailedMinutes95: resourceFailureMetrics(complete, ci),
    productTypeMetrics95: productTypeMetrics(complete, ci),
    productionOrderMetrics95: productionOrderMetrics(complete, ci),
    ...(quality95 ? { quality95 } : {}),
    ...(energy95 ? { energy95 } : {}),
    bottlenecks: bottleneckFrequencies(complete),
  };
}

function productionOrderMetrics(
  runs: PlantLiteReplication[],
  ci: (select: (run: PlantLiteReplication) => number) => ConfidenceInterval,
): PlantLiteExperimentResult["productionOrderMetrics95"] {
  // 订单 ID 来自用户输入，空原型对象避免 `__proto__` 等合法 ID 被对象原型吞掉。
  const result = Object.create(null) as PlantLiteExperimentResult["productionOrderMetrics95"];
  const orderIds = new Set(runs.flatMap((run) => run.productionOrders.map((order) => order.orderId)));
  for (const orderId of orderIds) {
    const find = (run: PlantLiteReplication) => run.productionOrders.find((order) => order.orderId === orderId);
    result[orderId] = {
      completedItems: ci((run) => find(run)?.completedItems ?? 0),
      completionRate: boundedShareInterval(ci((run) => find(run)?.completionRate ?? 0)),
      onTimeFulfillmentRate: boundedShareInterval(ci((run) => find(run)?.onTimeFulfillmentRate ?? 0)),
      fullyCompletedRate: boundedShareInterval(ci((run) => find(run)?.fullyCompleted ? 1 : 0)),
      observedTardinessMinutes: ci((run) => find(run)?.observedTardinessMinutes ?? 0),
    };
  }
  return result;
}

function experimentQualityMetrics(
  runs: PlantLiteReplication[],
  ci: (select: (run: PlantLiteReplication) => number) => ConfidenceInterval,
): PlantLiteExperimentResult["quality95"] {
  if (!runs.length || runs.some((run) => !run.quality)) return undefined;
  const firstPassRuns = runs.filter((run) => (run.quality?.dispositionItems ?? 0) > 0);
  const stationMetrics95: NonNullable<PlantLiteExperimentResult["quality95"]>["stationMetrics95"] = {};
  const stationIds = new Set(runs.flatMap((run) => run.quality?.stations.map((station) => station.nodeId) ?? []));
  for (const nodeId of stationIds) {
    const find = (run: PlantLiteReplication) => run.quality?.stations.find((station) => station.nodeId === nodeId);
    const inspectedRuns = runs.filter((run) => (find(run)?.inspectedItems ?? 0) > 0);
    stationMetrics95[nodeId] = {
      inspectedItems: ci((run) => find(run)?.inspectedItems ?? 0),
      goodItems: ci((run) => find(run)?.goodItems ?? 0),
      scrapItems: ci((run) => find(run)?.scrapItems ?? 0),
      firstPassYield: boundedShareInterval(confidenceInterval95(inspectedRuns.map((run) => find(run)?.firstPassYield ?? 0))),
    };
  }
  return {
    goodOutputItems: ci((run) => run.quality?.goodOutputItems ?? 0),
    scrapItems: ci((run) => run.quality?.scrapItems ?? 0),
    firstPassYield: boundedShareInterval(confidenceInterval95(firstPassRuns.map((run) => run.quality?.firstPassYield ?? 0))),
    stationMetrics95,
  };
}

function qualityRatio(goodItems: number, dispositionItems: number): number {
  return dispositionItems > 0 ? goodItems / dispositionItems : 0;
}

function productTypeMetrics(
  runs: PlantLiteReplication[],
  ci: (select: (run: PlantLiteReplication) => number) => ConfidenceInterval,
): PlantLiteExperimentResult["productTypeMetrics95"] {
  const result: PlantLiteExperimentResult["productTypeMetrics95"] = {};
  const productTypeIds = new Set(runs.flatMap((run) => run.productTypes.map((productType) => productType.productTypeId)));
  for (const productTypeId of productTypeIds) {
    const find = (run: PlantLiteReplication) => run.productTypes.find((productType) => productType.productTypeId === productTypeId);
    const runsWithCompletedItems = runs.filter((run) => run.completedItems > 0);
    result[productTypeId] = {
      completedItems: ci((run) => find(run)?.completedItems ?? 0),
      completionShare: boundedShareInterval(confidenceInterval95(runsWithCompletedItems.map((run) => find(run)?.completionShare ?? 0))),
      throughputPerHour: ci((run) => find(run)?.throughputPerHour ?? 0),
    };
  }
  return result;
}

function boundedShareInterval(interval: ConfidenceInterval): ConfidenceInterval {
  return { ...interval, lower95: Math.max(0, interval.lower95), upper95: Math.min(1, interval.upper95) };
}

function experimentEnergyMetrics(
  runs: PlantLiteReplication[],
  ci: (select: (run: PlantLiteReplication) => number) => ConfidenceInterval,
): PlantLiteExperimentResult["energy95"] {
  if (!runs.length || runs.some((run) => !run.energy)) return undefined;
  const select = (field: keyof Omit<NonNullable<PlantLiteReplication["energy"]>, "consumers">) =>
    ci((run) => run.energy?.[field] ?? 0);
  const unitRuns = runs.filter((run) => run.completedItems > 0);
  const selectUnit = (field: keyof Omit<NonNullable<PlantLiteReplication["energy"]>, "consumers">) =>
    confidenceInterval95(unitRuns.map((run) => run.energy?.[field] ?? 0));
  const consumerEnergyKwh: Record<string, ConfidenceInterval> = {};
  const consumerIds = new Set(runs.flatMap((run) => run.energy?.consumers.map((consumer) => consumer.consumerId) ?? []));
  for (const consumerId of consumerIds) {
    consumerEnergyKwh[consumerId] = ci((run) => run.energy?.consumers.find((consumer) => consumer.consumerId === consumerId)?.totalEnergyKwh ?? 0);
  }
  return {
    activeEnergyKwh: select("activeEnergyKwh"),
    idleEnergyKwh: select("idleEnergyKwh"),
    totalEnergyKwh: select("totalEnergyKwh"),
    energyPerCompletedItemKwh: selectUnit("energyPerCompletedItemKwh"),
    electricityCost: select("electricityCost"),
    electricityCostPerCompletedItem: selectUnit("electricityCostPerCompletedItem"),
    carbonEmissionKg: select("carbonEmissionKg"),
    carbonEmissionPerCompletedItemKg: selectUnit("carbonEmissionPerCompletedItemKg"),
    peakDemandKw: select("peakDemandKw"),
    consumerEnergyKwh,
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
      changeoverCount: ci((run) => findNodeMetric(run, nodeId).changeoverCount),
      changeoverMinutes: ci((run) => findNodeMetric(run, nodeId).changeoverMinutes),
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

function resourceFailureMetrics(runs: PlantLiteReplication[], ci: (select: (run: PlantLiteReplication) => number) => ConfidenceInterval): Record<string, ConfidenceInterval> {
  const result: Record<string, ConfidenceInterval> = {};
  const resourceIds = new Set(runs.flatMap((run) => run.resources.map((resource) => resource.resourceId)));
  for (const resourceId of resourceIds) {
    result[resourceId] = ci((run) => run.resources.find((resource) => resource.resourceId === resourceId)?.failedMinutes ?? 0);
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

function selectBottleneck(model: PlantLiteModel, metrics: PlantLiteReplication["nodes"], duration: number) {
  return metrics
    .filter((metric) => {
      const node = model.nodes.find((candidate) => candidate.id === metric.nodeId);
      return !!node && (isResourceNode(node) || (isBufferNode(node) && metric.blockedMinutes > 0));
    })
    .sort((left, right) => bottleneckScore(right, duration) - bottleneckScore(left, duration) || left.nodeId.localeCompare(right.nodeId))[0];
}

function bottleneckScore(metric: PlantLiteReplication["nodes"][number], duration: number): number {
  return metric.utilization + Math.min(1, metric.blockedMinutes / Math.max(1, duration));
}

function findNodeMetric(run: PlantLiteReplication, nodeId: string) {
  return required(run.nodes.find((node) => node.nodeId === nodeId), `missing node metric ${nodeId}`);
}

function isResourceNode(node: PlantLiteModel["nodes"][number]): boolean {
  return node.kind === "station" || node.kind === "transport";
}

function isBufferNode(node: PlantLiteModel["nodes"][number]): node is Extract<PlantLiteModel["nodes"][number], { kind: "buffer" | "queue-buffer" }> {
  return node.kind === "buffer" || node.kind === "queue-buffer";
}

function nodeUtilization(
  node: PlantLiteModel["nodes"][number],
  state: NodeState,
  duration: number,
): number {
  if (isResourceNode(node)) return state.availableArea ? Math.min(1, state.busyArea / state.availableArea) : 0;
  if (isBufferNode(node)) return Math.min(1, state.queueArea / Math.max(1, node.capacity * duration));
  return 0;
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
