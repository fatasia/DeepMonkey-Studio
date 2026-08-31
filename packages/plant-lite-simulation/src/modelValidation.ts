import type {
  PlantLiteEdge,
  PlantLiteModel,
  PlantLiteModelIssue,
  PlantLiteModelValidation,
  PlantLiteNode,
} from "./modelTypes.js";

export function validatePlantLiteModel(input: unknown): PlantLiteModelValidation {
  const issues: PlantLiteModelIssue[] = [];
  if (!isRecord(input)) return invalid("$", "模型必须是对象");
  validateText(input.id, "$.id", issues);
  validateText(input.name, "$.name", issues);
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) {
    issues.push({ path: "$.nodes", message: "必须包含至少一个节点" });
  }
  if (!Array.isArray(input.edges)) issues.push({ path: "$.edges", message: "必须是数组" });
  if (issues.length) return { valid: false, issues };

  const nodeIds = new Set<string>();
  const resourceIds = new Set<string>();
  const nodes = input.nodes as unknown[];
  const resources = Array.isArray(input.resources) ? input.resources : [];
  resources.forEach((value, index) => validateResource(value, index, resourceIds, issues));
  nodes.forEach((value, index) => validateNode(value, index, nodeIds, resourceIds, issues));

  const edgeIds = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const edges = input.edges as unknown[];
  edges.forEach((value, index) => validateEdge(value, index, edgeIds, nodeIds, adjacency, issues));
  if (!issues.length) validateFlowEnds(nodes as PlantLiteNode[], edges as PlantLiteEdge[], issues);
  if (!issues.length && hasCycle([...nodeIds], adjacency)) {
    issues.push({ path: "$.edges", message: "流图必须无环" });
  }
  return issues.length
    ? { valid: false, issues }
    : { valid: true, model: structuredClone(input) as unknown as PlantLiteModel, issues: [] };
}

export function assertPlantLiteModel(input: unknown): PlantLiteModel {
  const result = validatePlantLiteModel(input);
  if (!result.valid) {
    throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  }
  return result.model;
}

function validateNode(value: unknown, index: number, ids: Set<string>, resources: Set<string>, issues: PlantLiteModelIssue[]): void {
  const path = `$.nodes[${index}]`;
  if (!isRecord(value)) return void issues.push({ path, message: "必须是对象" });
  validateUniqueText(value.id, `${path}.id`, ids, issues);
  validateText(value.name, `${path}.name`, issues);
  if (value.kind === "source") return validateSource(value, path, issues);
  if (value.kind === "buffer" || value.kind === "queue-buffer") return validatePositiveInteger(value.capacity, `${path}.capacity`, issues);
  if (value.kind === "sink") return;
  if (value.kind === "station") return validateStation(value, path, resources, issues);
  if (value.kind === "transport") return validateTransport(value, path, resources, issues);
  issues.push({ path: `${path}.kind`, message: "必须是 source、station、transport、queue-buffer 或 sink" });
}

function validateSource(value: Record<string, unknown>, path: string, issues: PlantLiteModelIssue[]): void {
  validateDistribution(value.interarrivalTime, `${path}.interarrivalTime`, issues);
  validateOptionalNonNegative(value.initialDelay, `${path}.initialDelay`, issues);
  validateOptionalPositiveInteger(value.maxItems, `${path}.maxItems`, issues);
}

function validateStation(value: Record<string, unknown>, path: string, resources: Set<string>, issues: PlantLiteModelIssue[]): void {
  validateDistribution(value.processingTime, `${path}.processingTime`, issues);
  validateOptionalPositiveInteger(value.capacity, `${path}.capacity`, issues);
  validateOptionalPositiveInteger(value.queueCapacity, `${path}.queueCapacity`, issues);
  validateOptionalResource(value.resourceId, `${path}.resourceId`, resources, issues);
  validateAvailability(value.availability, `${path}.availability`, issues);
}

function validateTransport(value: Record<string, unknown>, path: string, resources: Set<string>, issues: PlantLiteModelIssue[]): void {
  validateDistribution(value.travelTime, `${path}.travelTime`, issues);
  validateOptionalPositiveInteger(value.queueCapacity, `${path}.queueCapacity`, issues);
  validateRequiredResource(value.resourceId, `${path}.resourceId`, resources, issues);
}

function validateResource(value: unknown, index: number, ids: Set<string>, issues: PlantLiteModelIssue[]): void {
  const path = `$.resources[${index}]`;
  if (!isRecord(value)) return void issues.push({ path, message: "必须是对象" });
  validateUniqueText(value.id, `${path}.id`, ids, issues);
  validateText(value.name, `${path}.name`, issues);
  if (value.kind !== "agv" && value.kind !== "transport") {
    issues.push({ path: `${path}.kind`, message: "必须是 agv 或 transport" });
  }
  validatePositiveInteger(value.capacity, `${path}.capacity`, issues);
  validateAvailability(value.availability, `${path}.availability`, issues);
  if (value.failure === undefined) return;
  if (!isRecord(value.failure)) return void issues.push({ path: `${path}.failure`, message: "必须是对象" });
  validateDistribution(value.failure.timeToFailure, `${path}.failure.timeToFailure`, issues);
  validateDistribution(value.failure.repairTime, `${path}.failure.repairTime`, issues);
}

function validateEdge(value: unknown, index: number, ids: Set<string>, nodes: Set<string>, adjacency: Map<string, string[]>, issues: PlantLiteModelIssue[]): void {
  const path = `$.edges[${index}]`;
  if (!isRecord(value)) return void issues.push({ path, message: "必须是对象" });
  validateUniqueText(value.id, `${path}.id`, ids, issues);
  validateText(value.from, `${path}.from`, issues);
  validateText(value.to, `${path}.to`, issues);
  if (typeof value.from === "string" && !nodes.has(value.from)) issues.push({ path: `${path}.from`, message: "未知起点" });
  if (typeof value.to === "string" && !nodes.has(value.to)) issues.push({ path: `${path}.to`, message: "未知终点" });
  if (value.priority !== undefined && !Number.isSafeInteger(value.priority)) {
    issues.push({ path: `${path}.priority`, message: "必须是整数" });
  }
  if (typeof value.from === "string" && typeof value.to === "string" && nodes.has(value.from) && nodes.has(value.to)) {
    const targets = adjacency.get(value.from) ?? [];
    targets.push(value.to);
    adjacency.set(value.from, targets);
  }
}

function validateFlowEnds(nodes: PlantLiteNode[], edges: PlantLiteEdge[], issues: PlantLiteModelIssue[]): void {
  const incoming = new Set(edges.map((edge) => edge.to));
  const outgoing = new Set(edges.map((edge) => edge.from));
  for (const node of nodes) {
    if (node.kind === "source" && incoming.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "source 不能有入边" });
    if (node.kind === "sink" && outgoing.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "sink 不能有出边" });
    if (node.kind !== "sink" && !outgoing.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "非 sink 节点必须有出边" });
  }
}

function validateDistribution(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (!isRecord(value)) return void issues.push({ path, message: "必须是分布对象" });
  if (value.kind === "deterministic") return validatePositive(value.value, `${path}.value`, issues);
  if (value.kind === "uniform") {
    validatePositive(value.minimum, `${path}.minimum`, issues);
    validatePositive(value.maximum, `${path}.maximum`, issues);
    if (typeof value.minimum === "number" && typeof value.maximum === "number" && value.maximum < value.minimum) issues.push({ path, message: "maximum 不得小于 minimum" });
    return;
  }
  if (value.kind === "normal") {
    validatePositive(value.mean, `${path}.mean`, issues);
    validatePositive(value.standardDeviation, `${path}.standardDeviation`, issues);
    return validateOptionalNonNegative(value.minimum, `${path}.minimum`, issues);
  }
  if (value.kind === "exponential") return validatePositive(value.mean, `${path}.mean`, issues);
  issues.push({ path: `${path}.kind`, message: "不支持的分布" });
}

function validateAvailability(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value) || (value.shifts !== undefined && !Array.isArray(value.shifts))) {
    return void issues.push({ path, message: "shifts 必须是数组" });
  }
  (value.shifts as unknown[] | undefined)?.forEach((shift, index) => validateShift(shift, `${path}.shifts[${index}]`, issues));
}

function validateShift(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (!isRecord(value)) return void issues.push({ path, message: "必须是对象" });
  validateMinute(value.startMinute, `${path}.startMinute`, issues);
  validateMinute(value.endMinute, `${path}.endMinute`, issues);
  if (typeof value.startMinute === "number" && typeof value.endMinute === "number" && value.startMinute >= value.endMinute) {
    issues.push({ path, message: "结束必须晚于开始；跨日请拆分为两个班次" });
  }
}

function validateRequiredResource(value: unknown, path: string, ids: Set<string>, issues: PlantLiteModelIssue[]): void {
  validateText(value, path, issues);
  if (typeof value === "string" && !ids.has(value)) issues.push({ path, message: "未知资源" });
}

function validateOptionalResource(value: unknown, path: string, ids: Set<string>, issues: PlantLiteModelIssue[]): void {
  if (value !== undefined) validateRequiredResource(value, path, ids, issues);
}

function hasCycle(ids: string[], adjacency: Map<string, string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const target of adjacency.get(id) ?? []) if (visit(target)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return ids.some(visit);
}

function validateUniqueText(value: unknown, path: string, ids: Set<string>, issues: PlantLiteModelIssue[]): void {
  validateText(value, path, issues);
  if (typeof value !== "string" || !value.trim()) return;
  if (ids.has(value)) issues.push({ path, message: "ID 重复" });
  ids.add(value);
}

function validateText(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (typeof value !== "string" || !value.trim() || value.length > 120) issues.push({ path, message: "必须是 1 到 120 个字符的文本" });
}

function validatePositive(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) issues.push({ path, message: "必须是正的有限数" });
}

function validatePositiveInteger(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) issues.push({ path, message: "必须是正整数" });
}

function validateOptionalPositiveInteger(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (value !== undefined) validatePositiveInteger(value, path, issues);
}

function validateOptionalNonNegative(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) issues.push({ path, message: "必须是非负有限数" });
}

function validateMinute(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_440) issues.push({ path, message: "必须是 0 到 1440 的整数分钟" });
}

function invalid(path: string, message: string): PlantLiteModelValidation {
  return { valid: false, issues: [{ path, message }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
