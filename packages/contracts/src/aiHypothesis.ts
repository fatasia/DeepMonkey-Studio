/**
 * H-C1 合同①：假设(HypothesisContract)与验证信封(VerificationEnvelope)。
 *
 * 世界模型 harness 的最小物化（AI-harness世界模型升级设计-20260929 §3.1）：
 * AI 提案有结构（strict 可校验），确定性内核验证后有统一判定（三态 verdict +
 * proposal/input/result 三指纹 + 理由码）。本文件只有类型与纯校验/判定函数，
 * 不含任何运行时、I/O 或内核调用；提案者（Agent）与裁决者（确定性判定函数）
 * 在此分离，verdict 只允许三态，inconclusive 必须携带缺失原因。
 *
 * 诚实边界：本合同只描述"对已注册确定性场景的指标假设"；不表达概率因果，
 * simulate 结果不得表述为实产预测。
 */

import { fingerprint64Labeled } from "./fingerprint.js";

/** 合同版本；字段语义变更必须换版本并同步校验函数。 */
export const AI_HYPOTHESIS_CONTRACT_VERSION = "1" as const;

/**
 * 目标场景白名单：假设只能指向显式注册的确定性校准场景。
 * 扩展新场景时在此追加，并在能力侧提供对应的运行配置；schema 外目标一律拒绝。
 */
export const AI_HYPOTHESIS_TARGET_MODELS = ["t23-conveyor-sensor-agv"] as const;
export type AiHypothesisTargetModel = (typeof AI_HYPOTHESIS_TARGET_MODELS)[number];

/**
 * 预测指标白名单：与 plant-lite DES 摘要口径一一对应（多重复均值）。
 * 不提供自由 JSON path —— 指标路径可枚举是机器裁决的前提。
 */
export const AI_HYPOTHESIS_METRICS = [
  "resource-utilization",
  "throughput-per-hour",
  "average-wip",
  "average-lead-time-minutes",
  "first-pass-yield",
] as const;
export type AiHypothesisMetric = (typeof AI_HYPOTHESIS_METRICS)[number];

/** 比较器只有两向；容差带内归属 inconclusive，不归属任一方向。 */
export const AI_HYPOTHESIS_COMPARATORS = ["less-than", "greater-than"] as const;
export type AiHypothesisComparator = (typeof AI_HYPOTHESIS_COMPARATORS)[number];

export interface AiHypothesisPrediction {
  metric: AiHypothesisMetric;
  /** metric 为 resource-utilization 时必填：目标资源 ID（能力侧校验存在于目标场景）。 */
  resourceId?: string;
  comparator: AiHypothesisComparator;
  /** 预期阈值；比例指标限 [0,1]，计数/时长指标须为正有限数。 */
  expected: number;
}

export interface AiHypothesisTolerance {
  /** 绝对容差；|observed-expected| <= absolute 时判 inconclusive（证据不足以双向裁决）。 */
  absolute: number;
}

/**
 * 假设合同：AI 的"提案"结构化形态。
 * 提案不含 seed/replications 等运行配置 —— 验证配置由目标场景的 golden 锚决定，
 * 保证验证可复现且与校准基准可比。
 */
export interface AiHypothesisContract {
  hypothesisVersion: typeof AI_HYPOTHESIS_CONTRACT_VERSION;
  /** 提案者给出的稳定标识；同一 id 重提时以指纹区分版本。 */
  id: string;
  /** 给人读的假设陈述；机器裁决只看 prediction + tolerance。 */
  statement: string;
  targetModel: AiHypothesisTargetModel;
  prediction: AiHypothesisPrediction;
  tolerance: AiHypothesisTolerance;
}

export type AiHypothesisVerdict = "confirmed" | "refuted" | "inconclusive";

/**
 * 理由码（确定性裁决输出，附缺失原因）：
 * - prediction-within-tolerance：观测值落在预测方向且越过容差带 → confirmed；
 * - prediction-outside-tolerance：观测值明确落在反方向且越过容差带 → refuted；
 * - prediction-in-tolerance-band：观测值落在容差带内 → inconclusive；
 * - golden-baseline-mismatch：校准基准哈希漂移 → 结论降级为 inconclusive（基准不可信）；
 * - metric-unavailable：目标场景该指标不可观测（如未配置质量工位）。
 */
export const AI_HYPOTHESIS_REASON_CODES = [
  "prediction-within-tolerance",
  "prediction-outside-tolerance",
  "prediction-in-tolerance-band",
  "golden-baseline-mismatch",
  "metric-unavailable",
] as const;
export type AiHypothesisReasonCode = (typeof AI_HYPOTHESIS_REASON_CODES)[number];

/** 指纹化证据：只存指纹与定位，不复制用户数据原文。 */
export interface AiHypothesisEvidence {
  id: string;
  kind: string;
  label: string;
  source: string;
  fingerprint?: string;
}

/** 验证信封：proposal→run→verdict 三元组的统一合同（H-C1 交付物验收的载体）。 */
export interface AiVerificationEnvelope {
  proposalFingerprint: string;
  inputFingerprint: string;
  resultFingerprint: string;
  verdict: AiHypothesisVerdict;
  tolerance: AiHypothesisTolerance;
  reasonCode: AiHypothesisReasonCode;
  /** 人读判定说明；不替代 reasonCode。 */
  rationale: string;
  /** 观测值与定位；metric-unavailable 时缺省。 */
  observed?: { metric: AiHypothesisMetric; resourceId?: string; value: number };
  /** 确定性引擎标识与校准基准对照（golden-baseline-mismatch 的证据）。 */
  engineId?: string;
  goldenHash?: string;
  goldenMatch?: boolean;
  generatedAt: string;
  evidence: AiHypothesisEvidence[];
  /** 非致命警告（如账本写失败但结果有效）：completed 态也必须透传到 UI，禁止静默丢弃（K7）。 */
  warnings?: readonly string[];
}

export class AiHypothesisContractError extends Error {
  public constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "AiHypothesisContractError";
  }
}

/** fail-closed 校验：schema 外形状、非有限数、白名单外枚举一律抛错，不让自由文本进入内核域。 */
export function validateAiHypothesisContract(value: unknown): AiHypothesisContract {
  const source = asRecord(value, "hypothesis");
  if (source.hypothesisVersion !== AI_HYPOTHESIS_CONTRACT_VERSION) {
    throw new AiHypothesisContractError("hypothesisVersion", `假设合同版本必须是 "${AI_HYPOTHESIS_CONTRACT_VERSION}"`);
  }
  const id = boundedText(source.id, "id", 200);
  const statement = boundedText(source.statement, "statement", 2_000);
  if (!AI_HYPOTHESIS_TARGET_MODELS.includes(source.targetModel as AiHypothesisTargetModel)) {
    throw new AiHypothesisContractError("targetModel", `目标场景 ${String(source.targetModel)} 不在已注册白名单`);
  }
  const prediction = validatePrediction(source.prediction);
  const tolerance = validateTolerance(source.tolerance, prediction.expected);
  return {
    hypothesisVersion: AI_HYPOTHESIS_CONTRACT_VERSION,
    id,
    statement,
    targetModel: source.targetModel as AiHypothesisTargetModel,
    prediction,
    tolerance,
  };
}

function validatePrediction(value: unknown): AiHypothesisPrediction {
  const source = asRecord(value, "prediction");
  if (!AI_HYPOTHESIS_METRICS.includes(source.metric as AiHypothesisMetric)) {
    throw new AiHypothesisContractError("prediction.metric", `预测指标 ${String(source.metric)} 不在可裁决指标白名单`);
  }
  const metric = source.metric as AiHypothesisMetric;
  const comparator = source.comparator;
  if (!AI_HYPOTHESIS_COMPARATORS.includes(comparator as AiHypothesisComparator)) {
    throw new AiHypothesisContractError("prediction.comparator", `比较器必须是 ${AI_HYPOTHESIS_COMPARATORS.join(" 或 ")}`);
  }
  if (typeof source.expected !== "number" || !Number.isFinite(source.expected)) {
    throw new AiHypothesisContractError("prediction.expected", "预期阈值必须是有限数字");
  }
  const expected = source.expected;
  if (isRatioMetric(metric) && (expected < 0 || expected > 1)) {
    throw new AiHypothesisContractError("prediction.expected", `比例指标 ${metric} 的阈值必须在 0 至 1 之间`);
  }
  if (!isRatioMetric(metric) && expected <= 0) {
    throw new AiHypothesisContractError("prediction.expected", `指标 ${metric} 的阈值必须是正数`);
  }
  const resourceId = metric === "resource-utilization"
    ? boundedText(source.resourceId, "prediction.resourceId", 200)
    : optionalText(source.resourceId, "prediction.resourceId", 200);
  return { metric, ...(resourceId ? { resourceId } : {}), comparator: comparator as AiHypothesisComparator, expected };
}

function validateTolerance(value: unknown, expected: number): AiHypothesisTolerance {
  const source = asRecord(value, "tolerance");
  if (typeof source.absolute !== "number" || !Number.isFinite(source.absolute) || source.absolute < 0) {
    throw new AiHypothesisContractError("tolerance.absolute", "绝对容差必须是非负有限数字");
  }
  const bound = Math.max(1, Math.abs(expected));
  if (source.absolute > bound) {
    throw new AiHypothesisContractError("tolerance.absolute", `绝对容差不得超过 ${bound}`);
  }
  return { absolute: source.absolute };
}

/**
 * proposalFingerprint：假设合同的唯一指纹（指纹唯一来源 fingerprint64Labeled）。
 * 字段增删或值变化都会改变结果，同输入恒同值 —— 审批/账本/审计三面共用。
 */
export function aiHypothesisProposalFingerprint(contract: AiHypothesisContract): string {
  return fingerprint64Labeled([
    ["ai-hypothesis", AI_HYPOTHESIS_CONTRACT_VERSION],
    ["contract", contract],
  ]);
}

/** 机器可读的指标定位；UI 卡片与审计 findings 共用同一拼写。 */
export function aiHypothesisMetricLocator(prediction: AiHypothesisPrediction): string {
  return prediction.resourceId ? `${prediction.metric}:${prediction.resourceId}` : prediction.metric;
}

/**
 * 确定性裁决函数：提案者（Agent）不参与判定，判定只由本函数根据观测值给出。
 * 容差带内判 inconclusive 而非强行归边 —— 三态语义是诚实条款。
 */
export function evaluateAiHypothesis(input: {
  prediction: AiHypothesisPrediction;
  tolerance: AiHypothesisTolerance;
  observed: number;
}): { verdict: AiHypothesisVerdict; reasonCode: AiHypothesisReasonCode } {
  const { prediction, tolerance, observed } = input;
  const holds = prediction.comparator === "less-than" ? observed < prediction.expected : observed > prediction.expected;
  const withinBand = Math.abs(observed - prediction.expected) <= tolerance.absolute;
  if (withinBand) return { verdict: "inconclusive", reasonCode: "prediction-in-tolerance-band" };
  if (holds) return { verdict: "confirmed", reasonCode: "prediction-within-tolerance" };
  return { verdict: "refuted", reasonCode: "prediction-outside-tolerance" };
}

/** fail-closed 校验验证信封：三指纹必须齐备且为 16 位十六进制（fingerprint64 口径）。 */
export function validateAiVerificationEnvelope(value: unknown): AiVerificationEnvelope {
  const source = asRecord(value, "envelope");
  for (const field of ["proposalFingerprint", "inputFingerprint", "resultFingerprint"] as const) {
    if (typeof source[field] !== "string" || !/^[0-9a-f]{16}$/.test(source[field] as string)) {
      throw new AiHypothesisContractError(field, `${field} 必须是 16 位小写十六进制指纹`);
    }
  }
  if (!["confirmed", "refuted", "inconclusive"].includes(source.verdict as string)) {
    throw new AiHypothesisContractError("verdict", "verdict 必须是 confirmed、refuted 或 inconclusive");
  }
  if (!AI_HYPOTHESIS_REASON_CODES.includes(source.reasonCode as AiHypothesisReasonCode)) {
    throw new AiHypothesisContractError("reasonCode", `理由码 ${String(source.reasonCode)} 不在枚举白名单`);
  }
  const toleranceSource = asRecord(source.tolerance, "tolerance");
  if (typeof toleranceSource.absolute !== "number" || !Number.isFinite(toleranceSource.absolute) || toleranceSource.absolute < 0) {
    throw new AiHypothesisContractError("tolerance.absolute", "绝对容差必须是非负有限数字");
  }
  const tolerance: AiHypothesisTolerance = { absolute: toleranceSource.absolute };
  if (typeof source.rationale !== "string" || !source.rationale.trim()) {
    throw new AiHypothesisContractError("rationale", "判定说明不能为空");
  }
  if (typeof source.generatedAt !== "string" || Number.isNaN(Date.parse(source.generatedAt))) {
    throw new AiHypothesisContractError("generatedAt", "generatedAt 必须是 ISO 8601 时间字符串");
  }
  if (!Array.isArray(source.evidence)) {
    throw new AiHypothesisContractError("evidence", "证据清单必须是数组");
  }
  return {
    proposalFingerprint: source.proposalFingerprint as string,
    inputFingerprint: source.inputFingerprint as string,
    resultFingerprint: source.resultFingerprint as string,
    verdict: source.verdict as AiHypothesisVerdict,
    tolerance,
    reasonCode: source.reasonCode as AiHypothesisReasonCode,
    rationale: source.rationale,
    ...(isRecord(source.observed) && typeof source.observed.value === "number" && Number.isFinite(source.observed.value)
      ? {
          observed: {
            metric: source.observed.metric as AiHypothesisMetric,
            ...(typeof source.observed.resourceId === "string" ? { resourceId: source.observed.resourceId } : {}),
            value: source.observed.value,
          },
        }
      : {}),
    ...(typeof source.engineId === "string" ? { engineId: source.engineId } : {}),
    ...(typeof source.goldenHash === "string" ? { goldenHash: source.goldenHash } : {}),
    ...(typeof source.goldenMatch === "boolean" ? { goldenMatch: source.goldenMatch } : {}),
    generatedAt: source.generatedAt,
    evidence: source.evidence.map(validateEvidence),
  };
}

function validateEvidence(value: unknown): AiHypothesisEvidence {
  const source = asRecord(value, "evidence");
  return {
    id: boundedText(source.id, "evidence.id", 300),
    kind: boundedText(source.kind, "evidence.kind", 100),
    label: boundedText(source.label, "evidence.label", 400),
    source: boundedText(source.source, "evidence.source", 400),
    ...(typeof source.fingerprint === "string" && source.fingerprint ? { fingerprint: source.fingerprint } : {}),
  };
}

function isRatioMetric(metric: AiHypothesisMetric): boolean {
  return metric === "resource-utilization" || metric === "first-pass-yield";
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiHypothesisContractError(label, `${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedText(value: unknown, field: string, limit: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new AiHypothesisContractError(field, `${field} 不能为空`);
  if (text.length > limit) throw new AiHypothesisContractError(field, `${field} 超过 ${limit} 字符`);
  return text;
}

function optionalText(value: unknown, field: string, limit: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedText(value, field, limit);
}
