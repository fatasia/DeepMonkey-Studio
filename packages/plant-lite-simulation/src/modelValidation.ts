import type {
  PlantLiteEdge,
  PlantLiteModel,
  PlantLiteModelIssue,
  PlantLiteModelValidation,
  PlantLiteNode,
  PlantLiteResource,
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
  if (input.resources !== undefined && !Array.isArray(input.resources)) {
    issues.push({ path: "$.resources", message: "必须是数组" });
  }
  if (input.productTypes !== undefined && !Array.isArray(input.productTypes)) {
    issues.push({ path: "$.productTypes", message: "必须是数组" });
  }
  if (input.productionOrders !== undefined && !Array.isArray(input.productionOrders)) {
    issues.push({ path: "$.productionOrders", message: "必须是数组" });
  }
  validateEnergyEconomics(input.energyEconomics, "$.energyEconomics", issues);
  if (issues.length) return { valid: false, issues };

  const productTypeIds = validateProductTypes(input.productTypes, issues);
  const nodeIds = new Set<string>();
  const resourceIds = new Set<string>();
  const resourceKinds = new Map<string, PlantLiteResource["kind"]>();
  const nodes = input.nodes as unknown[];
  const resources = Array.isArray(input.resources) ? input.resources : [];
  resources.forEach((value, index) => validateResource(value, index, resourceIds, resourceKinds, issues));
  nodes.forEach((value, index) => validateNode(value, index, nodeIds, resourceIds, resourceKinds, productTypeIds, issues));
  validateProductionOrders(input.productionOrders, nodes, productTypeIds, issues);
  validateEnergyConsumerIds(nodes, resources, issues);
  validateEnergyCompleteness(input, nodes, resources, issues);

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

function validateNode(
  value: unknown,
  index: number,
  ids: Set<string>,
  resources: Set<string>,
  resourceKinds: Map<string, PlantLiteResource["kind"]>,
  productTypeIds: Set<string>,
  issues: PlantLiteModelIssue[],
): void {
  const path = `$.nodes[${index}]`;
  if (!isRecord(value)) return void issues.push({ path, message: "必须是对象" });
  validateUniqueText(value.id, `${path}.id`, ids, issues);
  validateText(value.name, `${path}.name`, issues);
  if (value.kind === "source") return validateSource(value, path, issues);
  if (value.kind === "buffer" || value.kind === "queue-buffer") return validatePositiveInteger(value.capacity, `${path}.capacity`, issues);
  if (value.kind === "sink") return;
  if (value.kind === "station") return validateStation(value, path, resources, resourceKinds, productTypeIds, issues);
  if (value.kind === "transport") return validateTransport(value, path, resources, resourceKinds, issues);
  issues.push({ path: `${path}.kind`, message: "必须是 source、station、transport、queue-buffer 或 sink" });
}

function validateSource(value: Record<string, unknown>, path: string, issues: PlantLiteModelIssue[]): void {
  validateDistribution(value.interarrivalTime, `${path}.interarrivalTime`, issues);
  validateOptionalNonNegative(value.initialDelay, `${path}.initialDelay`, issues);
  validateOptionalPositiveInteger(value.maxItems, `${path}.maxItems`, issues);
}

function validateStation(
  value: Record<string, unknown>,
  path: string,
  resources: Set<string>,
  resourceKinds: Map<string, PlantLiteResource["kind"]>,
  productTypeIds: Set<string>,
  issues: PlantLiteModelIssue[],
): void {
  validateDistribution(value.processingTime, `${path}.processingTime`, issues);
  validateOptionalRatio(value.yieldRate, `${path}.yieldRate`, issues);
  validateOptionalPositiveInteger(value.capacity, `${path}.capacity`, issues);
  validateOptionalPositiveInteger(value.queueCapacity, `${path}.queueCapacity`, issues);
  validateOptionalResource(value.resourceId, `${path}.resourceId`, resources, issues);
  validateResourceKind(value.resourceId, `${path}.resourceId`, resourceKinds, ["equipment"], "工位资源必须是 equipment", issues);
  validateOptionalResource(value.workerResourceId, `${path}.workerResourceId`, resources, issues);
  validateResourceKind(value.workerResourceId, `${path}.workerResourceId`, resourceKinds, ["worker"], "人工资源必须是 worker", issues);
  validateAvailability(value.availability, `${path}.availability`, issues);
  validatePower(value.power, `${path}.power`, issues);
  validateChangeovers(value.changeovers, `${path}.changeovers`, value.capacity, productTypeIds, issues);
  if (value.resourceId !== undefined && value.power !== undefined) {
    issues.push({ path: `${path}.power`, message: "绑定设备资源的工位必须在资源层配置功率，避免重复计量" });
  }
}

function validateProductTypes(value: unknown, issues: PlantLiteModelIssue[]): Set<string> {
  const ids = new Set<string>();
  if (value === undefined) return ids;
  const entries = value as unknown[];
  if (entries.length < 2 || entries.length > 12) {
    issues.push({ path: "$.productTypes", message: "混流必须包含 2 到 12 个产品类型" });
  }
  const names = new Set<string>();
  let shareTotal = 0;
  entries.forEach((entry, index) => {
    const path = `$.productTypes[${index}]`;
    if (!isRecord(entry)) return void issues.push({ path, message: "必须是对象" });
    validateUniqueText(entry.id, `${path}.id`, ids, issues);
    validateText(entry.name, `${path}.name`, issues);
    if (typeof entry.name === "string" && entry.name.trim()) {
      const key = entry.name.trim().toLowerCase();
      if (names.has(key)) issues.push({ path: `${path}.name`, message: "产品名称重复" });
      names.add(key);
    }
    if (typeof entry.share !== "number" || !Number.isFinite(entry.share) || entry.share <= 0 || entry.share > 1) {
      issues.push({ path: `${path}.share`, message: "必须是大于 0 且不超过 1 的有限数" });
    } else {
      shareTotal += entry.share;
    }
  });
  if (entries.length && Math.abs(shareTotal - 1) > 1e-6) {
    issues.push({ path: "$.productTypes", message: "产品投放比例合计必须为 1" });
  }
  return ids;
}

function validateProductionOrders(
  value: unknown,
  nodes: unknown[],
  productTypeIds: Set<string>,
  issues: PlantLiteModelIssue[],
): void {
  if (value === undefined) return;
  const orders = value as unknown[];
  if (orders.length < 1 || orders.length > 200) {
    issues.push({ path: "$.productionOrders", message: "生产订单必须包含 1 到 200 条" });
  }
  const ids = new Set<string>();
  const sourceIds = new Set(nodes.flatMap((node) => isRecord(node) && node.kind === "source" && typeof node.id === "string" ? [node.id] : []));
  let totalQuantity = 0;
  orders.forEach((order, index) => {
    const path = `$.productionOrders[${index}]`;
    if (!isRecord(order)) return void issues.push({ path, message: "必须是对象" });
    validateUniqueText(order.id, `${path}.id`, ids, issues);
    validateText(order.name, `${path}.name`, issues);
    validateText(order.sourceNodeId, `${path}.sourceNodeId`, issues);
    if (typeof order.sourceNodeId === "string" && !sourceIds.has(order.sourceNodeId)) {
      issues.push({ path: `${path}.sourceNodeId`, message: "必须引用来料源" });
    }
    if (order.productTypeId !== undefined) validateProductTypeReference(order.productTypeId, `${path}.productTypeId`, productTypeIds, issues);
    validatePositiveInteger(order.quantity, `${path}.quantity`, issues);
    if (typeof order.quantity === "number" && Number.isSafeInteger(order.quantity) && order.quantity > 0) totalQuantity += order.quantity;
    validateNonNegative(order.releaseMinute, `${path}.releaseMinute`, issues);
    validateNonNegative(order.dueMinute, `${path}.dueMinute`, issues);
    if (typeof order.releaseMinute === "number" && typeof order.dueMinute === "number" && order.dueMinute < order.releaseMinute) {
      issues.push({ path: `${path}.dueMinute`, message: "交期不得早于释放时间" });
    }
    if (order.priority !== undefined && (!Number.isSafeInteger(order.priority) || Number(order.priority) < 0 || Number(order.priority) > 999)) {
      issues.push({ path: `${path}.priority`, message: "必须是 0 到 999 的整数" });
    }
  });
  if (totalQuantity > 100_000) issues.push({ path: "$.productionOrders", message: "计划总数量不能超过 100000 件" });
}

function validateChangeovers(
  value: unknown,
  path: string,
  stationCapacity: unknown,
  productTypeIds: Set<string>,
  issues: PlantLiteModelIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return void issues.push({ path, message: "必须是数组" });
  if (!productTypeIds.size) issues.push({ path, message: "必须先配置产品类型与混流比例" });
  if ((stationCapacity ?? 1) !== 1) issues.push({ path, message: "序列相关换型当前仅支持并行数为 1 的工位" });
  if (value.length > 132) issues.push({ path, message: "换型规则不能超过 132 条" });
  const pairs = new Set<string>();
  value.forEach((rule, index) => {
    const rulePath = `${path}[${index}]`;
    if (!isRecord(rule)) return void issues.push({ path: rulePath, message: "必须是对象" });
    validateProductTypeReference(rule.fromProductTypeId, `${rulePath}.fromProductTypeId`, productTypeIds, issues);
    validateProductTypeReference(rule.toProductTypeId, `${rulePath}.toProductTypeId`, productTypeIds, issues);
    if (rule.fromProductTypeId === rule.toProductTypeId) {
      issues.push({ path: rulePath, message: "同一产品类型不需要换型规则" });
    }
    validateBoundedPositive(rule.minutes, `${rulePath}.minutes`, 52_560, issues);
    if (typeof rule.fromProductTypeId === "string" && typeof rule.toProductTypeId === "string") {
      const key = `${rule.fromProductTypeId}\u0000${rule.toProductTypeId}`;
      if (pairs.has(key)) issues.push({ path: rulePath, message: "换型方向重复" });
      pairs.add(key);
    }
  });
}

function validateProductTypeReference(value: unknown, path: string, ids: Set<string>, issues: PlantLiteModelIssue[]): void {
  validateText(value, path, issues);
  if (typeof value === "string" && !ids.has(value)) issues.push({ path, message: "未知产品类型" });
}

function validateTransport(value: Record<string, unknown>, path: string, resources: Set<string>, resourceKinds: Map<string, PlantLiteResource["kind"]>, issues: PlantLiteModelIssue[]): void {
  validateDistribution(value.travelTime, `${path}.travelTime`, issues);
  validateOptionalPositiveInteger(value.queueCapacity, `${path}.queueCapacity`, issues);
  validateRequiredResource(value.resourceId, `${path}.resourceId`, resources, issues);
  validateResourceKind(value.resourceId, `${path}.resourceId`, resourceKinds, ["agv", "transport"], "搬运资源必须是 agv 或 transport", issues);
}

function validateResource(value: unknown, index: number, ids: Set<string>, kinds: Map<string, PlantLiteResource["kind"]>, issues: PlantLiteModelIssue[]): void {
  const path = `$.resources[${index}]`;
  if (!isRecord(value)) return void issues.push({ path, message: "必须是对象" });
  validateUniqueText(value.id, `${path}.id`, ids, issues);
  validateText(value.name, `${path}.name`, issues);
  if (value.kind !== "agv" && value.kind !== "transport" && value.kind !== "equipment" && value.kind !== "worker") {
    issues.push({ path: `${path}.kind`, message: "必须是 agv、transport、equipment 或 worker" });
  } else if (typeof value.id === "string" && value.id.trim()) {
    kinds.set(value.id, value.kind);
  }
  validatePositiveInteger(value.capacity, `${path}.capacity`, issues);
  validateAvailability(value.availability, `${path}.availability`, issues);
  if (value.kind === "worker" && value.power !== undefined) {
    issues.push({ path: `${path}.power`, message: "人工资源不参与设备能耗模型" });
  } else {
    validatePower(value.power, `${path}.power`, issues);
  }
  if (value.kind === "worker" && value.failure !== undefined) {
    issues.push({ path: `${path}.failure`, message: "人工资源不支持设备故障模型" });
    return;
  }
  if (value.failure === undefined) return;
  if (!isRecord(value.failure)) return void issues.push({ path: `${path}.failure`, message: "必须是对象" });
  validateDistribution(value.failure.timeToFailure, `${path}.failure.timeToFailure`, issues);
  validateDistribution(value.failure.repairTime, `${path}.failure.repairTime`, issues);
}

function validateEnergyCompleteness(
  model: Record<string, unknown>,
  nodes: unknown[],
  resources: unknown[],
  issues: PlantLiteModelIssue[],
): void {
  const hasPower = [...nodes, ...resources].some((value) => isRecord(value) && value.power !== undefined);
  if (hasPower && model.energyEconomics === undefined) {
    issues.push({ path: "$.energyEconomics", message: "配置功率后必须填写电价与碳排因子" });
  }
  if (!hasPower && model.energyEconomics !== undefined) {
    issues.push({ path: "$.energyEconomics", message: "至少为一个工位或资源配置功率" });
  }
}

function validateEnergyConsumerIds(nodes: unknown[], resources: unknown[], issues: PlantLiteModelIssue[]): void {
  const resourceConsumerIds = new Set(resources
    .filter((value) => isRecord(value) && value.power !== undefined && typeof value.id === "string")
    .map((value) => (value as Record<string, unknown>).id as string));
  for (const node of nodes) {
    if (!isRecord(node) || node.kind !== "station" || node.power === undefined || typeof node.id !== "string") continue;
    if (resourceConsumerIds.has(node.id)) {
      issues.push({ path: `$.nodes.${node.id}.id`, message: "计量工位与计量资源 ID 不得重复" });
    }
  }
}

function validateEnergyEconomics(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) return void issues.push({ path, message: "必须是对象" });
  validateNonNegative(value.electricityPricePerKwh, `${path}.electricityPricePerKwh`, issues);
  validateNonNegative(value.carbonEmissionFactorKgPerKwh, `${path}.carbonEmissionFactorKgPerKwh`, issues);
  validateOptionalEnum(value.source, `${path}.source`, ["estimate", "project", "measured"], issues);
}

function validatePower(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) return void issues.push({ path, message: "必须是对象" });
  validatePositive(value.activePowerKw, `${path}.activePowerKw`, issues);
  validateNonNegative(value.idlePowerKw, `${path}.idlePowerKw`, issues);
  validateOptionalEnum(value.source, `${path}.source`, ["estimate", "nameplate", "measured"], issues);
  if (typeof value.activePowerKw === "number" && typeof value.idlePowerKw === "number" && value.idlePowerKw > value.activePowerKw) {
    issues.push({ path, message: "待机功率不得高于运行功率" });
  }
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
  const sources = nodes.filter((node) => node.kind === "source");
  const sinks = nodes.filter((node) => node.kind === "sink");
  if (!sources.length) issues.push({ path: "$.nodes", message: "必须包含至少一个 source" });
  if (!sinks.length) issues.push({ path: "$.nodes", message: "必须包含至少一个 sink" });
  for (const node of nodes) {
    if (node.kind === "source" && incoming.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "source 不能有入边" });
    if (node.kind === "sink" && outgoing.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "sink 不能有出边" });
    if (node.kind !== "source" && !incoming.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "非 source 节点必须有入边" });
    if (node.kind !== "sink" && !outgoing.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "非 sink 节点必须有出边" });
  }
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to]);
  const reachable = new Set<string>();
  const pending = sources.map((node) => node.id);
  while (pending.length) {
    const id = pending.shift();
    if (!id || reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...(adjacency.get(id) ?? []));
  }
  for (const node of nodes) {
    if (sources.length && !reachable.has(node.id)) issues.push({ path: `$.nodes.${node.id}`, message: "节点无法从 source 到达" });
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
  const shifts = value.shifts as unknown[] | undefined;
  if (shifts && shifts.length > 8) issues.push({ path: `${path}.shifts`, message: "每日班次窗口不能超过 8 个" });
  shifts?.forEach((shift, index) => validateShift(shift, `${path}.shifts[${index}]`, issues));
  const ordered = (shifts ?? [])
    .flatMap((shift, index) => isRecord(shift)
      && typeof shift.startMinute === "number" && Number.isFinite(shift.startMinute)
      && typeof shift.endMinute === "number" && Number.isFinite(shift.endMinute)
      && shift.startMinute < shift.endMinute
      ? [{ index, startMinute: shift.startMinute, endMinute: shift.endMinute }]
      : [])
    .sort((left, right) => left.startMinute - right.startMinute || left.endMinute - right.endMinute);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]!.startMinute < ordered[index - 1]!.endMinute) {
      issues.push({ path: `${path}.shifts`, message: `班次 ${ordered[index - 1]!.index + 1} 与班次 ${ordered[index]!.index + 1} 时间重叠` });
      break;
    }
  }
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

function validateResourceKind(
  value: unknown,
  path: string,
  kinds: Map<string, PlantLiteResource["kind"]>,
  allowed: PlantLiteResource["kind"][],
  message: string,
  issues: PlantLiteModelIssue[],
): void {
  if (typeof value !== "string") return;
  const kind = kinds.get(value);
  if (kind && !allowed.includes(kind)) issues.push({ path, message });
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

function validateBoundedPositive(value: unknown, path: string, maximum: number, issues: PlantLiteModelIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    issues.push({ path, message: `必须是大于 0 且不超过 ${maximum} 的有限数` });
  }
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

function validateOptionalRatio(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
    issues.push({ path, message: "必须是 0 到 1 的有限数" });
  }
}

function validateNonNegative(value: unknown, path: string, issues: PlantLiteModelIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) issues.push({ path, message: "必须是非负有限数" });
}

function validateOptionalEnum(value: unknown, path: string, allowed: string[], issues: PlantLiteModelIssue[]): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    issues.push({ path, message: `必须是 ${allowed.join("、")}` });
  }
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
