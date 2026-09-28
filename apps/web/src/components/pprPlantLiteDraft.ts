import type {
  PlantLiteModel,
  PlantLiteResource,
  PlantLiteStudyRequest,
  PprBopVersionDraft,
  PprOperation,
  PprResource,
} from "@bim-studio/contracts";
import { analyzePprPlanDraft, hasPersistablePprContent } from "./pprPlanDraftModel";
import {
  boundedLabel,
  formatNumber,
  planPprFlowTopology,
  type PprPlantLiteAdmissionEntry,
  type PprPlantLiteMappingItem,
  type PprPlantLiteReviewCode,
} from "./pprPlantLiteAdmission";

export type {
  PprPlantLiteAdmissionEntry,
  PprPlantLiteAdmissionSemantics,
  PprPlantLiteAdmissionVerdict,
  PprPlantLiteMappingItem,
  PprPlantLiteReviewCode,
} from "./pprPlantLiteAdmission";

export interface PprPlantLiteMappedOperation {
  operationId: string;
  nodeId: string;
  name: string;
  processingTimeMinutes: number;
  resourceId?: string;
  workerResourceId?: string;
}

export interface PprPlantLiteMappedResource {
  pprResourceId: string;
  plantResourceId: string;
  name: string;
  sourceKind: "equipment" | "robot" | "person";
  capacity: number;
}

export interface PprPlantLiteMappingReport {
  kind: "editable-draft";
  targetTaktMinutes: number;
  arrivalIntervalMinutes: number;
  minimumThroughputPerHour: number;
  mappedOperations: PprPlantLiteMappedOperation[];
  mappedResources: PprPlantLiteMappedResource[];
  reviewItems: PprPlantLiteMappingItem[];
  /** N8 语义准入表逐行结论；与 reviewItems 同源，供机器判定草稿能否进入正式预测。 */
  admission: PprPlantLiteAdmissionEntry[];
  retainedInProcessPlan: string[];
}

export interface PprPlantLiteBlocker {
  code: "invalid-ppr" | "missing-content" | "missing-target-takt" | "unsupported-target-takt";
  message: string;
  sourceId?: string;
}

export type PprPlantLiteDraftPreparation =
  | { status: "blocked"; blockers: PprPlantLiteBlocker[] }
  | {
    status: "ready";
    blockers: [];
    request: PlantLiteStudyRequest;
    report: PprPlantLiteMappingReport;
  };

export type PprPlantLiteReadyDraft = Extract<PprPlantLiteDraftPreparation, { status: "ready" }>;

const MAX_RESOURCE_UNITS = 1_000;
const DEFAULT_RESOURCE_LIMIT = 100;

/**
 * 按 N8 语义准入表把 PPR 中可等价表达的事实转换为 Plant Lite 可编辑草稿：
 * 顺序工序直连、白名单内"设备/机器人 + 人员"联合占用可直接进入正式预测；
 * 分流映射为均分占位路由（mapped-review）；AND 前置汇合、任意多资源原子锁与
 * 最小滞后无等价表达——边仍连接以保持草稿可运行审阅，但模型 ID 以 -review-only
 * 结尾阻断正式预测并给出人工重建指引，绝不静默线性化。
 */
export function preparePlantLiteDraftFromPpr(draft: PprBopVersionDraft): PprPlantLiteDraftPreparation {
  const analysis = analyzePprPlanDraft(draft);
  const blockers: PprPlantLiteBlocker[] = [];
  const targetTaktMinutes = draft.targetTaktMinutes;

  if (!hasPersistablePprContent(draft)) {
    blockers.push({ code: "missing-content", message: "至少完成产品结构和一道工序后，才能生成流程仿真草稿。" });
  }
  if (targetTaktMinutes === undefined) {
    blockers.push({ code: "missing-target-takt", message: "请先明确填写正数目标节拍；系统不会替你猜测产能目标。" });
  } else if (!Number.isFinite(targetTaktMinutes) || targetTaktMinutes <= 0) {
    blockers.push({ code: "missing-target-takt", message: "目标节拍必须是正的有限分钟数。" });
  } else if (60 / targetTaktMinutes > 1_000_000_000) {
    blockers.push({ code: "unsupported-target-takt", message: "目标节拍超出当前流程仿真的吞吐验收范围，请调整后再转换。" });
  }
  analysis.issues
    .filter((issue) => issue.severity === "error" && issue.code !== "invalid-target-takt")
    .forEach((issue) => blockers.push({ code: "invalid-ppr", sourceId: issue.entityId, message: issue.message }));
  if (blockers.length || targetTaktMinutes === undefined) return { status: "blocked", blockers: uniqueBlockers(blockers) };

  const reviewItems: PprPlantLiteMappingItem[] = [];
  const admission: PprPlantLiteAdmissionEntry[] = [];
  const orderedOperations = analysis.topologicalOrder.flatMap((operationId) => {
    const operation = draft.operations.find((candidate) => candidate.id === operationId);
    return operation ? [operation] : [];
  });
  const stationIdByOperation = new Map(orderedOperations.map((operation, index) => [operation.id, `station-${index + 1}`]));
  const topology = planPprFlowTopology(draft, stationIdByOperation);
  reviewItems.push(...topology.flowReviewItems);
  admission.push(...topology.admission);
  inspectConditionalScope(draft, reviewItems);

  const resourceById = new Map(draft.resources.map((resource) => [resource.id, resource]));
  const assignmentsByOperation = new Map<string, PprBopVersionDraft["resourceAssignments"]>();
  draft.resourceAssignments.forEach((assignment) => {
    assignmentsByOperation.set(assignment.operationId, [...(assignmentsByOperation.get(assignment.operationId) ?? []), assignment]);
  });
  const mappedResources = new Map<string, PprPlantLiteMappedResource>();
  const plantResources: PlantLiteResource[] = [];
  const mappedOperations: PprPlantLiteMappedOperation[] = [];
  const budget: PprResourceBudget = { units: 0, equipmentCount: 0, workerCount: 0 };

  const stationNodes = orderedOperations.map((operation) => {
    const nodeId = stationIdByOperation.get(operation.id)!;
    const binding = mappedResourceForOperation(
      operation,
      assignmentsByOperation.get(operation.id) ?? [],
      resourceById,
      mappedResources,
      plantResources,
      reviewItems,
      admission,
      budget,
    );
    const stationCapacity = binding.resourceId
      ? plantResources.find((resource) => resource.id === binding.resourceId)?.capacity ?? 1
      : 1;
    const name = boundedLabel(operation.name, 120);
    if (name !== operation.name.trim()) addReview(reviewItems, "name-shortened", [operation.id], `${operation.name.trim()} 的名称已缩短以满足仿真节点长度限制。`);
    mappedOperations.push({
      operationId: operation.id,
      nodeId,
      name,
      processingTimeMinutes: operation.standardTimeMinutes,
      ...(binding.resourceId ? { resourceId: binding.resourceId } : {}),
      ...(binding.workerResourceId ? { workerResourceId: binding.workerResourceId } : {}),
    });
    return {
      id: nodeId,
      name,
      kind: "station" as const,
      processingTime: { kind: "deterministic" as const, value: operation.standardTimeMinutes },
      capacity: stationCapacity,
      ...(binding.resourceId ? { resourceId: binding.resourceId } : {}),
      ...(binding.workerResourceId ? { workerResourceId: binding.workerResourceId } : {}),
    };
  });

  const modelName = boundedWithSuffix(draft.name.trim(), " · 流程仿真草稿", 120);
  const requestName = boundedWithSuffix(draft.name.trim(), " · 仿真草稿", 80);
  if (`${draft.name.trim()} · 流程仿真草稿` !== modelName || `${draft.name.trim()} · 仿真草稿` !== requestName) {
    addReview(reviewItems, "name-shortened", [draft.planId], "方案名称已缩短以满足流程仿真长度限制。");
  }
  const nodes: PlantLiteModel["nodes"] = [
    { id: "source", name: "按目标节拍来料", kind: "source", interarrivalTime: { kind: "deterministic", value: targetTaktMinutes } },
    ...stationNodes,
    ...topology.splits.map((split) => ({ id: split.id, name: split.name, kind: "split" as const, routes: split.routes })),
    { id: "sink", name: "完成品", kind: "sink" },
  ];
  const requiresManualRemodel = reviewItems.some((item) => item.code !== "name-shortened");
  const model: PlantLiteModel = {
    id: boundedWithSuffix(draft.planId.trim(), requiresManualRemodel ? "-review-only" : "-flow-draft", 120),
    name: modelName,
    nodes,
    edges: topology.edges,
    ...(plantResources.length ? { resources: plantResources } : {}),
  };
  const minimumThroughputPerHour = 60 / targetTaktMinutes;
  const request: PlantLiteStudyRequest = {
    name: requestName,
    templateId: "agv-line-v1",
    model,
    seed: boundedWithSuffix(draft.planId.trim(), ":ppr-flow", 120),
    replications: 12,
    ...(budget.units > DEFAULT_RESOURCE_LIMIT ? { limits: { maxResources: budget.units } } : {}),
    acceptanceTargets: {
      basis: boundedWithSuffix(`工艺计划“${draft.name.trim()}”`, ` · 目标节拍 ${formatNumber(targetTaktMinutes)} 分钟/件`, 160),
      minimumThroughputPerHour,
    },
  };

  return {
    status: "ready",
    blockers: [],
    request,
    report: {
      kind: "editable-draft",
      targetTaktMinutes,
      arrivalIntervalMinutes: targetTaktMinutes,
      minimumThroughputPerHour,
      mappedOperations,
      mappedResources: [...mappedResources.values()],
      reviewItems,
      admission,
      retainedInProcessPlan: ["产品与 BOM", "电子作业指导书", "质量与安全内容"],
    },
  };
}

interface PprStationResourceBinding {
  resourceId?: string;
  workerResourceId?: string;
}

/** 资源映射的共享预算：units 供 maxResources 上限，双计数器保证 equipment-N 与 worker-N 各自连续。 */
interface PprResourceBudget {
  units: number;
  equipmentCount: number;
  workerCount: number;
}

function mappedResourceForOperation(
  operation: PprOperation,
  assignments: PprBopVersionDraft["resourceAssignments"],
  resourceById: Map<string, PprResource>,
  mappedResources: Map<string, PprPlantLiteMappedResource>,
  plantResources: PlantLiteResource[],
  reviewItems: PprPlantLiteMappingItem[],
  admission: PprPlantLiteAdmissionEntry[],
  budget: PprResourceBudget,
): PprStationResourceBinding {
  if (!assignments.length) {
    addReview(reviewItems, "resource-unassigned", [operation.id], `${operation.name} 未分配设备或机器人；草稿工位暂不绑定共享资源。`);
    return {};
  }
  const joint = jointOccupancyPair(assignments, resourceById);
  if (joint) return mapJointOccupancy(operation, joint, mappedResources, plantResources, reviewItems, admission, budget);
  if (assignments.length > 1) {
    const resourceLabels = assignments.map((item) => {
      const resource = resourceById.get(item.resourceId);
      return resource ? `${resource.name}（${pprResourceKindLabel(resource.kind)}）` : item.resourceId;
    });
    const sourceIds = [operation.id, ...assignments.map((item) => item.resourceId)];
    addReview(reviewItems, "multiple-resources", sourceIds, `${operation.name} 同时占用 ${resourceLabels.join("、")}；流程仿真仅支持"单台设备/机器人 + 单一人工池"的联合占用，任意多资源原子获取无等价表达。正式预测已被阻断；请人工分解工序并另存独立模型。`);
    admission.push({
      semantics: "multi-resource-atomic-lock",
      verdict: "blocked",
      sourceIds,
      reason: `${assignments.length} 个资源要求原子获取；联合占用白名单仅覆盖一台设备/机器人加一名人员。`,
    });
    return {};
  }

  const assignment = assignments[0]!;
  const resource = resourceById.get(assignment.resourceId);
  if (!resource) return {};
  const resourceId = mappedSharedResource(operation, assignment, resource, "equipment", mappedResources, plantResources, reviewItems, budget);
  return resourceId ? { resourceId } : {};
}

/** 白名单判定：恰好一台设备/机器人加一名人员且各占一个单位，才是流程仿真可等价表达的联合占用。 */
function jointOccupancyPair(
  assignments: PprBopVersionDraft["resourceAssignments"],
  resourceById: Map<string, PprResource>,
): { equipment: { assignment: PprBopVersionDraft["resourceAssignments"][number]; resource: PprResource }; worker: { assignment: PprBopVersionDraft["resourceAssignments"][number]; resource: PprResource } } | undefined {
  if (assignments.length !== 2) return undefined;
  const resolved = assignments.map((assignment) => ({ assignment, resource: resourceById.get(assignment.resourceId) }));
  const equipment = resolved.find((item) => item.resource && (item.resource.kind === "equipment" || item.resource.kind === "robot"));
  const worker = resolved.find((item) => item.resource?.kind === "person");
  if (!equipment?.resource || !worker?.resource || equipment === worker) return undefined;
  if ((equipment.assignment.requiredCapacity ?? 1) !== 1 || (worker.assignment.requiredCapacity ?? 1) !== 1) return undefined;
  return {
    equipment: { assignment: equipment.assignment, resource: equipment.resource },
    worker: { assignment: worker.assignment, resource: worker.resource },
  };
}

function mapJointOccupancy(
  operation: PprOperation,
  joint: NonNullable<ReturnType<typeof jointOccupancyPair>>,
  mappedResources: Map<string, PprPlantLiteMappedResource>,
  plantResources: PlantLiteResource[],
  reviewItems: PprPlantLiteMappingItem[],
  admission: PprPlantLiteAdmissionEntry[],
  budget: PprResourceBudget,
): PprStationResourceBinding {
  const resourceId = mappedSharedResource(operation, joint.equipment.assignment, joint.equipment.resource, "equipment", mappedResources, plantResources, reviewItems, budget);
  const workerResourceId = mappedSharedResource(operation, joint.worker.assignment, joint.worker.resource, "worker", mappedResources, plantResources, reviewItems, budget);
  if (!resourceId || !workerResourceId) {
    // 联合占用任一侧未映射就整位不绑定，避免只绑一侧冒充联合语义等价。
    return {};
  }
  admission.push({
    semantics: "joint-equipment-worker",
    verdict: "direct",
    sourceIds: [operation.id, joint.equipment.resource.id, joint.worker.resource.id],
    reason: "设备/机器人与人员组合在联合占用白名单内；工位需设备与人工同时可用才派工，语义等价。",
  });
  return { resourceId, workerResourceId };
}

function mappedSharedResource(
  operation: PprOperation | undefined,
  assignment: PprBopVersionDraft["resourceAssignments"][number],
  resource: PprResource,
  role: "equipment" | "worker",
  mappedResources: Map<string, PprPlantLiteMappedResource>,
  plantResources: PlantLiteResource[],
  reviewItems: PprPlantLiteMappingItem[],
  budget: PprResourceBudget,
): string | undefined {
  if (role === "equipment" && resource.kind !== "equipment" && resource.kind !== "robot") {
    addReview(reviewItems, "unsupported-resource", [operation?.id, resource.id].filter((id): id is string => Boolean(id)), `${resource.name} 是${pprResourceKindLabel(resource.kind)}，未冒充设备资源；请在草稿中复核。`);
    return undefined;
  }
  if (resource.condition || resource.variantIds?.length) {
    addReview(reviewItems, "conditional-resource", [operation?.id, resource.id].filter((id): id is string => Boolean(id)), `${resource.name} 带有变体或适用条件，未作为无条件绑定；请先确认目标工况。`);
    return undefined;
  }
  if ((assignment.requiredCapacity ?? 1) !== 1) {
    addReview(reviewItems, "resource-capacity", [operation?.id, resource.id].filter((id): id is string => Boolean(id)), `${operation?.name ?? resource.name} 需要 ${assignment.requiredCapacity} 个资源单位，当前工位占用语义不能精确表达。`);
    return undefined;
  }
  const capacity = resource.capacity ?? 1;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    addReview(reviewItems, "resource-capacity", [resource.id], `${resource.name} 的并行能力不是正整数，未映射为仿真资源。`);
    return undefined;
  }
  const existing = mappedResources.get(resource.id);
  if (existing) return existing.plantResourceId;
  if (budget.units + capacity > MAX_RESOURCE_UNITS) {
    addReview(reviewItems, "resource-limit", [resource.id], `${resource.name} 会使资源单位总数超过 ${MAX_RESOURCE_UNITS}，未绑定到草稿工位。`);
    return undefined;
  }

  const sourceKind = role === "worker" ? "person" as const : resource.kind === "robot" ? "robot" as const : "equipment" as const;
  const plantResourceId = role === "worker" ? `worker-${++budget.workerCount}` : `equipment-${++budget.equipmentCount}`;
  const name = boundedLabel(resource.name, 120);
  if (name !== resource.name.trim()) addReview(reviewItems, "name-shortened", [resource.id], `${resource.name.trim()} 的名称已缩短以满足仿真资源长度限制。`);
  mappedResources.set(resource.id, { pprResourceId: resource.id, plantResourceId, name, sourceKind, capacity });
  plantResources.push({ id: plantResourceId, name, kind: role === "worker" ? "worker" : "equipment", capacity });
  budget.units += capacity;
  return plantResourceId;
}

function inspectConditionalScope(draft: PprBopVersionDraft, reviewItems: PprPlantLiteMappingItem[]): void {
  const conditionalIds = [
    ...(draft.variantIds?.length || draft.condition ? [draft.planId] : []),
    ...draft.operations.filter((item) => item.variantIds?.length || item.condition).map((item) => item.id),
    ...draft.resources.filter((item) => item.variantIds?.length || item.condition).map((item) => item.id),
    ...draft.precedenceRelations.filter((item) => item.condition).map((item) => item.id),
  ];
  if (conditionalIds.length) {
    addReview(reviewItems, "conditional-scope", conditionalIds, "PPR 的变体与自由条件不会在 DES 中自动执行；条件工序按完整清单进入草稿，条件资源不会自动绑定，需按目标工况复核。");
  }
}

function addReview(items: PprPlantLiteMappingItem[], code: PprPlantLiteReviewCode, sourceIds: string[], message: string): void {
  const key = `${code}:${sourceIds.join("|")}`;
  if (!items.some((item) => `${item.code}:${item.sourceIds.join("|")}` === key)) items.push({ code, sourceIds, message: message.trim() });
}

function uniqueBlockers(blockers: PprPlantLiteBlocker[]): PprPlantLiteBlocker[] {
  const seen = new Set<string>();
  return blockers.filter((blocker) => {
    const key = `${blocker.code}:${blocker.sourceId ?? ""}:${blocker.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pprResourceKindLabel(kind: PprResource["kind"]): string {
  return ({ station: "工位", equipment: "设备", robot: "机器人", tool: "工具", person: "人员" })[kind];
}

function boundedWithSuffix(value: string, suffix: string, maximum: number): string {
  const trimmed = value.trim();
  const full = `${trimmed}${suffix}`;
  if (full.length <= maximum) return full;
  return `${trimmed.slice(0, Math.max(1, maximum - suffix.length))}${suffix}`;
}
