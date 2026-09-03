import type {
  PlantLiteModel,
  PlantLiteResource,
  PlantLiteStudyRequest,
  PprBopVersionDraft,
  PprOperation,
  PprResource,
} from "@bim-studio/contracts";
import { analyzePprPlanDraft, hasPersistablePprContent } from "./pprPlanDraftModel";

export type PprPlantLiteReviewCode =
  | "conditional-resource"
  | "conditional-scope"
  | "disconnected-flow"
  | "minimum-lag"
  | "multiple-predecessors"
  | "multiple-resources"
  | "multiple-successors"
  | "name-shortened"
  | "resource-capacity"
  | "resource-limit"
  | "resource-unassigned"
  | "unsupported-resource";

export interface PprPlantLiteMappingItem {
  code: PprPlantLiteReviewCode;
  message: string;
  sourceIds: string[];
}

export interface PprPlantLiteMappedOperation {
  operationId: string;
  nodeId: string;
  name: string;
  processingTimeMinutes: number;
  resourceId?: string;
}

export interface PprPlantLiteMappedResource {
  pprResourceId: string;
  plantResourceId: string;
  name: string;
  sourceKind: "equipment" | "robot";
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
 * Convert only the PPR facts that Plant Lite can express without invention.
 * The result is an editable linear DES draft, never an automatically executed or
 * semantically equivalent copy of the source process plan.
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
  const orderedOperations = analysis.topologicalOrder.flatMap((operationId) => {
    const operation = draft.operations.find((candidate) => candidate.id === operationId);
    return operation ? [operation] : [];
  });
  inspectFlowSemantics(draft, orderedOperations, reviewItems);
  inspectConditionalScope(draft, reviewItems);

  const resourceById = new Map(draft.resources.map((resource) => [resource.id, resource]));
  const assignmentsByOperation = new Map<string, PprBopVersionDraft["resourceAssignments"]>();
  draft.resourceAssignments.forEach((assignment) => {
    assignmentsByOperation.set(assignment.operationId, [...(assignmentsByOperation.get(assignment.operationId) ?? []), assignment]);
  });
  const mappedResources = new Map<string, PprPlantLiteMappedResource>();
  const plantResources: PlantLiteResource[] = [];
  const mappedOperations: PprPlantLiteMappedOperation[] = [];
  let resourceUnits = 0;

  const stationNodes = orderedOperations.map((operation, index) => {
    const nodeId = `station-${index + 1}`;
    const resourceCountBefore = plantResources.length;
    const resourceId = mappedResourceForOperation(
      operation,
      assignmentsByOperation.get(operation.id) ?? [],
      resourceById,
      mappedResources,
      plantResources,
      reviewItems,
      resourceUnits,
    );
    if (plantResources.length > resourceCountBefore) resourceUnits += plantResources.at(-1)!.capacity;
    const stationCapacity = resourceId
      ? plantResources.find((resource) => resource.id === resourceId)?.capacity ?? 1
      : 1;
    const name = boundedLabel(operation.name, 120);
    if (name !== operation.name.trim()) addReview(reviewItems, "name-shortened", [operation.id], `${operation.name.trim()} 的名称已缩短以满足仿真节点长度限制。`);
    mappedOperations.push({
      operationId: operation.id,
      nodeId,
      name,
      processingTimeMinutes: operation.standardTimeMinutes,
      ...(resourceId ? { resourceId } : {}),
    });
    return {
      id: nodeId,
      name,
      kind: "station" as const,
      processingTime: { kind: "deterministic" as const, value: operation.standardTimeMinutes },
      capacity: stationCapacity,
      ...(resourceId ? { resourceId } : {}),
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
    { id: "sink", name: "完成品", kind: "sink" },
  ];
  const model: PlantLiteModel = {
    id: boundedWithSuffix(draft.planId.trim(), "-flow-draft", 120),
    name: modelName,
    nodes,
    edges: nodes.slice(0, -1).map((node, index) => ({ id: `edge-${index + 1}`, from: node.id, to: nodes[index + 1]!.id })),
    ...(plantResources.length ? { resources: plantResources } : {}),
  };
  const minimumThroughputPerHour = 60 / targetTaktMinutes;
  const request: PlantLiteStudyRequest = {
    name: requestName,
    templateId: "agv-line-v1",
    model,
    seed: boundedWithSuffix(draft.planId.trim(), ":ppr-flow", 120),
    replications: 12,
    ...(resourceUnits > DEFAULT_RESOURCE_LIMIT ? { limits: { maxResources: resourceUnits } } : {}),
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
      retainedInProcessPlan: ["产品与 BOM", "电子作业指导书", "质量与安全内容"],
    },
  };
}

function mappedResourceForOperation(
  operation: PprOperation,
  assignments: PprBopVersionDraft["resourceAssignments"],
  resourceById: Map<string, PprResource>,
  mappedResources: Map<string, PprPlantLiteMappedResource>,
  plantResources: PlantLiteResource[],
  reviewItems: PprPlantLiteMappingItem[],
  resourceUnits: number,
): string | undefined {
  if (!assignments.length) {
    addReview(reviewItems, "resource-unassigned", [operation.id], `${operation.name} 未分配设备或机器人；草稿工位暂不绑定共享资源。`);
    return undefined;
  }
  if (assignments.length > 1) {
    const resourceLabels = assignments.map((item) => {
      const resource = resourceById.get(item.resourceId);
      return resource ? `${resource.name}（${pprResourceKindLabel(resource.kind)}）` : item.resourceId;
    });
    addReview(reviewItems, "multiple-resources", [operation.id, ...assignments.map((item) => item.resourceId)], `${operation.name} 同时占用 ${resourceLabels.join("、")}，当前 DES 工位不能保证等价获取，需人工配置。`);
    return undefined;
  }

  const assignment = assignments[0]!;
  const resource = resourceById.get(assignment.resourceId);
  if (!resource) return undefined;
  if (resource.kind !== "equipment" && resource.kind !== "robot") {
    addReview(reviewItems, "unsupported-resource", [operation.id, resource.id], `${resource.name} 是${pprResourceKindLabel(resource.kind)}，未冒充设备资源；请在草稿中复核。`);
    return undefined;
  }
  if (resource.condition || resource.variantIds?.length) {
    addReview(reviewItems, "conditional-resource", [operation.id, resource.id], `${resource.name} 带有变体或适用条件，未作为无条件设备绑定；请先确认目标工况。`);
    return undefined;
  }
  if ((assignment.requiredCapacity ?? 1) !== 1) {
    addReview(reviewItems, "resource-capacity", [operation.id, resource.id], `${operation.name} 需要 ${assignment.requiredCapacity} 个资源单位，当前工位占用语义不能精确表达。`);
    return undefined;
  }
  const capacity = resource.capacity ?? 1;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    addReview(reviewItems, "resource-capacity", [resource.id], `${resource.name} 的并行能力不是正整数，未映射为设备资源。`);
    return undefined;
  }
  const existing = mappedResources.get(resource.id);
  if (existing) return existing.plantResourceId;
  if (resourceUnits + capacity > MAX_RESOURCE_UNITS) {
    addReview(reviewItems, "resource-limit", [resource.id], `${resource.name} 会使设备总数超过 ${MAX_RESOURCE_UNITS}，未绑定到草稿工位。`);
    return undefined;
  }

  const plantResourceId = `equipment-${mappedResources.size + 1}`;
  const name = boundedLabel(resource.name, 120);
  if (name !== resource.name.trim()) addReview(reviewItems, "name-shortened", [resource.id], `${resource.name.trim()} 的名称已缩短以满足仿真资源长度限制。`);
  const mapped: PprPlantLiteMappedResource = {
    pprResourceId: resource.id,
    plantResourceId,
    name,
    sourceKind: resource.kind,
    capacity,
  };
  mappedResources.set(resource.id, mapped);
  plantResources.push({ id: plantResourceId, name, kind: "equipment", capacity });
  return plantResourceId;
}

function inspectFlowSemantics(
  draft: PprBopVersionDraft,
  operations: PprOperation[],
  reviewItems: PprPlantLiteMappingItem[],
): void {
  const operationIds = new Set(operations.map((operation) => operation.id));
  const relations = draft.precedenceRelations.filter((relation) => operationIds.has(relation.predecessorOperationId) && operationIds.has(relation.successorOperationId));
  const predecessors = new Map<string, string[]>();
  const successors = new Map<string, string[]>();
  relations.forEach((relation) => {
    predecessors.set(relation.successorOperationId, [...(predecessors.get(relation.successorOperationId) ?? []), relation.predecessorOperationId]);
    successors.set(relation.predecessorOperationId, [...(successors.get(relation.predecessorOperationId) ?? []), relation.successorOperationId]);
    if ((relation.minimumLagMinutes ?? 0) > 0) addReview(reviewItems, "minimum-lag", [relation.id], `前置关系的 ${formatNumber(relation.minimumLagMinutes!)} 分钟最小等待未写入加工时间，需在仿真草稿中补充。`);
  });
  operations.forEach((operation) => {
    const prior = predecessors.get(operation.id) ?? [];
    const next = successors.get(operation.id) ?? [];
    if (prior.length > 1) addReview(reviewItems, "multiple-predecessors", [operation.id, ...prior], `${operation.name} 有 ${prior.length} 个并行前置，已按拓扑顺序线性展开，需复核合流逻辑。`);
    if (next.length > 1) addReview(reviewItems, "multiple-successors", [operation.id, ...next], `${operation.name} 有 ${next.length} 个并行后续，已按拓扑顺序线性展开，需复核分流逻辑。`);
  });
  if (operations.length > 1) {
    const roots = operations.filter((operation) => !(predecessors.get(operation.id)?.length));
    const sinks = operations.filter((operation) => !(successors.get(operation.id)?.length));
    if (relations.length !== operations.length - 1 || roots.length !== 1 || sinks.length !== 1) {
      addReview(reviewItems, "disconnected-flow", operations.map((operation) => operation.id), "PPR 不是一条无分支串行链；草稿仅按确定性拓扑顺序连接，不代表原前置网络等价。");
    }
  }
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

function boundedLabel(value: string, maximum: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maximum ? trimmed : trimmed.slice(0, maximum);
}

function boundedWithSuffix(value: string, suffix: string, maximum: number): string {
  const trimmed = value.trim();
  const full = `${trimmed}${suffix}`;
  if (full.length <= maximum) return full;
  return `${trimmed.slice(0, Math.max(1, maximum - suffix.length))}${suffix}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
