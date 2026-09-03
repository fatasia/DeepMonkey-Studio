import type { PlantLiteStudyRequest } from "@bim-studio/contracts";
import {
  createAgvLinePlantLiteModel,
  validatePlantLiteModel,
  type PlantLiteModel,
  type PlantLiteNode,
  type Distribution,
} from "@bim-studio/plant-lite-simulation";
import { plantLiteAcceptanceTargetIssues } from "./plantLiteAcceptanceEditing";

export type PlantLiteNodeKind = PlantLiteNode["kind"];
export type PlantLiteCanonicalNodeKind = Exclude<PlantLiteNodeKind, "buffer">;

export const PLANT_NODE_LABELS: Record<PlantLiteCanonicalNodeKind, string> = {
  source: "来料源",
  station: "工位",
  "queue-buffer": "缓冲区",
  transport: "搬运",
  sink: "产出",
};

export function createDefaultPlantLiteRequest(): PlantLiteStudyRequest {
  return {
    name: "AGV 两工位产线基线",
    templateId: "agv-line-v1",
    model: createAgvLinePlantLiteModel(),
    seed: "plant-lite-baseline",
    replications: 12,
  };
}

export function resetPlantLiteModel(request: PlantLiteStudyRequest): PlantLiteStudyRequest {
  const { agvCount: _agvCount, bufferCapacity: _bufferCapacity, ...current } = request;
  return { ...current, templateId: "agv-line-v1", model: createAgvLinePlantLiteModel() };
}

export function addPlantLiteNode(model: PlantLiteModel, kind: PlantLiteCanonicalNodeKind): PlantLiteModel {
  const next = structuredClone(model);
  if ((kind === "source" || kind === "sink") && next.nodes.some((node) => node.kind === kind)) return next;
  const node = createNode(next, kind);
  const sinkIndex = next.nodes.findIndex((candidate) => candidate.kind === "sink");
  const insertionIndex = kind === "source"
    ? 0
    : kind === "sink"
      ? next.nodes.length
      : sinkIndex >= 0 ? sinkIndex : next.nodes.length;
  next.nodes.splice(insertionIndex, 0, node);
  next.edges = sequentialEdges(next.nodes);
  ensurePlantLiteResources(next);
  return next;
}

export function removePlantLiteNode(model: PlantLiteModel, nodeId: string): PlantLiteModel {
  const next = structuredClone(model);
  next.nodes = next.nodes.filter((node) => node.id !== nodeId);
  next.edges = sequentialEdges(next.nodes);
  ensurePlantLiteResources(next);
  return next;
}

export function movePlantLiteNode(model: PlantLiteModel, nodeId: string, offset: -1 | 1): PlantLiteModel {
  const next = structuredClone(model);
  const index = next.nodes.findIndex((node) => node.id === nodeId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= next.nodes.length) return next;
  const node = next.nodes[index];
  const targetNode = next.nodes[target];
  if (!node || !targetNode || node.kind === "source" || node.kind === "sink" || targetNode.kind === "source" || targetNode.kind === "sink") return next;
  next.nodes.splice(index, 1);
  next.nodes.splice(target, 0, node);
  next.edges = sequentialEdges(next.nodes);
  return next;
}

export function reorderPlantLiteNode(model: PlantLiteModel, movingId: string, targetId: string): PlantLiteModel {
  const next = structuredClone(model);
  const movingIndex = next.nodes.findIndex((node) => node.id === movingId);
  const targetIndex = next.nodes.findIndex((node) => node.id === targetId);
  const moving = next.nodes[movingIndex];
  const target = next.nodes[targetIndex];
  if (movingIndex < 0 || targetIndex < 0 || movingIndex === targetIndex || !moving || !target) return next;
  if (moving.kind === "source" || moving.kind === "sink" || target.kind === "source") return next;
  next.nodes.splice(movingIndex, 1);
  const targetAfterRemoval = next.nodes.findIndex((node) => node.id === targetId);
  const insertion = movingIndex < targetIndex && target.kind !== "sink"
    ? targetAfterRemoval + 1
    : targetAfterRemoval;
  next.nodes.splice(insertion, 0, moving);
  next.edges = sequentialEdges(next.nodes);
  return next;
}

export function replacePlantLiteNode(model: PlantLiteModel, replacement: PlantLiteNode): PlantLiteModel {
  const next = structuredClone(model);
  const index = next.nodes.findIndex((node) => node.id === replacement.id);
  if (index >= 0) next.nodes[index] = structuredClone(replacement);
  ensurePlantLiteResources(next);
  return next;
}

export function setPlantLiteStationEquipment(model: PlantLiteModel, stationId: string, enabled: boolean): PlantLiteModel {
  const next = structuredClone(model);
  const index = next.nodes.findIndex((node) => node.id === stationId && node.kind === "station");
  const station = next.nodes[index];
  if (!station || station.kind !== "station") return next;

  if (enabled) {
    const existing = next.resources?.find((resource) => resource.id === station.resourceId && resource.kind === "equipment");
    if (existing) {
      if (!existing.power && station.power) existing.power = station.power;
      const { power: _power, ...withoutPower } = station;
      next.nodes[index] = withoutPower;
      return next;
    }
    next.resources ??= [];
    const resourceId = uniqueResourceId(next, `${station.id.slice(0, 96)}-equipment`);
    next.resources.push({
      id: resourceId,
      name: `${station.name}设备`,
      kind: "equipment",
      capacity: station.capacity ?? 1,
      ...(station.power ? { power: station.power } : next.energyEconomics ? { power: { activePowerKw: 12, idlePowerKw: 1 } } : {}),
    });
    const { power: _power, ...withoutPower } = station;
    next.nodes[index] = { ...withoutPower, resourceId };
  } else {
    const equipment = next.resources?.find((resource) => resource.id === station.resourceId && resource.kind === "equipment");
    const { resourceId: _resourceId, ...withoutResource } = station;
    next.nodes[index] = equipment?.power && !station.power ? { ...withoutResource, power: equipment.power } : withoutResource;
  }
  ensurePlantLiteResources(next);
  return next;
}

export function setPlantLiteStationWorker(model: PlantLiteModel, stationId: string, enabled: boolean): PlantLiteModel {
  const next = structuredClone(model);
  const index = next.nodes.findIndex((node) => node.id === stationId && node.kind === "station");
  const station = next.nodes[index];
  if (!station || station.kind !== "station") return next;
  const existing = next.resources?.find((resource) => resource.id === station.workerResourceId && resource.kind === "worker");
  if (enabled && existing) return next;
  if (enabled) return createPlantLiteStationWorkerPool(next, stationId);
  const { workerResourceId: _workerResourceId, ...withoutWorker } = station;
  next.nodes[index] = withoutWorker;
  ensurePlantLiteResources(next);
  return next;
}

/** 为工位创建独立人员池；若原池仍被其他工位使用则保留为共享池。 */
export function createPlantLiteStationWorkerPool(model: PlantLiteModel, stationId: string): PlantLiteModel {
  const next = structuredClone(model);
  const index = next.nodes.findIndex((node) => node.id === stationId && node.kind === "station");
  const station = next.nodes[index];
  if (!station || station.kind !== "station") return next;
  next.resources ??= [];
  const currentPool = next.resources.find((resource) => resource.id === station.workerResourceId && resource.kind === "worker");
  const workerResourceId = uniqueResourceId(next, `${station.id.slice(0, 96)}-workers`);
  next.resources.push({
    id: workerResourceId,
    name: `${station.name}班组`,
    kind: "worker",
    capacity: currentPool?.capacity ?? station.capacity ?? 1,
    ...(currentPool?.availability ? { availability: structuredClone(currentPool.availability) } : {}),
  });
  next.nodes[index] = { ...station, workerResourceId };
  ensurePlantLiteResources(next);
  return next;
}

export function bindPlantLiteStationWorkerPool(model: PlantLiteModel, stationId: string, workerResourceId: string): PlantLiteModel {
  const next = structuredClone(model);
  const station = next.nodes.find((node) => node.id === stationId && node.kind === "station");
  const worker = next.resources?.find((resource) => resource.id === workerResourceId && resource.kind === "worker");
  if (!station || station.kind !== "station" || !worker) return next;
  station.workerResourceId = worker.id;
  ensurePlantLiteResources(next);
  return next;
}

export function renamePlantLiteModel(model: PlantLiteModel, name: string): PlantLiteModel {
  return { ...structuredClone(model), name };
}

export function setPlantLiteResourceCapacity(model: PlantLiteModel, resourceId: string, capacity: number): PlantLiteModel {
  const next = structuredClone(model);
  const resource = next.resources?.find((candidate) => candidate.id === resourceId);
  if (resource) resource.capacity = capacity;
  return next;
}

export function replacePlantLiteResource(model: PlantLiteModel, resourceId: string, replacement: NonNullable<PlantLiteModel["resources"]>[number]): PlantLiteModel {
  const next = structuredClone(model);
  const index = next.resources?.findIndex((candidate) => candidate.id === resourceId) ?? -1;
  if (next.resources && index >= 0) next.resources[index] = structuredClone(replacement);
  return next;
}

export function distributionTypicalValue(distribution: Distribution): number {
  if (distribution.kind === "deterministic") return distribution.value;
  if (distribution.kind === "uniform") return (distribution.minimum + distribution.maximum) / 2;
  return distribution.mean;
}

export function setDistributionTypicalValue(distribution: Distribution, value: number): Distribution {
  const safe = Math.max(0.01, value);
  if (distribution.kind === "deterministic") return { ...distribution, value: safe };
  if (distribution.kind === "uniform") {
    const halfRange = Math.max(0, (distribution.maximum - distribution.minimum) / 2);
    return { ...distribution, minimum: Math.max(0.01, safe - halfRange), maximum: safe + halfRange };
  }
  return { ...distribution, mean: safe };
}

export function changeDistributionKind(distribution: Distribution, kind: Distribution["kind"]): Distribution {
  const value = distributionTypicalValue(distribution);
  if (kind === "deterministic") return { kind, value };
  if (kind === "uniform") return { kind, minimum: Math.max(0.01, value * 0.8), maximum: value * 1.2 };
  if (kind === "normal") return { kind, mean: value, standardDeviation: Math.max(0.01, value * 0.1), minimum: 0.01 };
  return { kind, mean: value };
}

export function plantLiteModelIssues(request: PlantLiteStudyRequest): string[] {
  const issues: string[] = [];
  issues.push(...plantLiteAcceptanceTargetIssues(request));
  const name = request.name.trim();
  if (!name) issues.push("请填写方案名称");
  else if (name.length > 80) issues.push("方案名称不能超过 80 个字符");
  const seed = request.seed ?? "plant-lite-baseline";
  if ((typeof seed !== "string" && typeof seed !== "number") || (typeof seed === "string" && (!seed.trim() || seed.length > 120)) || (typeof seed === "number" && !Number.isSafeInteger(seed))) {
    issues.push("随机种子必须是非空短文本或安全整数");
  }
  const replications = request.replications ?? 12;
  if (!Number.isSafeInteger(replications) || replications < 1 || replications > 30) issues.push("统计运行次数必须是 1 到 30 的整数");
  const duration = request.limits?.durationMinutes ?? 480;
  if (!Number.isFinite(duration) || duration <= 0 || duration > 52_560) issues.push("总运行时长必须大于 0 且不超过 52560 分钟");
  const warmup = request.limits?.warmupMinutes ?? 0;
  if (!Number.isFinite(warmup) || warmup < 0 || warmup >= duration) issues.push("预热期必须大于等于 0 且小于总运行时长");
  const maxResources = request.limits?.maxResources ?? 100;
  if (!Number.isSafeInteger(maxResources) || maxResources < 1 || maxResources > 1_000) issues.push("最大资源数必须是 1 到 1000 的整数");
  if (!request.model) issues.push("模型尚未准备好");
  else {
    const validation = validatePlantLiteModel(request.model);
    if (!validation.valid) issues.push(...validation.issues.map((issue) => `${friendlyPath(issue.path)}：${friendlyMessage(issue.message)}`));
    else {
      const resourceUnits = validation.model.resources?.reduce((sum, resource) => sum + resource.capacity, 0) ?? 0;
      if (Number.isSafeInteger(maxResources) && resourceUnits > maxResources) issues.push(`设备、搬运与人工资源共 ${resourceUnits} 个，超过运行上限 ${maxResources}`);
    }
  }
  return issues;
}

function createNode(model: PlantLiteModel, kind: PlantLiteCanonicalNodeKind): PlantLiteNode {
  const id = uniqueId(model, kind === "queue-buffer" ? "buffer" : kind);
  if (kind === "source") return { id, name: "新来料源", kind, interarrivalTime: { kind: "deterministic", value: 1 } };
  if (kind === "station") return {
    id,
    name: "新工位",
    kind,
    processingTime: { kind: "deterministic", value: 1 },
    capacity: 1,
    ...(model.energyEconomics ? { power: { activePowerKw: 10, idlePowerKw: 1 } } : {}),
  };
  if (kind === "queue-buffer") return { id, name: "新缓冲区", kind, capacity: 10 };
  if (kind === "transport") {
    const resourceId = model.resources?.find((resource) => resource.kind === "agv" || resource.kind === "transport")?.id ?? "transport-fleet";
    return { id, name: "新搬运", kind, travelTime: { kind: "deterministic", value: 1 }, resourceId };
  }
  return { id, name: "新产出", kind: "sink" };
}

function sequentialEdges(nodes: PlantLiteNode[]): PlantLiteModel["edges"] {
  return nodes.slice(0, -1).flatMap((node, index) => {
    const target = nodes[index + 1];
    return target ? [{ id: `${node.id}--${target.id}`, from: node.id, to: target.id }] : [];
  });
}

function ensurePlantLiteResources(model: PlantLiteModel): void {
  const transportNodes = model.nodes.filter((node): node is Extract<PlantLiteNode, { kind: "transport" }> => node.kind === "transport");
  if (transportNodes.length) {
    model.resources ??= [];
    let transportResources = model.resources.filter((resource) => resource.kind === "agv" || resource.kind === "transport");
    if (!transportResources.length) {
      const id = uniqueResourceId(model, "transport-fleet");
      model.resources.push({
        id,
        name: "搬运资源",
        kind: "transport",
        capacity: 1,
        ...(model.energyEconomics ? { power: { activePowerKw: 1.2, idlePowerKw: 0.08 } } : {}),
      });
      transportResources = model.resources.filter((resource) => resource.kind === "agv" || resource.kind === "transport");
    }
    for (const node of transportNodes) {
      const bound = model.resources.find((resource) => resource.id === node.resourceId);
      if (!bound || (bound.kind !== "agv" && bound.kind !== "transport")) node.resourceId = transportResources[0]?.id ?? "transport-fleet";
    }
  }
  const referenced = new Set(model.nodes.flatMap((node) => {
    const ids = "resourceId" in node && node.resourceId ? [node.resourceId] : [];
    if (node.kind === "station" && node.workerResourceId) ids.push(node.workerResourceId);
    return ids;
  }));
  if (model.resources) model.resources = model.resources.filter((resource) => referenced.has(resource.id));
  if (!model.resources?.length) delete model.resources;
}

function uniqueResourceId(model: PlantLiteModel, preferred: string): string {
  const ids = new Set((model.resources ?? []).map((resource) => resource.id));
  if (!ids.has(preferred)) return preferred;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${preferred.slice(0, 115)}-${suffix}`;
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error("共享资源过多，无法生成唯一 ID");
}

function uniqueId(model: PlantLiteModel, prefix: string): string {
  const ids = new Set(model.nodes.map((node) => node.id));
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const candidate = `${prefix}-${suffix}`;
    if (!ids.has(candidate)) return candidate;
  }
  throw new Error("流程节点过多，无法生成唯一 ID");
}

function friendlyPath(path: string): string {
  return path.replace("$.nodes", "流程节点").replace("$.edges", "流程连接").replace("$.resources", "共享资源").replace("$.productTypes", "产品组合").replace("$.energyEconomics", "能耗经济口径");
}

function friendlyMessage(message: string): string {
  return message
    .replaceAll("activePowerKw", "运行功率")
    .replaceAll("idlePowerKw", "待机功率")
    .replaceAll("changeovers", "换型规则")
    .replaceAll("queue-buffer", "缓冲区")
    .replaceAll("transport", "搬运")
    .replaceAll("equipment", "设备")
    .replaceAll("worker", "人工")
    .replaceAll("station", "工位")
    .replaceAll("buffer", "缓冲区")
    .replaceAll("source", "来料源")
    .replaceAll("sink", "产出端")
    .replace(/\s+/g, "");
}
