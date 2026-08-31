export type WhatIfValueMode = "absolute" | "relative";
export type WhatIfRiskLevel = "low" | "medium" | "high" | "critical";

export interface WhatIfBaselineMetric {
  metricId: string;
  value: number;
  unit?: string;
}

export interface WhatIfVariableChange {
  variableId: string;
  delta: number;
  mode: WhatIfValueMode;
  unit?: string;
}

export interface WhatIfElasticity {
  variableId: string;
  metricId: string;
  coefficient: number;
  inputMode: WhatIfValueMode;
  outputMode: WhatIfValueMode;
  /** 来自标定、历史回归或工程确认的可信度，必须由调用方显式提供。 */
  reliability: number;
  evidenceRef?: string;
}

export interface WhatIfConstraint {
  constraintId: string;
  metricId: string;
  minimum?: number;
  maximum?: number;
  severity: "warning" | "critical";
}

export interface WhatIfVariableDomain {
  variableId: string;
  mode: WhatIfValueMode;
  minimumDelta: number;
  maximumDelta: number;
}

export interface WhatIfMetricDomain {
  metricId: string;
  minimum: number;
  maximum: number;
}

export interface WhatIfApplicabilityDomain {
  variableRanges: readonly WhatIfVariableDomain[];
  metricRanges: readonly WhatIfMetricDomain[];
  evidenceRef?: string;
}

export interface WhatIfOperatingEnvelopeInput {
  baselines: readonly WhatIfBaselineMetric[];
  changes: readonly WhatIfVariableChange[];
  elasticities: readonly WhatIfElasticity[];
  constraints: readonly WhatIfConstraint[];
  applicabilityDomain: WhatIfApplicabilityDomain;
}

export interface WhatIfContributionEvidence {
  variableId: string;
  change: number;
  coefficient: number;
  inputMode: WhatIfValueMode;
  outputMode: WhatIfValueMode;
  predictedDelta: number;
  reliability: number;
  formula: string;
  evidenceRef?: string;
}

export interface WhatIfMetricPrediction {
  metricId: string;
  unit?: string;
  baseline: number;
  predictedDelta: number;
  predictedValue: number;
  relativeDelta: number | null;
  modeled: boolean;
  confidence: number;
  contributions: WhatIfContributionEvidence[];
}

export interface WhatIfConstraintEvaluation {
  constraintId: string;
  metricId: string;
  predictedValue: number;
  minimum?: number;
  maximum?: number;
  marginToMinimum?: number;
  marginToMaximum?: number;
  violatedBounds: Array<"minimum" | "maximum">;
  violated: boolean;
  severity: "warning" | "critical";
  normalizedExceedance: number;
}

export interface WhatIfApplicabilityCheck {
  subjectType: "variable" | "baseline-metric" | "predicted-metric" | "elasticity-coverage";
  subjectId: string;
  status: "inside" | "outside" | "unknown";
  explanation: string;
}

export interface WhatIfOperatingEnvelopeResult {
  method: "deterministic-local-elasticity-envelope-v1";
  predictions: WhatIfMetricPrediction[];
  constraintEvaluations: WhatIfConstraintEvaluation[];
  violatedConstraintIds: string[];
  unmodeledVariableIds: string[];
  applicability: {
    status: "supported" | "caution" | "out-of-domain";
    checks: WhatIfApplicabilityCheck[];
  };
  confidence: { score: number; level: "high" | "medium" | "low"; explanation: string };
  risk: { level: WhatIfRiskLevel; reasons: string[] };
  inputFingerprint: string;
  inputFingerprintAlgorithm: "fnv1a64-canonical-v1";
  evidenceFingerprint: string;
  fingerprintAlgorithm: "fnv1a64-canonical-v1";
  nonSolverDeclaration: string;
}

const NON_SOLVER_DECLARATION = "本结果是基于声明弹性的局部确定性响应估算，不是物理、离散事件或优化求解器结果；适用域外结果仅用于筛查，不得替代正式仿真与工程校核。";

/**
 * 计算局部 What-if 工况包络。函数不学习参数、不外推隐藏关系，也不写回业务状态；
 * 所有结果都由输入基线、变化量和显式弹性逐项得到。
 */
export function evaluateWhatIfOperatingEnvelope(input: WhatIfOperatingEnvelopeInput): WhatIfOperatingEnvelopeResult {
  validateInput(input);
  const baselines = [...input.baselines].sort(byMetricId);
  const changes = [...input.changes].sort(byVariableId);
  const elasticities = [...input.elasticities].sort(compareElasticity);
  const predictions = baselines.map((baseline) => predictMetric(baseline, changes, elasticities));
  const unmodeledVariableIds = changes
    .filter((change) => !elasticities.some((elasticity) => elasticity.variableId === change.variableId))
    .map((change) => change.variableId);
  const applicability = assessApplicability(input.applicabilityDomain, changes, predictions, unmodeledVariableIds);
  const constraintEvaluations = [...input.constraints].sort(byConstraintId)
    .map((constraint) => evaluateConstraint(constraint, predictions));
  const violatedConstraintIds = constraintEvaluations.filter((item) => item.violated).map((item) => item.constraintId);
  const confidence = assessConfidence(predictions, applicability.status, unmodeledVariableIds);
  const risk = assessRisk(constraintEvaluations, applicability.status);
  const normalizedInput = {
    method: "deterministic-local-elasticity-envelope-v1",
    baselines,
    changes,
    elasticities,
    constraints: [...input.constraints].sort(byConstraintId),
    applicabilityDomain: normalizedDomain(input.applicabilityDomain),
  };
  const evidencePayload = {
    ...normalizedInput,
    predictions,
    constraintEvaluations,
  };
  const inputFingerprint = `fnv1a64-canonical-v1:${fnv1a64(canonicalJson(normalizedInput))}`;
  return {
    method: "deterministic-local-elasticity-envelope-v1",
    predictions,
    constraintEvaluations,
    violatedConstraintIds,
    unmodeledVariableIds,
    applicability,
    confidence,
    risk,
    inputFingerprint,
    inputFingerprintAlgorithm: "fnv1a64-canonical-v1",
    evidenceFingerprint: `fnv1a64-canonical-v1:${fnv1a64(canonicalJson(evidencePayload))}`,
    fingerprintAlgorithm: "fnv1a64-canonical-v1",
    nonSolverDeclaration: NON_SOLVER_DECLARATION,
  };
}

function predictMetric(
  baseline: WhatIfBaselineMetric,
  changes: readonly WhatIfVariableChange[],
  elasticities: readonly WhatIfElasticity[],
): WhatIfMetricPrediction {
  const contributions = elasticities
    .filter((elasticity) => elasticity.metricId === baseline.metricId)
    .flatMap((elasticity) => {
      const change = changes.find((candidate) => candidate.variableId === elasticity.variableId);
      if (!change) return [];
      const scale = elasticity.outputMode === "relative" ? baseline.value : 1;
      const predictedDelta = scale * elasticity.coefficient * change.delta;
      return [{
        variableId: change.variableId,
        change: change.delta,
        coefficient: elasticity.coefficient,
        inputMode: elasticity.inputMode,
        outputMode: elasticity.outputMode,
        predictedDelta: finiteRound(predictedDelta),
        reliability: elasticity.reliability,
        formula: elasticity.outputMode === "relative"
          ? "baseline × coefficient × change" : "coefficient × change",
        ...(elasticity.evidenceRef ? { evidenceRef: elasticity.evidenceRef } : {}),
      }];
    });
  const predictedDelta = finiteRound(contributions.reduce((sum, item) => sum + item.predictedDelta, 0));
  const confidence = contributionConfidence(contributions);
  return {
    metricId: baseline.metricId,
    ...(baseline.unit ? { unit: baseline.unit } : {}),
    baseline: baseline.value,
    predictedDelta,
    predictedValue: finiteRound(baseline.value + predictedDelta),
    relativeDelta: baseline.value === 0 ? null : finiteRound(predictedDelta / Math.abs(baseline.value)),
    modeled: contributions.length > 0,
    confidence,
    contributions,
  };
}

function assessApplicability(
  domain: WhatIfApplicabilityDomain,
  changes: readonly WhatIfVariableChange[],
  predictions: readonly WhatIfMetricPrediction[],
  unmodeledVariableIds: readonly string[],
): WhatIfOperatingEnvelopeResult["applicability"] {
  const checks: WhatIfApplicabilityCheck[] = [];
  for (const change of changes) {
    const range = domain.variableRanges.find((candidate) => candidate.variableId === change.variableId && candidate.mode === change.mode);
    checks.push(range
      ? rangeCheck("variable", change.variableId, change.delta, range.minimumDelta, range.maximumDelta)
      : { subjectType: "variable", subjectId: change.variableId, status: "unknown", explanation: "未提供同量纲的变量变化适用域" });
  }
  for (const prediction of predictions) {
    const range = domain.metricRanges.find((candidate) => candidate.metricId === prediction.metricId);
    if (!range) {
      checks.push({ subjectType: "baseline-metric", subjectId: prediction.metricId, status: "unknown", explanation: "未提供指标适用域" });
      continue;
    }
    checks.push(rangeCheck("baseline-metric", prediction.metricId, prediction.baseline, range.minimum, range.maximum));
    checks.push(rangeCheck("predicted-metric", prediction.metricId, prediction.predictedValue, range.minimum, range.maximum));
  }
  for (const variableId of unmodeledVariableIds) checks.push({
    subjectType: "elasticity-coverage", subjectId: variableId, status: "unknown", explanation: "该变量没有声明任何响应弹性",
  });
  const status = checks.some((check) => check.status === "outside")
    ? "out-of-domain" : checks.some((check) => check.status === "unknown") ? "caution" : "supported";
  return { status, checks };
}

function evaluateConstraint(
  constraint: WhatIfConstraint,
  predictions: readonly WhatIfMetricPrediction[],
): WhatIfConstraintEvaluation {
  const prediction = predictions.find((candidate) => candidate.metricId === constraint.metricId)!;
  const violatedBounds: Array<"minimum" | "maximum"> = [];
  if (constraint.minimum !== undefined && prediction.predictedValue < constraint.minimum) violatedBounds.push("minimum");
  if (constraint.maximum !== undefined && prediction.predictedValue > constraint.maximum) violatedBounds.push("maximum");
  const lowerExceedance = constraint.minimum === undefined ? 0 : Math.max(0, constraint.minimum - prediction.predictedValue) / Math.max(1, Math.abs(constraint.minimum));
  const upperExceedance = constraint.maximum === undefined ? 0 : Math.max(0, prediction.predictedValue - constraint.maximum) / Math.max(1, Math.abs(constraint.maximum));
  return {
    constraintId: constraint.constraintId,
    metricId: constraint.metricId,
    predictedValue: prediction.predictedValue,
    ...(constraint.minimum !== undefined ? { minimum: constraint.minimum, marginToMinimum: finiteRound(prediction.predictedValue - constraint.minimum) } : {}),
    ...(constraint.maximum !== undefined ? { maximum: constraint.maximum, marginToMaximum: finiteRound(constraint.maximum - prediction.predictedValue) } : {}),
    violatedBounds,
    violated: violatedBounds.length > 0,
    severity: constraint.severity,
    normalizedExceedance: finiteRound(Math.max(lowerExceedance, upperExceedance)),
  };
}

function assessConfidence(
  predictions: readonly WhatIfMetricPrediction[],
  applicability: WhatIfOperatingEnvelopeResult["applicability"]["status"],
  unmodeledVariableIds: readonly string[],
): WhatIfOperatingEnvelopeResult["confidence"] {
  const modeled = predictions.filter((prediction) => prediction.modeled);
  const evidenceScore = modeled.length > 0
    ? modeled.reduce((sum, prediction) => sum + prediction.confidence, 0) / modeled.length : 0;
  const applicabilityFactor = applicability === "supported" ? 1 : applicability === "caution" ? 0.7 : 0.35;
  const coverageFactor = unmodeledVariableIds.length === 0 ? 1 : 1 / (1 + unmodeledVariableIds.length);
  const score = finiteRound(evidenceScore * applicabilityFactor * coverageFactor);
  const level = score >= 0.8 ? "high" : score >= 0.55 ? "medium" : "low";
  return {
    score,
    level,
    explanation: `弹性证据 ${format(evidenceScore)} × 适用域系数 ${format(applicabilityFactor)} × 变量覆盖系数 ${format(coverageFactor)}`,
  };
}

function assessRisk(
  constraints: readonly WhatIfConstraintEvaluation[],
  applicability: WhatIfOperatingEnvelopeResult["applicability"]["status"],
): WhatIfOperatingEnvelopeResult["risk"] {
  const violated = constraints.filter((constraint) => constraint.violated);
  const reasons = violated.map((constraint) => `${constraint.constraintId} 越过 ${constraint.violatedBounds.join("/")} 约束`);
  if (applicability === "out-of-domain") reasons.push("工况超出声明适用域");
  else if (applicability === "caution") reasons.push("适用域或弹性覆盖信息不完整");
  const level: WhatIfRiskLevel = violated.some((item) => item.severity === "critical")
    ? "critical" : violated.length > 0 ? "high" : applicability !== "supported" ? "medium" : "low";
  return { level, reasons };
}

function contributionConfidence(contributions: readonly WhatIfContributionEvidence[]): number {
  if (contributions.length === 0) return 0;
  const weights = contributions.map((item) => Math.abs(item.predictedDelta));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const score = total > 0
    ? contributions.reduce((sum, item, index) => sum + item.reliability * weights[index]!, 0) / total
    : contributions.reduce((sum, item) => sum + item.reliability, 0) / contributions.length;
  return finiteRound(score);
}

function rangeCheck(
  subjectType: WhatIfApplicabilityCheck["subjectType"],
  subjectId: string,
  value: number,
  minimum: number,
  maximum: number,
): WhatIfApplicabilityCheck {
  const inside = value >= minimum && value <= maximum;
  return { subjectType, subjectId, status: inside ? "inside" : "outside", explanation: `${format(value)} ${inside ? "位于" : "超出"} [${format(minimum)}, ${format(maximum)}]` };
}

function validateInput(input: WhatIfOperatingEnvelopeInput): void {
  if (input.baselines.length === 0) throw new Error("What-if 至少需要一个基线指标");
  if (input.changes.length === 0) throw new Error("What-if 至少需要一个可控变量变化");
  assertUnique(input.baselines.map((item) => item.metricId), "基线指标 ID");
  assertUnique(input.changes.map((item) => item.variableId), "变量 ID");
  assertUnique(input.constraints.map((item) => item.constraintId), "约束 ID");
  assertUnique(input.elasticities.map((item) => `${item.metricId}/${item.variableId}`), "弹性指标-变量组合");
  const metricIds = new Set(input.baselines.map((item) => item.metricId));
  const variableIds = new Set(input.changes.map((item) => item.variableId));
  for (const item of [...input.baselines, ...input.changes]) assertFiniteValues(item);
  for (const elasticity of input.elasticities) {
    assertFiniteValues(elasticity);
    if (!metricIds.has(elasticity.metricId) || !variableIds.has(elasticity.variableId)) throw new Error("弹性引用了未知指标或变量");
    if (elasticity.inputMode !== input.changes.find((item) => item.variableId === elasticity.variableId)!.mode) throw new Error(`弹性 ${elasticity.metricId}/${elasticity.variableId} 输入模式不一致`);
    if (elasticity.reliability < 0 || elasticity.reliability > 1) throw new Error("弹性可靠度必须在 0–1 范围内");
  }
  for (const constraint of input.constraints) {
    if (!metricIds.has(constraint.metricId)) throw new Error(`约束 ${constraint.constraintId} 引用了未知指标`);
    if (constraint.minimum === undefined && constraint.maximum === undefined) throw new Error(`约束 ${constraint.constraintId} 必须包含上下限`);
    assertFiniteValues(constraint);
    if (constraint.minimum !== undefined && constraint.maximum !== undefined && constraint.minimum > constraint.maximum) throw new Error(`约束 ${constraint.constraintId} 上下限倒置`);
  }
  validateDomain(input.applicabilityDomain, metricIds);
}

function validateDomain(domain: WhatIfApplicabilityDomain, metricIds: Set<string>): void {
  assertUnique(domain.variableRanges.map((item) => `${item.variableId}/${item.mode}`), "变量适用域");
  assertUnique(domain.metricRanges.map((item) => item.metricId), "指标适用域");
  for (const range of domain.variableRanges) {
    assertFiniteValues(range);
    if (!range.variableId.trim() || range.minimumDelta > range.maximumDelta) throw new Error(`变量 ${range.variableId} 适用域无效`);
  }
  for (const range of domain.metricRanges) {
    assertFiniteValues(range);
    if (!metricIds.has(range.metricId) || range.minimum > range.maximum) throw new Error(`指标 ${range.metricId} 适用域无效`);
  }
}

function normalizedDomain(domain: WhatIfApplicabilityDomain): WhatIfApplicabilityDomain {
  return {
    variableRanges: [...domain.variableRanges].sort((left, right) => byVariableId(left, right) || left.mode.localeCompare(right.mode)),
    metricRanges: [...domain.metricRanges].sort(byMetricId),
    ...(domain.evidenceRef ? { evidenceRef: domain.evidenceRef } : {}),
  };
}

function assertFiniteValues(value: object): void {
  for (const [key, item] of Object.entries(value)) if (typeof item === "number" && !Number.isFinite(item)) throw new Error(`${key} 必须为有限数`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (values.some((value) => !value.trim()) || new Set(values).size !== values.length) throw new Error(`${label} 必须非空且唯一`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}

function finiteRound(value: number): number {
  if (!Number.isFinite(value)) throw new Error("What-if 计算产生非有限结果，请检查基线、变化量和弹性");
  return Math.round(value * 1e9) / 1e9;
}

function byMetricId<T extends { metricId: string }>(left: T, right: T): number { return left.metricId.localeCompare(right.metricId); }
function byVariableId<T extends { variableId: string }>(left: T, right: T): number { return left.variableId.localeCompare(right.variableId); }
function byConstraintId(left: WhatIfConstraint, right: WhatIfConstraint): number { return left.constraintId.localeCompare(right.constraintId); }
function compareElasticity(left: WhatIfElasticity, right: WhatIfElasticity): number { return byMetricId(left, right) || byVariableId(left, right); }
function format(value: number): string { return Number(value.toFixed(6)).toString(); }
