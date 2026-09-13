import type { BatteryModelVariant } from "./batteryModelGateway.js";

export type BatteryExpertRoutingMode = "standard" | "physics" | "dynamic" | "both";
export type BatteryLifeExpert = "standard" | "pinn";
export type BatteryTwinExpert = "electrothermal" | "pino" | "spm";

export interface BatteryExpertRoutingEvidence {
  schemaVersion: 1;
  mode: BatteryExpertRoutingMode;
  authority: "production-route";
  selectedExpert: BatteryLifeExpert;
  executedExperts: BatteryLifeExpert[];
  routePath: string[];
  reasons: string[];
  disagreementRatio?: number;
  reviewRequired: boolean;
  candidateComparison: {
    standard: BatteryLifeExpertSnapshot;
    pinn?: BatteryLifeExpertSnapshot;
  };
}

interface BatteryLifeExpertSnapshot {
  predictedCycleLife?: number;
  confidence?: string;
  modelVersion?: string;
  physicsArchitecture?: string;
  identifiedPhysicsParameters?: Record<string, unknown>;
}

interface ExpertDecision {
  selected: Record<string, unknown>;
  evidence: BatteryExpertRoutingEvidence;
}

/**
 * Python 服务保留模型信封；产品层展开业务结果，同时保留运行时和模型身份证据。
 * 这样页面不需要理解 transport 细节，审计字段也不会在展开时丢失。
 */
export function unwrapBatteryPrediction(output: Record<string, unknown>): Record<string, unknown> {
  const result = asRecord(output.result);
  if (!result) return output;
  return {
    ...result,
    serviceModel: typeof output.model === "string" ? output.model : undefined,
    serviceVariant: typeof output.variant === "string" ? output.variant : undefined,
    ...(output.runtimeExecution ? { runtimeExecution: output.runtimeExecution } : {}),
    ...(output.inferenceEvidence ? { inferenceEvidence: output.inferenceEvidence } : {}),
  };
}

/** 保持源工程的物理风险门：高外推、低拟合度、低置信或域告警才升级到 PINN。 */
export function physicsRiskReasons(output: Record<string, unknown>): string[] {
  const reasons: string[] = [];
  const features = asRecord(output.analysisFeatures);
  const trend = asRecord(features?.trend);
  const observed = finiteNumber(trend?.maxObservedCycle);
  const predicted = finiteNumber(output.predictedCycleLife);
  if (observed && predicted && predicted > observed && (predicted - observed) / observed > 4) {
    reasons.push(`寿命外推超过已观测区间 4 倍`);
  }
  const fitR2 = finiteNumber(trend?.averageFitR2);
  if (fitR2 !== undefined && fitR2 < 0.7) reasons.push("退化趋势拟合度低于 0.7");
  if (output.confidence !== "high") reasons.push("标准专家未达到高置信");
  const warnings = stringArray(output.warnings);
  if (warnings.some((item) => /外推|波动|覆盖范围|目标电芯子集|门槛|稀疏|域外/i.test(item))) {
    reasons.push("标准专家报告适用域或数据质量风险");
  }
  return unique(reasons);
}

/**
 * PINN 只有在原物理风险路由触发、结果完整且没有形成高分歧时才能成为最终结果。
 * 高分歧不做平均，继续保留标准专家并要求人工复核，避免把两个错误答案融合成伪精确值。
 */
export function selectLifeExpert(
  mode: BatteryExpertRoutingMode,
  standard: Record<string, unknown>,
  physics?: Record<string, unknown>,
  triggerReasons: string[] = physicsRiskReasons(standard),
): ExpertDecision {
  const standardLife = finiteNumber(standard.predictedCycleLife);
  const physicsLife = finiteNumber(physics?.predictedCycleLife);
  const directPhysics = mode === "physics";
  const disagreementRatio = !directPhysics && standardLife && physicsLife
    ? Math.abs(physicsLife - standardLife) / standardLife
    : undefined;
  const physicsReady = Boolean(physics && physicsLife !== undefined && physicsVariantWasUsed(physics));
  const highDisagreement = disagreementRatio !== undefined
    && Math.abs((physicsLife ?? 0) - (standardLife ?? 0)) >= 50
    && disagreementRatio >= 0.2;
  const physicsConfidence = confidenceRank(physics?.confidence);
  const standardConfidence = confidenceRank(standard.confidence);
  const forcePhysics = mode === "physics";
  const physicsSelected = physicsReady && !highDisagreement && (
    forcePhysics
    || standardLife === undefined
    || (triggerReasons.length > 0 && physicsConfidence >= standardConfidence)
  );
  const selectedExpert: BatteryLifeExpert = physicsSelected ? "pinn" : "standard";
  const executedExperts: BatteryLifeExpert[] = directPhysics ? ["pinn"] : physics ? ["standard", "pinn"] : ["standard"];
  const reasons = physicsSelected
    ? [...triggerReasons, "PINN 结果完整、置信不低于标准专家且通过分歧保护"]
    : highDisagreement
      ? [...triggerReasons, "标准专家与 PINN 分歧超过保护阈值，保留标准结果并要求复核"]
      : physics && !physicsReady
        ? [...triggerReasons, "PINN 未返回可验证的正式物理变体结果，保留标准专家"]
        : triggerReasons.length === 0
          ? ["标准专家通过物理风险门，未升级到 PINN"]
          : [...triggerReasons, "PINN 置信未优于标准专家，保留标准结果"];
  return {
    selected: physicsSelected ? physics! : standard,
    evidence: {
      schemaVersion: 1,
      mode,
      authority: "production-route",
      selectedExpert,
      executedExperts,
      routePath: directPhysics
        ? ["PINN 物理专家", "采纳 PINN"]
        : ["标准寿命专家", ...(physics ? ["PINN 物理专家"] : []), `采纳${selectedExpert === "pinn" ? " PINN" : "标准专家"}`],
      reasons: unique(reasons),
      ...(disagreementRatio !== undefined ? { disagreementRatio } : {}),
      reviewRequired: highDisagreement,
      candidateComparison: {
        standard: expertSnapshot(standard),
        ...(physics ? { pinn: expertSnapshot(physics) } : {}),
      },
    },
  };
}

/**
 * 把源服务的 TwinMoE 路由证据转换为平台正式输出。原始轻专家、PINO、SPM 字段全部保留，
 * 只新增 primary* 字段并修正最终摘要，便于追溯和回放。
 */
export function applyTwinProductionRoute(
  output: Record<string, unknown>,
  mode: "both" | "dynamic",
): Record<string, unknown> {
  const routing = asRecord(output.routing) ?? {};
  const evidence = asRecord(output.evidence) ?? {};
  const candidateEngine = String(output.candidateEngine ?? "");
  const fallback = candidateEngine === "spm-conservation-solver" || evidence.fallbackActivated === true;
  const candidateQualified = routing.shadowCandidateQualified === true;
  const selectedExpert: BatteryTwinExpert = fallback ? "spm" : candidateQualified ? "pino" : "electrothermal";
  const useCandidate = selectedExpert !== "electrothermal";
  const points = Array.isArray(output.points)
    ? output.points.map((item) => routeTwinPoint(asRecord(item) ?? {}, useCandidate))
    : [];
  const summary = asRecord(output.summary) ?? {};
  const finalPoint = points.at(-1);
  const finalSocPct = finiteNumber(finalPoint?.primarySocPct) ?? finiteNumber(summary.finalSocPct);
  return {
    ...output,
    status: "production-routed",
    primaryEngine: selectedExpert === "pino"
      ? "spm-pino-transformer"
      : selectedExpert === "spm" ? "spm-conservation-solver" : "electro-thermal-baseline",
    points,
    summary: {
      ...summary,
      ...(finalSocPct !== undefined ? { finalSocPct } : {}),
      selectedExpert,
    },
    routing: {
      ...routing,
      mode,
      authority: "production-route",
      adoptedAsPrimary: useCandidate,
      selectedExpert,
      productionRoute: true,
    },
  };
}

export function twinCommitState(output: Record<string, unknown>): { soc: number; temperatureC?: number } | undefined {
  const points = Array.isArray(output.points) ? output.points : [];
  const last = asRecord(points.at(-1));
  const socPct = finiteNumber(last?.primarySocPct);
  if (socPct === undefined) return undefined;
  const temperatureC = finiteNumber(last?.temperatureC);
  return { soc: Math.min(1, Math.max(0, socPct / 100)), ...(temperatureC !== undefined ? { temperatureC } : {}) };
}

export function expertVariant(mode: BatteryExpertRoutingMode): BatteryModelVariant {
  return mode === "physics" ? "physics" : "standard";
}

function routeTwinPoint(point: Record<string, unknown>, useCandidate: boolean): Record<string, unknown> {
  const primarySocPct = finiteNumber(useCandidate ? point.pinoSocPct : point.baselineSocPct);
  const primaryVoltageV = finiteNumber(useCandidate ? point.pinoVoltageV : point.baselineVoltageV);
  return {
    ...point,
    ...(primarySocPct !== undefined ? { primarySocPct } : {}),
    ...(primaryVoltageV !== undefined ? { primaryVoltageV } : {}),
  };
}

function physicsVariantWasUsed(output: Record<string, unknown>): boolean {
  if (output.serviceVariant === "physics") return true;
  const features = asRecord(output.analysisFeatures);
  return features?.advancedModelVariant === "physics" && features.advancedModelUsed === true;
}

function confidenceRank(value: unknown): number {
  return value === "high" ? 3 : value === "medium" ? 2 : value === "low" ? 1 : 0;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function expertSnapshot(output: Record<string, unknown>): BatteryLifeExpertSnapshot {
  const predictedCycleLife = finiteNumber(output.predictedCycleLife);
  const confidence = typeof output.confidence === "string" ? output.confidence : undefined;
  const modelVersion = typeof output.modelVersion === "string" ? output.modelVersion : undefined;
  const physicsArchitecture = typeof output.physicsArchitecture === "string" ? output.physicsArchitecture : undefined;
  const identifiedPhysicsParameters = asRecord(output.identifiedPhysicsParameters);
  return {
    ...(predictedCycleLife !== undefined ? { predictedCycleLife } : {}),
    ...(confidence ? { confidence } : {}),
    ...(modelVersion ? { modelVersion } : {}),
    ...(physicsArchitecture ? { physicsArchitecture } : {}),
    ...(identifiedPhysicsParameters ? { identifiedPhysicsParameters } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
