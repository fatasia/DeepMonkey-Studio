import { createHash, randomUUID } from "node:crypto";
import type {
  EnergyInsightRecord,
  EnergyObservation,
  LogisticsExperimentRequest,
  LogisticsExperimentResult,
  MaintenanceAssessmentRecord,
  MaintenanceDeploymentRecord,
  MaintenanceModelArtifact,
  MaintenanceModelPackage,
  MaintenanceShadowEvaluation
} from "@bim-studio/contracts";

export interface PreparedMaintenanceWindow {
  rows: Array<Record<string, number>>;
  dataQuality: number;
  driftScore: number;
  topContributors: Array<{ feature: string; value: number }>;
}

export function prepareMaintenanceWindow(
  model: MaintenanceModelPackage,
  deployment: MaintenanceDeploymentRecord,
  sourceRows: Array<Record<string, number>>
): PreparedMaintenanceWindow {
  const features = model.artifact.features;
  const rows = sourceRows.slice(-Math.max(1, deployment.windowSize)).map((source) => Object.fromEntries(features.map((feature) => {
    const sourceField = deployment.featureMappings[feature] || feature;
    return [feature, Number(source[sourceField])];
  })));
  const total = Math.max(1, rows.length * features.length);
  const valid = rows.reduce((count, row) => count + features.filter((feature) => Number.isFinite(row[feature])).length, 0);
  const means = model.artifact.means ?? model.artifact.featureMeans ?? [];
  const stds = model.artifact.stds ?? model.artifact.featureStds ?? [];
  const recent = rows.slice(-Math.min(60, rows.length));
  const shifts = features.map((feature, index) => {
    if (!Number.isFinite(means[index]) || !Number.isFinite(stds[index]) || Number(stds[index]) <= 0) return 0;
    const values = recent.map((row) => row[feature]).filter((value): value is number => value !== undefined && Number.isFinite(value));
    if (!values.length) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Math.abs(mean - Number(means[index])) / Number(stds[index]);
  });
  const latest = rows.at(-1) ?? {};
  const topContributors = features.map((feature, index) => {
    const std = Number(stds[index]);
    const z = Number.isFinite(means[index]) && Number.isFinite(std) && std > 0
      ? (Number(latest[feature]) - Number(means[index])) / std
      : 0;
    return { feature, value: round(Math.abs(z * Number(model.artifact.weights?.[index] ?? 1)), 4) };
  }).sort((left, right) => right.value - left.value).slice(0, 5);
  return {
    rows,
    dataQuality: valid / total,
    driftScore: Math.max(0, ...shifts),
    topContributors
  };
}

export function scoreNativeArtifact(artifact: MaintenanceModelArtifact, row: Record<string, number>): number {
  if (!artifact.weights?.length || artifact.weights.length !== artifact.features.length) {
    throw new Error("native-json 模型的 weights 必须与 features 等长");
  }
  const means = artifact.means ?? artifact.featureMeans ?? artifact.features.map(() => 0);
  const stds = artifact.stds ?? artifact.featureStds ?? artifact.features.map(() => 1);
  const linear = artifact.weights.reduce((sum, weight, index) => {
    const raw = Number(row[artifact.features[index]!]);
    if (!Number.isFinite(raw)) throw new Error(`模型输入 ${artifact.features[index]} 不是有效数字`);
    const standardized = (raw - Number(means[index] ?? 0)) / (Number(stds[index] ?? 1) || 1);
    return sum + weight * standardized;
  }, Number(artifact.bias ?? 0));
  if (artifact.modelKind === "failure-probability" || artifact.modelKind === "anomaly") {
    return sigmoid(linear);
  }
  if (Number.isFinite(artifact.outputMean) && Number.isFinite(artifact.outputStd)) {
    return linear * Number(artifact.outputStd) + Number(artifact.outputMean);
  }
  return Math.max(0, linear);
}

export function buildMaintenanceAssessment(input: {
  projectId: string;
  model: MaintenanceModelPackage;
  deployment: MaintenanceDeploymentRecord;
  window: PreparedMaintenanceWindow;
  score?: number;
  now?: string;
}): MaintenanceAssessmentRecord {
  const { model, deployment, window } = input;
  const generatedAt = input.now ?? new Date().toISOString();
  const fingerprint = evidenceFingerprint({ model: model.version, deployment: deployment.id, rows: window.rows });
  let decisionStatus: MaintenanceAssessmentRecord["decisionStatus"] = model.productionEligible ? "validated" : "shadow";
  let riskLevel: MaintenanceAssessmentRecord["riskLevel"] = "unknown";
  let message = "模型已完成影子评分";
  if (window.rows.length < model.gates.minimumSamples || window.dataQuality < model.gates.minimumDataQuality) {
    decisionStatus = "insufficient-data";
    message = `输入不足：${window.rows.length} 条样本，完整率 ${(window.dataQuality * 100).toFixed(1)}%`;
  } else if (window.driftScore > model.gates.maximumDriftSigma) {
    decisionStatus = "drift-blocked";
    message = `输入分布偏移 ${window.driftScore.toFixed(2)}σ，已拒绝输出确定性风险/RUL`;
  } else if (input.score !== undefined) {
    riskLevel = maintenanceRiskLevel(input.score, model);
    const unit = model.artifact.targetUnit ? ` ${model.artifact.targetUnit}` : "";
    message = model.artifact.modelKind === "rul" || model.artifact.modelKind === "regression"
      ? `预测值 ${input.score.toFixed(2)}${unit}${Number.isFinite(model.artifact.residualP90) ? `，P90 误差带 ±${Number(model.artifact.residualP90).toFixed(2)}` : ""}`
      : `风险 ${(input.score * 100).toFixed(1)}%，${riskLabel(riskLevel)}`;
  }
  return {
    id: randomUUID(), projectId: input.projectId, deploymentId: deployment.id, modelId: model.id,
    modelVersion: model.version, generatedAt, decisionStatus,
    ...(input.score !== undefined && decisionStatus !== "insufficient-data" && decisionStatus !== "drift-blocked" ? { score: round(input.score, 6) } : {}),
    riskLevel, dataQuality: round(window.dataQuality, 6), driftScore: round(window.driftScore, 6),
    sampleCount: window.rows.length, topContributors: window.topContributors, message, evidenceFingerprint: fingerprint
  };
}

export function evaluateMaintenanceShadow(input: {
  projectId: string;
  modelId: string;
  rows: Array<Record<string, number>>;
  scores: number[];
  labelColumn: string;
  threshold: number;
  timeColumn?: string;
  minimumRecall?: number;
  maximumFalseAlarmsPerThousand?: number;
  now?: string;
}): MaintenanceShadowEvaluation {
  const length = Math.min(input.rows.length, input.scores.length);
  if (length < 30) throw new Error("影子评测至少需要 30 条带标签样本");
  let truePositive = 0, falsePositive = 0, trueNegative = 0, falseNegative = 0;
  let firstAlert = -1, firstFailure = -1;
  for (let index = 0; index < length; index += 1) {
    const positive = Number(input.rows[index]?.[input.labelColumn]) > 0;
    const alerted = Number(input.scores[index]) >= input.threshold;
    if (alerted && firstAlert < 0) firstAlert = index;
    if (positive && firstFailure < 0) firstFailure = index;
    if (alerted && positive) truePositive += 1;
    else if (alerted) falsePositive += 1;
    else if (positive) falseNegative += 1;
    else trueNegative += 1;
  }
  const precision = truePositive / Math.max(1, truePositive + falsePositive);
  const recall = truePositive / Math.max(1, truePositive + falseNegative);
  const f1 = 2 * precision * recall / Math.max(1e-9, precision + recall);
  const falseAlarmsPerThousand = falsePositive / length * 1000;
  const leadSamples = firstAlert >= 0 && firstFailure >= 0 && firstAlert <= firstFailure ? firstFailure - firstAlert : undefined;
  let leadHours: number | undefined;
  if (leadSamples !== undefined && input.timeColumn) {
    const start = Number(input.rows[firstAlert]?.[input.timeColumn]);
    const end = Number(input.rows[firstFailure]?.[input.timeColumn]);
    if (Number.isFinite(start) && Number.isFinite(end)) leadHours = Math.max(0, end - start) / 3600;
  }
  return {
    id: randomUUID(), projectId: input.projectId, modelId: input.modelId, createdAt: input.now ?? new Date().toISOString(),
    samples: length, positives: truePositive + falseNegative, truePositive, falsePositive, trueNegative, falseNegative,
    precision: round(precision, 6), recall: round(recall, 6), f1: round(f1, 6),
    falseAlarmsPerThousand: round(falseAlarmsPerThousand, 3), ...(leadSamples !== undefined ? { leadSamples } : {}),
    ...(leadHours !== undefined ? { leadHours: round(leadHours, 3) } : {}), threshold: input.threshold,
    passed: recall >= (input.minimumRecall ?? 0.7) && falseAlarmsPerThousand <= (input.maximumFalseAlarmsPerThousand ?? 50),
    fingerprint: evidenceFingerprint({ modelId: input.modelId, threshold: input.threshold, scores: input.scores.slice(0, length), labels: input.rows.slice(0, length).map((row) => row[input.labelColumn]) })
  };
}

export function runLogisticsExperiment(projectId: string, request: LogisticsExperimentRequest, now = new Date().toISOString()): LogisticsExperimentResult {
  const name = request.name?.trim() || "未命名物流工况";
  const agvCount = clampInteger(request.agvCount, 1, 100);
  const cycleTimeSec = clamp(request.cycleTimeSec, 1, 86_400);
  const chargingMinutesPerHour = clamp(request.chargingMinutesPerHour, 0, 59);
  const congestionFactor = clamp(request.congestionFactor, 0, 3);
  const demandPerHour = clamp(request.demandPerHour, 0, 1_000_000);
  const bufferCapacity = clampInteger(request.bufferCapacity, 1, 1_000_000);
  const durationHours = clamp(request.durationHours, 0.1, 8_760);
  const availability = (60 - chargingMinutesPerHour) / 60;
  const transportCapacity = agvCount * 3600 / cycleTimeSec * availability / (1 + congestionFactor);
  const bufferLimit = bufferCapacity * 60 / Math.max(1, cycleTimeSec / 60);
  const throughputPerHour = Math.min(demandPerHour, transportCapacity, bufferLimit);
  const utilization = throughputPerHour / Math.max(1e-9, transportCapacity);
  const averageWip = Math.min(bufferCapacity, Math.max(0, throughputPerHour * cycleTimeSec / 3600 * (1 + utilization * congestionFactor)));
  const leadTimeMinutes = throughputPerHour > 0 ? averageWip / throughputPerHour * 60 + cycleTimeSec / 60 : 0;
  const bottleneck: LogisticsExperimentResult["bottleneck"] = demandPerHour <= Math.min(transportCapacity, bufferLimit)
    ? "demand" : transportCapacity <= bufferLimit ? "transport" : "buffer";
  const recommendation = bottleneck === "transport"
    ? `运输能力受限；优先减少拥堵/充电占用，或评估增加 ${Math.max(1, Math.ceil(demandPerHour / Math.max(1, transportCapacity / agvCount) - agvCount))} 台 AGV`
    : bottleneck === "buffer" ? "缓冲区限制吞吐；先验证扩容后的 WIP 与占地代价" : "当前物流能力覆盖需求，不建议仅为提高利用率继续增加 AGV";
  const normalized = {
    name,
    agvCount,
    bufferCapacity,
    demandPerHour,
    cycleTimeSec,
    chargingMinutesPerHour,
    congestionFactor,
    durationHours,
  };
  const fingerprint = evidenceFingerprint(normalized);
  return {
    ...normalized, id: randomUUID(), projectId, createdAt: now,
    throughputPerHour: round(throughputPerHour, 2), fulfilledRate: round(demandPerHour ? throughputPerHour / demandPerHour : 1, 4),
    utilization: round(utilization, 4), averageWip: round(averageWip, 2), leadTimeMinutes: round(leadTimeMinutes, 2), bottleneck, recommendation,
    fingerprint,
    execution: {
      engineId: "factory-flow-analytic",
      engineVersion: "1.0.0",
      inputFingerprint: fingerprint,
      deterministic: true,
    },
  };
}

export function analyzeEnergy(projectId: string, observations: EnergyObservation[], now = new Date().toISOString()): EnergyInsightRecord {
  const usable = observations.filter((item) => Number.isFinite(item.output) && item.output > 0 && Number.isFinite(item.energyKwh) && item.energyKwh >= 0);
  if (usable.length < 4) throw new Error("能耗分析至少需要 4 条同时包含产量与能耗的有效样本");
  const intensities = usable.map((item) => item.energyKwh / item.output);
  const baselineSamples = intensities.slice(0, Math.max(3, Math.floor(intensities.length * 0.75)));
  const baselineKwhPerUnit = median(baselineSamples);
  const currentKwhPerUnit = intensities.at(-1)!;
  const deviationPercent = baselineKwhPerUnit > 0 ? (currentKwhPerUnit - baselineKwhPerUnit) / baselineKwhPerUnit * 100 : 0;
  const latest = usable.at(-1)!;
  const avoidableKwh = Math.max(0, latest.energyKwh - baselineKwhPerUnit * latest.output);
  const severity: EnergyInsightRecord["severity"] = deviationPercent >= 20 ? "critical" : deviationPercent >= 8 ? "warning" : "normal";
  const recommendations: string[] = [];
  if ((latest.idleMinutes ?? 0) >= 10) recommendations.push("空转时间偏高，核对待机策略、换型等待和上下游阻塞");
  if (deviationPercent >= 8) recommendations.push("单位产量能耗偏离基线，按设备、班次和工况下钻定位贡献项");
  if (severity === "critical") recommendations.push("在执行启停或负荷调整前先做规则校验和生产约束确认");
  if (!recommendations.length) recommendations.push("当前单位产量能耗位于历史基线范围，继续观察峰值需量和空转占比");
  return {
    id: randomUUID(), projectId, createdAt: now, samples: usable.length,
    baselineKwhPerUnit: round(baselineKwhPerUnit, 6), currentKwhPerUnit: round(currentKwhPerUnit, 6),
    deviationPercent: round(deviationPercent, 2), avoidableKwh: round(avoidableKwh, 3), severity, recommendations,
    evidenceFingerprint: evidenceFingerprint(usable)
  };
}

export function evidenceFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function maintenanceRiskLevel(score: number, model: MaintenanceModelPackage): MaintenanceAssessmentRecord["riskLevel"] {
  const { warningThreshold, criticalThreshold, scoreDirection } = model.gates;
  if (scoreDirection === "low-risk") {
    if (score <= criticalThreshold) return "critical";
    if (score <= warningThreshold) return "warning";
    return "normal";
  }
  if (score >= criticalThreshold) return "critical";
  if (score >= warningThreshold) return "warning";
  return "normal";
}

function riskLabel(level: MaintenanceAssessmentRecord["riskLevel"]): string {
  return level === "critical" ? "高风险" : level === "warning" ? "关注" : level === "normal" ? "正常" : "未知";
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, value))));
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.round(clamp(value, minimum, maximum));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
