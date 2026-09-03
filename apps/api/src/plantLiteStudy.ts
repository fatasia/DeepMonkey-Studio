import { randomUUID } from "node:crypto";
import {
  AGV_LINE_TEMPLATE_ID,
  assertPlantLiteModel,
  createAgvLinePlantLiteModel,
  runPlantLiteExperiment,
  type PlantLiteExperiment,
  type PlantLiteExperimentResult,
  type PlantLiteModel,
} from "@bim-studio/plant-lite-simulation";
import type { PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";
import { evidenceFingerprint } from "./operationsEngine.js";

const EXECUTION_LIMITS = { durationMinutes: 480, warmupMinutes: 0, maxEvents: 100_000, maxResources: 100 } as const;
const TRACE_LIMITS = { replication: 0, maxEvents: 2_000, maxItems: 100 } as const;

interface NormalizedPlantLiteInput {
  name: string;
  templateId: typeof AGV_LINE_TEMPLATE_ID;
  model: PlantLiteModel;
  modelFingerprint: string;
  seed: string | number;
  replications: number;
  limits: { durationMinutes: number; warmupMinutes: number; maxEvents: number; maxResources: number };
  trace: { replication: number; maxEvents: number; maxItems: number };
  comparison?: NonNullable<PlantLiteStudyRequest["comparison"]>;
  acceptanceTargets?: NonNullable<PlantLiteStudyRequest["acceptanceTargets"]>;
  legacyTemplate?: { agvCount: number; bufferCapacity: number };
}

/** 将作者器模型适配到既有 DES 内核；这里不实现或复制求解逻辑。 */
export function runPlantLiteStudy(
  projectId: string,
  request: PlantLiteStudyRequest,
  now = new Date().toISOString(),
  shouldCancel?: () => boolean,
): PlantLiteStudyRecord {
  const input = normalizeRequest(request);
  const experiment: PlantLiteExperiment = {
    model: input.model,
    seed: input.seed,
    replications: input.replications,
    limits: input.limits,
    trace: input.trace,
  };
  const inputFingerprint = evidenceFingerprint({
    model: input.model,
    seed: input.seed,
    replications: input.replications,
    limits: fingerprintLimits(input.limits),
    trace: input.trace,
    acceptanceTargets: input.acceptanceTargets,
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
  });
  const result = runPlantLiteExperiment(experiment, shouldCancel ? { shouldCancel } : {});
  return {
    id: randomUUID(),
    projectId,
    createdAt: now,
    name: input.name,
    templateId: input.templateId,
    model: structuredClone(input.model),
    modelFingerprint: input.modelFingerprint,
    seed: input.seed,
    replications: input.replications,
    ...(result.representativeTrace ? { trace: result.representativeTrace } : {}),
    ...(input.comparison ? { comparison: input.comparison } : {}),
    ...(input.acceptanceTargets ? { acceptanceTargets: input.acceptanceTargets } : {}),
    ...(input.legacyTemplate ?? {}),
    inputFingerprint,
    outcome: outcome(result),
    execution: {
      engineId: "plant-lite-des",
      engineVersion: "1.0.0",
      inputFingerprint,
      deterministic: true,
      limits: input.limits,
      trace: input.trace,
    },
  };
}

export function plantLiteRequestFromRecord(record: PlantLiteStudyRecord): PlantLiteStudyRequest {
  return {
    name: record.name,
    templateId: record.templateId,
    ...(record.model ? { model: structuredClone(record.model) } : {}),
    ...(record.agvCount !== undefined ? { agvCount: record.agvCount } : {}),
    ...(record.bufferCapacity !== undefined ? { bufferCapacity: record.bufferCapacity } : {}),
    seed: record.seed,
    replications: record.replications,
    limits: { ...record.execution.limits },
    ...(record.execution.trace
      ? { trace: { ...record.execution.trace } }
      : record.trace
        ? { trace: { replication: record.trace.replication, ...record.trace.limits } }
        : {}),
    ...(record.comparison ? { comparison: { ...record.comparison } } : {}),
    ...(record.acceptanceTargets ? { acceptanceTargets: { ...record.acceptanceTargets } } : {}),
  };
}

function normalizeRequest(request: PlantLiteStudyRequest): NormalizedPlantLiteInput {
  const templateId = request.templateId === undefined ? AGV_LINE_TEMPLATE_ID : request.templateId;
  if (templateId !== AGV_LINE_TEMPLATE_ID) throw new Error("不支持的 Plant 起步模板");
  const rawName: unknown = request.name;
  if (rawName !== undefined && typeof rawName !== "string") throw new Error("方案名称必须是文本");
  const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : "AGV 两工位产线";
  if (name.length > 80) throw new Error("方案名称不能超过 80 个字符");
  const seed: unknown = request.seed === undefined ? "plant-lite-baseline" : request.seed;
  if (typeof seed !== "string" && typeof seed !== "number") throw new Error("seed 必须是短文本或安全整数");
  if (typeof seed === "string" && (!seed.trim() || seed.length > 120)) throw new Error("seed 必须是短文本或安全整数");
  if (typeof seed === "number" && !Number.isSafeInteger(seed)) throw new Error("seed 必须是短文本或安全整数");
  const replications = boundedInteger(request.replications, 12, 1, 30, "重复次数");
  const limits = normalizeLimits(request.limits);
  const trace = normalizeTrace(request.trace, replications);
  const comparison = normalizeComparison(request.comparison);
  const acceptanceTargets = normalizeAcceptanceTargets(request.acceptanceTargets);
  if (request.model !== undefined) {
    const model = assertPlantLiteModel(request.model);
    return {
      name, templateId, model, modelFingerprint: evidenceFingerprint(model), seed, replications, limits, trace,
      ...(comparison ? { comparison } : {}),
      ...(acceptanceTargets ? { acceptanceTargets } : {}),
    };
  }
  const agvCount = boundedInteger(request.agvCount, 4, 1, 12, "AGV 数量");
  const bufferCapacity = boundedInteger(request.bufferCapacity, 10, 1, 200, "缓冲容量");
  const model = createAgvLinePlantLiteModel({ agvCount, bufferCapacity });
  return {
    name,
    templateId,
    model,
    modelFingerprint: evidenceFingerprint(model),
    seed,
    replications,
    limits,
    trace,
    legacyTemplate: { agvCount, bufferCapacity },
    ...(comparison ? { comparison } : {}),
    ...(acceptanceTargets ? { acceptanceTargets } : {}),
  };
}

function normalizeAcceptanceTargets(
  input: PlantLiteStudyRequest["acceptanceTargets"],
): NormalizedPlantLiteInput["acceptanceTargets"] {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error("验收目标必须是对象");
  const basis = input.basis === undefined ? undefined : boundedOptionalText(input.basis, 160, "验收依据");
  const fields = {
    minimumThroughputPerHour: optionalPositive(input.minimumThroughputPerHour, 1_000_000_000, "最低吞吐"),
    maximumAverageWip: optionalPositive(input.maximumAverageWip, 1_000_000_000, "最大平均 WIP"),
    maximumAverageLeadTimeMinutes: optionalPositive(input.maximumAverageLeadTimeMinutes, 525_600, "最大平均交付周期"),
    maximumEnergyPerCompletedItemKwh: optionalPositive(input.maximumEnergyPerCompletedItemKwh, 1_000_000_000, "最大单位能耗"),
    maximumElectricityCostPerCompletedItem: optionalPositive(input.maximumElectricityCostPerCompletedItem, 1_000_000_000, "最大单位电费"),
    maximumCarbonEmissionPerCompletedItemKg: optionalPositive(input.maximumCarbonEmissionPerCompletedItemKg, 1_000_000_000, "最大单位碳排"),
  };
  const targets = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
  if (!basis && !Object.keys(targets).length) return undefined;
  return { ...(basis ? { basis } : {}), ...targets };
}

function normalizeComparison(input: PlantLiteStudyRequest["comparison"]): NormalizedPlantLiteInput["comparison"] {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error("方案实验信息必须是对象");
  return {
    groupId: boundedText(input.groupId, 160, "方案组标识"),
    baselineStudyId: boundedText(input.baselineStudyId, 160, "基线记录标识"),
    parameterLabel: boundedText(input.parameterLabel, 80, "实验参数"),
    candidateLabel: boundedText(input.candidateLabel, 120, "候选方案"),
  };
}

function normalizeTrace(input: PlantLiteStudyRequest["trace"], replications: number): NormalizedPlantLiteInput["trace"] {
  if (input !== undefined && !isRecord(input)) throw new Error("轨迹采集参数必须是对象");
  const trace = input as PlantLiteStudyRequest["trace"];
  return {
    replication: boundedInteger(trace?.replication, TRACE_LIMITS.replication, 0, replications - 1, "轨迹重复序号"),
    maxEvents: boundedInteger(trace?.maxEvents, TRACE_LIMITS.maxEvents, 1, 10_000, "轨迹事件数"),
    maxItems: boundedInteger(trace?.maxItems, TRACE_LIMITS.maxItems, 1, 500, "轨迹物料数"),
  };
}

function normalizeLimits(input: PlantLiteStudyRequest["limits"]): NormalizedPlantLiteInput["limits"] {
  if (input !== undefined && !isRecord(input)) throw new Error("运行上限必须是对象");
  const limits = input as PlantLiteStudyRequest["limits"];
  const durationMinutes = boundedNumber(limits?.durationMinutes, EXECUTION_LIMITS.durationMinutes, 0.01, 52_560, "总运行时长");
  const warmupMinutes = boundedNumber(limits?.warmupMinutes, EXECUTION_LIMITS.warmupMinutes, 0, 52_560, "预热期");
  if (warmupMinutes >= durationMinutes) throw new Error("预热期必须小于总运行时长");
  return {
    durationMinutes,
    warmupMinutes,
    maxEvents: boundedInteger(limits?.maxEvents, EXECUTION_LIMITS.maxEvents, 1, 1_000_000, "最大事件数"),
    maxResources: boundedInteger(limits?.maxResources, EXECUTION_LIMITS.maxResources, 1, 1_000, "最大资源数"),
  };
}

/** warmup=0 沿用旧指纹形状，使历史记录按明确的零预热语义仍可精确复现。 */
function fingerprintLimits(limits: NormalizedPlantLiteInput["limits"]): PlantLiteStudyRecord["execution"]["limits"] {
  const { warmupMinutes, ...legacyLimits } = limits;
  return warmupMinutes > 0 ? limits : legacyLimits;
}

function outcome(result: PlantLiteExperimentResult): PlantLiteStudyRecord["outcome"] {
  const completed = result.replications.filter((item) => item.termination === "completed");
  const hasCancellation = result.replications.some((item) => item.termination === "cancelled");
  const hasLimit = result.replications.some((item) => item.termination === "limit-reached");
  const hasItems = completed.some((item) => item.completedItems > 0);
  const status = hasCancellation ? "cancelled" : hasLimit ? "limited" : completed.length < 2 || !hasItems ? "insufficient-data" : "completed";
  const message = status === "cancelled" ? "客户端取消了离散仿真；未把未完成重复纳入置信区间。"
    : status === "limited" ? "离散仿真达到受限执行边界；仅展示已完成重复的统计结果。"
      : status === "insufficient-data" ? "有效完成重复不足 2 次或没有完成件，不能据此判断稳定的 95% 区间。" : undefined;
  return {
    status, ...(message ? { message } : {}), completedReplications: completed.length,
    throughputPerHour: result.confidence95.throughputPerHour,
    averageWip: result.confidence95.averageWip,
    averageLeadTimeMinutes: result.confidence95.averageLeadTimeMinutes,
    nodeMetrics95: result.nodeMetrics95,
    resourceUtilization95: result.resourceUtilization95,
    resourceFailedMinutes95: result.resourceFailedMinutes95,
    ...(Object.keys(result.productTypeMetrics95).length ? { productTypeMetrics95: result.productTypeMetrics95 } : {}),
    ...(Object.keys(result.productionOrderMetrics95).length ? { productionOrderMetrics95: result.productionOrderMetrics95 } : {}),
    ...(result.quality95 ? { quality: result.quality95 } : {}),
    ...(result.energy95 ? { energy: result.energy95 } : {}),
    bottlenecks: result.bottlenecks,
  };
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const numeric = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(numeric) || numeric < minimum || numeric > maximum) throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 的整数`);
  return numeric;
}

function boundedNumber(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string): number {
  const numeric = value === undefined ? fallback : value;
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) throw new Error(`${label}必须是 ${minimum} 到 ${maximum} 的有限数`);
  return numeric;
}

function boundedText(value: unknown, maximum: number, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) throw new Error(`${label}必须是 1 到 ${maximum} 个字符`);
  return normalized;
}

function boundedOptionalText(value: unknown, maximum: number, label: string): string | undefined {
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) throw new Error(`${label}不能超过 ${maximum} 个字符`);
  return normalized;
}

function optionalPositive(value: unknown, maximum: number, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > maximum) {
    throw new Error(`${label}必须大于 0 且不超过 ${maximum}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
