import { createHash, randomUUID } from "node:crypto";
import {
  BATTERY_MODEL_CATALOG,
  BATTERY_MODEL_CATALOG_VERSION,
  type BatteryInferenceEvidence,
  type BatteryInputDomainEvidence,
  type BatteryOnnxEquivalenceManifest,
  type FormalBatteryPrimaryModelId,
} from "@bim-studio/contracts";
import type { BatteryPredictionInput, FormalBatteryModel } from "./batteryModelGateway.js";
import type { BatteryPredictionRuntime } from "./batteryPredictionRouter.js";

const NUMERIC_FIELDS = [
  "cycle", "time", "time_s", "timestamp", "voltage", "voltage_v", "current", "current_a",
  "temperature", "temperature_c", "capacityAh", "dischargeCapacityAh", "chargeCapacityAh", "soh", "soc",
] as const;
const VOLTAGE_FIELDS = ["voltage", "voltage_v", "voltage_in_V"] as const;
const CURRENT_FIELDS = ["current", "current_a", "current_in_A"] as const;
const TEMPERATURE_FIELDS = ["temperature", "temperature_c", "temperature_in_C"] as const;
const TIME_FIELDS = ["time", "time_s", "time_in_s", "timestamp"] as const;

export interface BatteryInferenceContext {
  traceId: string;
  inputFingerprint: string;
  startedAt: string;
  startedAtMs: number;
  domain: BatteryInputDomainEvidence;
  modelId: FormalBatteryPrimaryModelId;
  requestedRuntime: BatteryPredictionRuntime;
  manifest?: BatteryOnnxEquivalenceManifest;
  routedExpert: boolean;
}

export interface BatteryInferenceCompletion {
  actualRuntime: BatteryPredictionRuntime;
  fellBack: boolean;
  fallbackReason?: string;
  domain?: BatteryInputDomainEvidence;
}

export class BatteryInferenceTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`电池 ONNX 推理超时（${timeoutMs}ms）`);
    this.name = "BatteryInferenceTimeoutError";
  }
}

/**
 * 只判断明确可审计的输入边界，不把“未发现异常”伪装成统计分布内。
 * 缺少化学体系或关键信号时返回 indeterminate，由模型自身门禁继续降置信。
 */
export function assessBatteryInputDomain(input: BatteryPredictionInput): BatteryInputDomainEvidence {
  const catalog = BATTERY_MODEL_CATALOG.find((entry) => entry.id === modelId(input.model));
  const chemistry = inferDeclaredChemistry(input);
  const invalidNumericValues = countInvalidNumericValues(input.records);
  const voltages = collectNumbers(input.records, VOLTAGE_FIELDS);
  const currents = collectNumbers(input.records, CURRENT_FIELDS);
  const temperatures = collectNumbers(input.records, TEMPERATURE_FIELDS);
  const capacities = collectNumbers(input.records, ["capacityAh", "dischargeCapacityAh", "chargeCapacityAh"]);
  const recognizedRows = input.records.filter((record) => [
    firstNumber(record, VOLTAGE_FIELDS), firstNumber(record, CURRENT_FIELDS), firstNumber(record, TIME_FIELDS),
  ].filter((value) => value !== undefined).length >= 2).length;
  const signalCoverage = recognizedRows / Math.max(1, input.records.length);
  const monotonicTimeRatio = input.model === "socformer" ? timeOrderRatio(input.records) : 1;
  const cRates = input.nominalCapacityAh && input.nominalCapacityAh > 0
    ? currents.map((current) => Math.abs(current / input.nominalCapacityAh!))
    : [];
  const rangeViolations = [
    ...voltages.filter((value) => value < 0 || value > 6),
    ...temperatures.filter((value) => value < -60 || value > 120),
    ...capacities.filter((value) => value < 0),
    ...cRates.filter((value) => value > 20),
  ].length;

  const reasons: string[] = [];
  if (invalidNumericValues > 0) reasons.push(`存在 ${invalidNumericValues} 个非有限数值字段`);
  if (rangeViolations > 0) reasons.push(`存在 ${rangeViolations} 个越过物理安全边界的数值`);
  if (monotonicTimeRatio < 0.9) reasons.push("连续采样时间顺序异常");
  if (chemistry.value && catalog && !catalog.chemistryScope.includes(chemistry.value)) {
    reasons.push(`化学体系 ${chemistry.value.toUpperCase()} 不在正式模型适用范围`);
  }

  const outOfDomain = invalidNumericValues > 0 || rangeViolations > 0 || monotonicTimeRatio < 0.9
    || Boolean(chemistry.value && catalog && !catalog.chemistryScope.includes(chemistry.value));
  if (!outOfDomain) {
    if (!chemistry.value) reasons.push("未声明或无法可靠识别化学体系");
    else if (chemistry.source !== "declared") reasons.push("化学体系来自文件或数据集名称推断，未由用户显式确认");
    if (signalCoverage < 0.8) reasons.push("电压、电流、时间关键信号覆盖不足，交由正式适配器进一步校验");
  }
  const supported = !outOfDomain && chemistry.source === "declared" && signalCoverage >= 0.8;
  return {
    status: outOfDomain ? "out-of-domain" : supported ? "supported" : "indeterminate",
    reasons,
    metrics: {
      recordCount: input.records.length,
      chemistry: chemistry.value ?? "unknown",
      chemistrySource: chemistry.source,
      signalCoverage: round(signalCoverage, 4),
      invalidNumericValues,
      rangeViolations,
      monotonicTimeRatio: round(monotonicTimeRatio, 4),
    },
  };
}

/** 使用已签名归一化统计后的张量检测明显域漂移，避免靠原始量纲猜测。 */
export function assessNormalizedTensorDomain(
  values: ArrayLike<number>,
  label: string,
): BatteryInputDomainEvidence {
  const samples = Array.from(values);
  const nonFinite = samples.filter((value) => !Number.isFinite(value)).length;
  const extreme = samples.filter((value) => Number.isFinite(value) && Math.abs(value) > 12).length;
  const extremeRatio = extreme / Math.max(1, samples.length);
  const status = nonFinite > 0 || extremeRatio > 0.2
    ? "out-of-domain" : extremeRatio > 0.05 ? "indeterminate" : "supported";
  const reasons = nonFinite > 0
    ? [`${label} 含 ${nonFinite} 个非有限归一化值`]
    : extremeRatio > 0.2
      ? [`${label} 有 ${(extremeRatio * 100).toFixed(1)}% 的特征超过 12σ`]
      : extremeRatio > 0.05 ? [`${label} 出现少量超过 12σ 的特征，置信度需降级`] : [];
  return {
    status,
    reasons,
    metrics: { normalizedSamples: samples.length, nonFinite, extreme, extremeRatio: round(extremeRatio, 4) },
  };
}

export function createBatteryInferenceContext(
  input: BatteryPredictionInput,
  requestedRuntime: BatteryPredictionRuntime,
  manifests: readonly BatteryOnnxEquivalenceManifest[],
): BatteryInferenceContext {
  const id = modelId(input.model);
  const manifest = manifests.find((candidate) => candidate.modelId === id);
  return {
    traceId: randomUUID(),
    inputFingerprint: fingerprintInput(input),
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now(),
    domain: assessBatteryInputDomain(input),
    modelId: id,
    requestedRuntime,
    ...(manifest ? { manifest } : {}),
    routedExpert: (input.variant ?? "standard") !== "standard",
  };
}

/** 附加最小证据；不会返回原始记录，也不会改写模型数值结果。 */
export function attachBatteryInferenceEvidence(
  output: Record<string, unknown>,
  context: BatteryInferenceContext,
  completion: BatteryInferenceCompletion,
): Record<string, unknown> {
  const domain = completion.domain ?? context.domain;
  const governed = governConfidence(output, domain, completion.actualRuntime, context.routedExpert);
  const catalog = BATTERY_MODEL_CATALOG.find((entry) => entry.id === context.modelId);
  if (!catalog) throw new Error(`电池目录缺少 ${context.modelId}`);
  // 回退到 Python 后不能把候选 ONNX 哈希误记成实际执行模型身份。
  const manifest = completion.actualRuntime === "onnx" ? context.manifest : undefined;
  const evidence: BatteryInferenceEvidence = {
    schemaVersion: 1,
    traceId: context.traceId,
    inputFingerprint: context.inputFingerprint,
    startedAt: context.startedAt,
    durationMs: Math.max(0, Date.now() - context.startedAtMs),
    authority: context.routedExpert ? "advisory" : "primary",
    routingPolicy: context.routedExpert
      ? "routed-expert-python"
      : context.requestedRuntime === "onnx" ? "approved-onnx-with-python-fallback" : "primary-python",
    requestedRuntime: context.requestedRuntime,
    actualRuntime: completion.actualRuntime,
    fellBack: completion.fellBack,
    ...(completion.fallbackReason ? { fallbackReason: cleanReason(completion.fallbackReason) } : {}),
    confidence: outputConfidence(governed),
    domain,
    model: {
      catalogVersion: BATTERY_MODEL_CATALOG_VERSION,
      catalogFingerprint: catalogFingerprint(catalog),
      modelId: context.modelId,
      modelVersion: catalog.modelVersion,
      ...(manifest ? {
        checkpointSha256: manifest.source.checkpointSha256,
        artifactSha256: manifest.artifact.sha256,
        runtimeAdapterSha256: manifest.runtimeAdapter.sha256,
        inputContract: manifest.contract.input,
        outputContract: manifest.contract.output,
        normalizationVersion: manifest.contract.preprocessing,
        postprocessingVersion: manifest.contract.postprocessing,
      } : {}),
    },
  };
  return { ...governed, inferenceEvidence: evidence };
}

export function outputDomainEvidence(output: Record<string, unknown>): BatteryInputDomainEvidence | undefined {
  const value = output.domainAssessment;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BatteryInputDomainEvidence>;
  if (!candidate.status || !["supported", "indeterminate", "out-of-domain"].includes(candidate.status)) return undefined;
  return {
    status: candidate.status,
    reasons: Array.isArray(candidate.reasons) ? candidate.reasons.filter((item): item is string => typeof item === "string") : [],
    metrics: candidate.metrics && typeof candidate.metrics === "object" && !Array.isArray(candidate.metrics)
      ? candidate.metrics : {},
  };
}

/** 超时会主动取消子信号；即使底层执行器不支持取消，也不会阻塞主链回退。 */
export function runBatteryInferenceWithTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  callerSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("电池推理超时必须为有限正数");
  if (callerSignal?.aborted) return Promise.reject(abortReason(callerSignal));
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
      action();
    };
    const abortFromCaller = () => {
      const reason = abortReason(callerSignal!);
      controller.abort(reason);
      finish(() => reject(reason));
    };
    const timer = setTimeout(() => {
      const error = new BatteryInferenceTimeoutError(timeoutMs);
      controller.abort(error);
      finish(() => reject(error));
    }, timeoutMs);
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    operation(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function governConfidence(
  output: Record<string, unknown>,
  domain: BatteryInputDomainEvidence,
  runtime: BatteryPredictionRuntime,
  routedExpert: boolean,
): Record<string, unknown> {
  if (runtime !== "onnx" || routedExpert || domain.status === "supported" || output.confidence !== "high") return output;
  const warning = domain.status === "indeterminate"
    ? "输入域信息不完整，ONNX 结果置信度由 High 降为 Medium。"
    : "输入超出已批准域，ONNX 结果不得作为 High 输出。";
  const warnings = Array.isArray(output.warnings)
    ? output.warnings.filter((item): item is string => typeof item === "string") : [];
  return { ...output, confidence: domain.status === "out-of-domain" ? "low" : "medium", warnings: [...warnings, warning] };
}

function fingerprintInput(input: BatteryPredictionInput): string {
  const records = input.records.map((record) => Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right))));
  const canonical = JSON.stringify({
    model: input.model,
    variant: input.variant ?? "standard",
    fileName: input.fileName,
    nominalCapacityAh: input.nominalCapacityAh ?? null,
    chemistry: input.chemistry ?? null,
    targetCapacityRetention: input.targetCapacityRetention ?? null,
    records,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function catalogFingerprint(catalog: (typeof BATTERY_MODEL_CATALOG)[number]): string {
  return createHash("sha256").update(JSON.stringify({
    version: BATTERY_MODEL_CATALOG_VERSION,
    id: catalog.id,
    modelVersion: catalog.modelVersion,
    role: catalog.role,
    authority: catalog.outputAuthority,
    tasks: catalog.tasks,
    chemistryScope: catalog.chemistryScope,
  })).digest("hex");
}

function inferDeclaredChemistry(input: BatteryPredictionInput): { value?: "lfp" | "ncm" | "na-ion"; source: "declared" | "inferred" | "unknown" } {
  if (input.chemistry) return { value: input.chemistry, source: "declared" };
  const source = input.records.map((record) => String(record.sourceDataset ?? "")).join("/");
  const text = `${input.fileName}/${source}`.toUpperCase();
  if (text.includes("NA-ION") || text.includes("SODIUM")) return { value: "na-ion", source: "inferred" };
  if (text.includes("LFP") || text.includes("HUST") || text.includes("MATR")) return { value: "lfp", source: "inferred" };
  if (text.includes("NCM") || text.includes("NMC")) return { value: "ncm", source: "inferred" };
  return { source: "unknown" };
}

function countInvalidNumericValues(records: BatteryPredictionInput["records"]): number {
  let invalid = 0;
  for (const record of records) for (const field of NUMERIC_FIELDS) {
    const value = record[field];
    if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) continue;
    if (!Number.isFinite(Number(value))) invalid += 1;
  }
  return invalid;
}

function collectNumbers(records: BatteryPredictionInput["records"], fields: readonly string[]): number[] {
  return records.flatMap((record) => {
    const value = firstNumber(record, fields);
    return value === undefined ? [] : [value];
  });
}

function firstNumber(record: BatteryPredictionInput["records"][number], fields: readonly string[]): number | undefined {
  for (const field of fields) {
    const raw = record[field];
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return undefined;
}

function timeOrderRatio(records: BatteryPredictionInput["records"]): number {
  const values = collectNumbers(records, TIME_FIELDS);
  if (values.length < 2) return 1;
  const ordered = values.slice(1).filter((value, index) => value >= values[index]!).length;
  return ordered / (values.length - 1);
}

function modelId(model: FormalBatteryModel): FormalBatteryPrimaryModelId {
  return `battery.${model}`;
}

function confidenceOf(value: unknown): BatteryInferenceEvidence["confidence"] {
  return value === "high" || value === "medium" || value === "low" ? value : "unknown";
}

/** Python 服务使用 { model, variant, result } 信封，ONNX 运行时则直接返回业务结果。 */
function outputConfidence(output: Record<string, unknown>): BatteryInferenceEvidence["confidence"] {
  const direct = confidenceOf(output.confidence);
  if (direct !== "unknown") return direct;
  const nested = output.result;
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? confidenceOf((nested as Record<string, unknown>).confidence)
    : "unknown";
}

function cleanReason(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 500);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("电池模型调用已取消");
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
