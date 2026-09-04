import type { PlantLiteStudyRequest } from "@bim-studio/contracts";
import {
  validatePlantLiteModel,
  type Availability,
  type Distribution,
  type PlantLiteModel,
  type PlantLiteNode,
  type PlantLiteResource,
} from "@bim-studio/plant-lite-simulation";

export const PLANT_LITE_MODEL_EXCHANGE_SCHEMA = "bim-studio.plant-lite-model.v1" as const;
export const PLANT_LITE_MODEL_EXCHANGE_VERSION = 1 as const;
export const PLANT_LITE_MODEL_IMPORT_MAX_BYTES = 2_000_000;

export const PLANT_LITE_MODEL_UNITS = {
  time: "minute",
  power: "kilowatt",
  energy: "kilowatt-hour",
  electricityPrice: "CNY-per-kilowatt-hour",
  carbonEmissionFactor: "kilogram-co2e-per-kilowatt-hour",
} as const;

export interface PlantLiteModelExchangeFile {
  schema: typeof PLANT_LITE_MODEL_EXCHANGE_SCHEMA;
  version: typeof PLANT_LITE_MODEL_EXCHANGE_VERSION;
  source: {
    application: string;
    kind: "authoring-draft";
  };
  units: typeof PLANT_LITE_MODEL_UNITS;
  model: PlantLiteModel;
}

export interface PlantLiteModelImportPreview {
  fileName: string;
  sourceApplication: string;
  model: PlantLiteModel;
  nodeCount: number;
  resourceCount: number;
  resourceUnitCount: number;
}

export type PlantLiteModelImportResult =
  | { status: "ready"; preview: PlantLiteModelImportPreview }
  | { status: "invalid"; fileName: string; issues: string[] };

export function createPlantLiteModelExchange(model: PlantLiteModel): PlantLiteModelExchangeFile {
  const validation = validatePlantLiteModel(model);
  if (!validation.valid) {
    throw new Error(`当前模型未通过校验：${formatValidationIssue(validation.issues[0])}`);
  }
  return {
    schema: PLANT_LITE_MODEL_EXCHANGE_SCHEMA,
    version: PLANT_LITE_MODEL_EXCHANGE_VERSION,
    source: { application: "Deep Monkey Studio", kind: "authoring-draft" },
    units: { ...PLANT_LITE_MODEL_UNITS },
    model: portablePlantLiteModel(validation.model),
  };
}

export function serializePlantLiteModelExchange(value: PlantLiteModelExchangeFile): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function parsePlantLiteModelExchange(text: string, fileName: string): PlantLiteModelImportResult {
  const safeName = fileName.trim() || "未命名 JSON";
  if (!text.trim()) return invalid(safeName, "文件内容为空");
  if (new Blob([text]).size > PLANT_LITE_MODEL_IMPORT_MAX_BYTES) {
    return invalid(safeName, "文件超过 2 MB 上限");
  }

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return invalid(safeName, "不是有效的 JSON 文件");
  }
  if (!isRecord(input)) return invalid(safeName, "文件根节点必须是对象");

  const envelopeIssues = exchangeEnvelopeIssues(input);
  if (envelopeIssues.length) return { status: "invalid", fileName: safeName, issues: envelopeIssues };

  const validation = validatePlantLiteModel(input.model);
  if (!validation.valid) {
    return {
      status: "invalid",
      fileName: safeName,
      issues: validation.issues.slice(0, 12).map(formatValidationIssue),
    };
  }
  const model = portablePlantLiteModel(validation.model);
  const resources = model.resources ?? [];
  return {
    status: "ready",
    preview: {
      fileName: safeName,
      sourceApplication: (input.source as Record<string, unknown>).application as string,
      model,
      nodeCount: model.nodes.length,
      resourceCount: resources.length,
      resourceUnitCount: resources.reduce((sum, resource) => sum + resource.capacity, 0),
    },
  };
}

export function applyPlantLiteModelImport(
  request: PlantLiteStudyRequest,
  model: PlantLiteModel,
): PlantLiteStudyRequest {
  const validation = validatePlantLiteModel(model);
  if (!validation.valid) throw new Error(formatValidationIssue(validation.issues[0]));
  const { agvCount: _agvCount, bufferCapacity: _bufferCapacity, ...preserved } = request;
  return {
    ...preserved,
    templateId: "agv-line-v1",
    model: portablePlantLiteModel(validation.model),
  };
}

export function plantLiteModelExchangeFileName(model: PlantLiteModel): string {
  const stem = model.name.trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 56) || "plant-model";
  return `${stem}.plant-lite.json`;
}

function exchangeEnvelopeIssues(input: Record<string, unknown>): string[] {
  const issues: string[] = [];
  if (input.schema !== PLANT_LITE_MODEL_EXCHANGE_SCHEMA) issues.push("文件类型不受支持，请选择 Deep Monkey Studio Plant Lite 模型文件");
  if (input.version !== PLANT_LITE_MODEL_EXCHANGE_VERSION) issues.push("模型文件版本不受支持，当前仅支持 v1");
  if (!isRecord(input.source) || !validSource(input.source)) issues.push("缺少有效的模型来源声明");
  if (!isRecord(input.units)) issues.push("缺少模型单位声明");
  else {
    for (const [key, unit] of Object.entries(PLANT_LITE_MODEL_UNITS)) {
      if (input.units[key] !== unit) issues.push(`单位声明 ${key} 必须为 ${unit}`);
    }
  }
  if (!isRecord(input.model)) issues.push("缺少模型对象");
  return issues;
}

function validSource(value: Record<string, unknown>): boolean {
  return typeof value.application === "string"
    && value.application.trim().length > 0
    && value.application.length <= 120
    && value.kind === "authoring-draft";
}

/** 只拣选稳定模型合同字段，防止凭据或界面状态混入可交换文件。 */
function portablePlantLiteModel(model: PlantLiteModel): PlantLiteModel {
  return {
    id: model.id,
    name: model.name,
    nodes: model.nodes.map(portableNode),
    edges: model.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...(edge.priority !== undefined ? { priority: edge.priority } : {}),
    })),
    ...(model.resources ? { resources: model.resources.map(portableResource) } : {}),
    ...(model.productTypes ? { productTypes: model.productTypes.map((item) => ({ id: item.id, name: item.name, share: item.share })) } : {}),
    ...(model.energyEconomics ? { energyEconomics: { ...model.energyEconomics } } : {}),
  };
}

function portableNode(node: PlantLiteNode): PlantLiteNode {
  const base = { id: node.id, name: node.name };
  if (node.kind === "source") return {
    ...base,
    kind: node.kind,
    interarrivalTime: portableDistribution(node.interarrivalTime),
    ...(node.initialDelay !== undefined ? { initialDelay: node.initialDelay } : {}),
    ...(node.maxItems !== undefined ? { maxItems: node.maxItems } : {}),
  };
  if (node.kind === "station") return {
    ...base,
    kind: node.kind,
    processingTime: portableDistribution(node.processingTime),
    ...(node.yieldRate !== undefined ? { yieldRate: node.yieldRate } : {}),
    ...(node.capacity !== undefined ? { capacity: node.capacity } : {}),
    ...(node.queueCapacity !== undefined ? { queueCapacity: node.queueCapacity } : {}),
    ...(node.resourceId ? { resourceId: node.resourceId } : {}),
    ...(node.workerResourceId ? { workerResourceId: node.workerResourceId } : {}),
    ...(node.availability ? { availability: portableAvailability(node.availability) } : {}),
    ...(node.power ? { power: { ...node.power } } : {}),
    ...(node.changeovers ? { changeovers: node.changeovers.map((rule) => ({ ...rule })) } : {}),
  };
  if (node.kind === "transport") return {
    ...base,
    kind: node.kind,
    travelTime: portableDistribution(node.travelTime),
    resourceId: node.resourceId,
    ...(node.queueCapacity !== undefined ? { queueCapacity: node.queueCapacity } : {}),
  };
  if (node.kind === "buffer" || node.kind === "queue-buffer") return { ...base, kind: node.kind, capacity: node.capacity };
  return { ...base, kind: "sink" };
}

function portableResource(resource: PlantLiteResource): PlantLiteResource {
  return {
    id: resource.id,
    name: resource.name,
    kind: resource.kind,
    capacity: resource.capacity,
    ...(resource.availability ? { availability: portableAvailability(resource.availability) } : {}),
    ...(resource.failure ? {
      failure: {
        timeToFailure: portableDistribution(resource.failure.timeToFailure),
        repairTime: portableDistribution(resource.failure.repairTime),
      },
    } : {}),
    ...(resource.power ? { power: { ...resource.power } } : {}),
  };
}

function portableDistribution(value: Distribution): Distribution {
  return { ...value };
}

function portableAvailability(value: Availability): Availability {
  return { ...(value.shifts ? { shifts: value.shifts.map((shift) => ({ ...shift })) } : {}) };
}

function formatValidationIssue(issue: { path: string; message: string } | undefined): string {
  return issue ? `${issue.path}：${issue.message}` : "模型校验失败";
}

function invalid(fileName: string, issue: string): PlantLiteModelImportResult {
  return { status: "invalid", fileName, issues: [issue] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
