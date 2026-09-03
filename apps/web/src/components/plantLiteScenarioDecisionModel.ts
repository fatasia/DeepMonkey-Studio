import type {
  PlantLiteAcceptanceTargets,
  PlantLiteConfidenceInterval,
  PlantLiteStudyRecord,
} from "@bim-studio/contracts";
import { assessPlantLiteAcceptance, type PlantLiteAcceptanceStatus } from "./plantLiteAcceptanceAssessment";

export type PlantLiteIntervalAssessment = "baseline" | "improved" | "worsened" | "overlap" | "unavailable";
export type PlantLiteDecisionAcceptanceStatus = PlantLiteAcceptanceStatus | "not-set" | "inconsistent-targets";

export interface PlantLiteDecisionMetric {
  value: number;
  interval?: PlantLiteConfidenceInterval;
  evidence: "complete" | "partial";
}

export interface PlantLiteDecisionUtilization extends PlantLiteDecisionMetric {
  resourceId: string;
  resourceName: string;
}

export interface PlantLiteDecisionFailureLoss extends PlantLiteDecisionMetric {
  resourceIds: string[];
}

export interface PlantLiteDecisionRow {
  study: PlantLiteStudyRecord;
  label: string;
  baseline: boolean;
  comparable: boolean;
  comparabilityReason: string;
  throughputDeltaPercent?: number;
  intervalAssessment: PlantLiteIntervalAssessment;
  peakUtilization?: PlantLiteDecisionUtilization;
  failureLoss?: PlantLiteDecisionFailureLoss;
  energyPerItemKwh?: PlantLiteDecisionMetric;
  costPerItem?: PlantLiteDecisionMetric;
  carbonPerItemKg?: PlantLiteDecisionMetric;
  acceptanceStatus: PlantLiteDecisionAcceptanceStatus;
  paretoFrontier: boolean;
  highestThroughput: boolean;
  shortestLeadTime: boolean;
  lowestCost: boolean;
}

export interface PlantLiteScenarioDecision {
  groupId: string;
  parameterLabel: string;
  baselineStudy: PlantLiteStudyRecord;
  objectiveLabels: string[];
  evidenceWindow: string;
  notes: string[];
  rows: PlantLiteDecisionRow[];
}

export interface PlantLiteComparability {
  comparable: boolean;
  reason: string;
}

type ParetoObjective = "throughput" | "lead-time" | "wip" | "failure-loss" | "energy" | "cost" | "carbon";

/**
 * 只比较 API 已保存为同一实验组的真实运行。均值 Pareto 前沿用于暴露取舍，
 * 不使用业务权重，也不冒充自动优化或统计显著性结论。
 */
export function derivePlantLiteScenarioDecision(results: PlantLiteStudyRecord[]): PlantLiteScenarioDecision | undefined {
  const latest = results.find((study) => study.comparison
    && results.some((candidate) => candidate.id === study.comparison?.baselineStudyId));
  const comparison = latest?.comparison;
  if (!latest || !comparison) return undefined;
  const baseline = results.find((study) => study.id === comparison.baselineStudyId);
  if (!baseline) return undefined;

  const candidates = deduplicateCandidates(results.filter((study) => study.id !== baseline.id
    && study.comparison?.groupId === comparison.groupId
    && study.comparison.baselineStudyId === comparison.baselineStudyId));
  if (!candidates.length) return undefined;
  const studies = [baseline, ...candidates];
  const comparableStudies = studies.filter((study) => assessPlantLiteComparability(study, baseline).comparable);
  const objectives: ParetoObjective[] = ["throughput", "lead-time", "wip"];
  const notes: string[] = [];

  const failureReady = comparableStudies.length === studies.length
    && comparableStudies.every(hasCompleteFailureEvidence)
    && haveSameFailureScope(comparableStudies);
  if (failureReady) objectives.push("failure-loss");
  else if (studies.some((study) => Object.keys(study.outcome.resourceFailedMinutes95 ?? {}).length > 0)) {
    notes.push("可靠性未进入前沿：部分方案缺少同资源口径的完整故障容量损失。");
  }

  const energyReady = comparableStudies.length === studies.length && comparableStudies.every(hasCompleteUnitEnergyEvidence);
  if (energyReady) objectives.push("energy");
  else if (studies.some((study) => study.outcome.energy)) {
    notes.push("单位能耗未进入前沿：至少一个方案的单位能源样本不完整。");
  } else {
    notes.push("未建模设备功率，能源、成本与碳排不参与本组前沿。");
  }

  const costReady = energyReady && haveComparableEconomicAssumption(comparableStudies, "electricityPricePerKwh");
  const carbonReady = energyReady && haveComparableEconomicAssumption(comparableStudies, "carbonEmissionFactorKgPerKwh");
  if (costReady) objectives.push("cost");
  else if (energyReady) notes.push("单位电费未进入前沿：电价或其来源口径不一致 / 不可追溯。");
  if (carbonReady) objectives.push("carbon");
  else if (energyReady) notes.push("单位碳排未进入前沿：排放因子或其来源口径不一致 / 不可追溯。");

  const comparableTargetStatus = acceptanceTargetStatus(studies, baseline);
  if (comparableTargetStatus === "not-set") notes.push("未设置统一验收门槛；当前只展示相对方案证据。");
  if (comparableTargetStatus === "inconsistent-targets") notes.push("各方案验收门槛不一致，已停止横向达标比较。");
  const excluded = studies.length - comparableStudies.length;
  if (excluded > 0) notes.push(`${excluded} 个方案的执行条件或统计证据不一致，已排除在前沿之外。`);

  const frontierIds = comparableStudies.length > 1
    ? selectParetoStudyIds(comparableStudies, objectives)
    : new Set<string>();
  const highestThroughput = bestStudy(comparableStudies, (study) => study.outcome.throughputPerHour.mean, "max");
  const shortestLeadTime = bestStudy(comparableStudies, (study) => study.outcome.averageLeadTimeMinutes.mean, "min");
  const lowestCost = costReady
    ? bestStudy(comparableStudies, (study) => study.outcome.energy!.electricityCostPerCompletedItem.mean, "min")
    : undefined;

  return {
    groupId: comparison.groupId,
    parameterLabel: comparison.parameterLabel,
    baselineStudy: baseline,
    objectiveLabels: objectives.map(objectiveLabel),
    evidenceWindow: formatEvidenceWindow(baseline),
    notes,
    rows: studies.map((study, index) => decisionRow(
      study,
      baseline,
      index === 0,
      comparableTargetStatus,
      frontierIds,
      highestThroughput?.id,
      shortestLeadTime?.id,
      lowestCost?.id,
    )),
  };
}

function decisionRow(
  study: PlantLiteStudyRecord,
  baseline: PlantLiteStudyRecord,
  isBaseline: boolean,
  targetStatus: "comparable" | "not-set" | "inconsistent-targets",
  frontierIds: Set<string>,
  highestThroughputId: string | undefined,
  shortestLeadTimeId: string | undefined,
  lowestCostId: string | undefined,
): PlantLiteDecisionRow {
  const comparison = assessPlantLiteComparability(study, baseline);
  const baselineMean = baseline.outcome.throughputPerHour.mean;
  const energy = study.outcome.energy;
  const utilization = peakUtilization(study);
  const loss = failureLoss(study);
  return {
    study,
    label: isBaseline ? "当前基线" : study.comparison?.candidateLabel ?? study.name,
    baseline: isBaseline,
    comparable: comparison.comparable,
    comparabilityReason: comparison.reason,
    ...(comparison.comparable && baselineMean !== 0 ? {
      throughputDeltaPercent: (study.outcome.throughputPerHour.mean - baselineMean) / Math.abs(baselineMean) * 100,
    } : {}),
    intervalAssessment: comparison.comparable ? assessInterval(study, baseline, isBaseline) : "unavailable",
    ...(utilization ? { peakUtilization: utilization } : {}),
    ...(loss ? { failureLoss: loss } : {}),
    ...(energy ? {
      energyPerItemKwh: metric(energy.energyPerCompletedItemKwh, study),
      costPerItem: metric(energy.electricityCostPerCompletedItem, study),
      carbonPerItemKg: metric(energy.carbonEmissionPerCompletedItemKg, study),
    } : {}),
    acceptanceStatus: rowAcceptanceStatus(study, targetStatus),
    paretoFrontier: comparison.comparable && frontierIds.has(study.id),
    highestThroughput: comparison.comparable && study.id === highestThroughputId,
    shortestLeadTime: comparison.comparable && study.id === shortestLeadTimeId,
    lowestCost: comparison.comparable && study.id === lowestCostId,
  };
}

/** 对相同执行条件的方案做动态目标均值非支配筛选。 */
function selectParetoStudyIds(studies: PlantLiteStudyRecord[], objectives: ParetoObjective[]): Set<string> {
  return new Set(studies
    .filter((candidate) => !studies.some((other) => other.id !== candidate.id && dominates(other, candidate, objectives)))
    .map((study) => study.id));
}

function dominates(left: PlantLiteStudyRecord, right: PlantLiteStudyRecord, objectives: ParetoObjective[]): boolean {
  const leftValues = objectives.map((objective) => objectiveValue(left, objective));
  const rightValues = objectives.map((objective) => objectiveValue(right, objective));
  if (leftValues.some((value) => value === undefined) || rightValues.some((value) => value === undefined)) return false;
  return leftValues.every((value, index) => value! <= rightValues[index]!)
    && leftValues.some((value, index) => value! < rightValues[index]!);
}

/** 全部目标转换为“越小越好”；吞吐取负数。 */
function objectiveValue(study: PlantLiteStudyRecord, objective: ParetoObjective): number | undefined {
  if (objective === "throughput") return -study.outcome.throughputPerHour.mean;
  if (objective === "lead-time") return study.outcome.averageLeadTimeMinutes.mean;
  if (objective === "wip") return study.outcome.averageWip.mean;
  if (objective === "failure-loss") return failureLoss(study)?.value;
  if (objective === "energy") return study.outcome.energy?.energyPerCompletedItemKwh.mean;
  if (objective === "cost") return study.outcome.energy?.electricityCostPerCompletedItem.mean;
  return study.outcome.energy?.carbonEmissionPerCompletedItemKg.mean;
}

function objectiveLabel(objective: ParetoObjective): string {
  return ({
    throughput: "吞吐↑", "lead-time": "交付周期↓", wip: "WIP↓", "failure-loss": "故障损失↓",
    energy: "单位能耗↓", cost: "单位成本↓", carbon: "单位碳排↓",
  })[objective];
}

function peakUtilization(study: PlantLiteStudyRecord): PlantLiteDecisionUtilization | undefined {
  const entry = Object.entries(study.outcome.resourceUtilization95)
    .sort((left, right) => right[1].mean - left[1].mean)[0];
  if (!entry) return undefined;
  const [resourceId, interval] = entry;
  const resourceName = study.model?.resources?.find((resource) => resource.id === resourceId)?.name ?? resourceId;
  return { resourceId, resourceName, value: interval.mean, interval, evidence: intervalComplete(interval, study) ? "complete" : "partial" };
}

function failureLoss(study: PlantLiteStudyRecord): PlantLiteDecisionFailureLoss | undefined {
  const entries = Object.entries(study.outcome.resourceFailedMinutes95 ?? {});
  if (!entries.length) return undefined;
  return {
    resourceIds: entries.map(([id]) => id).sort(),
    value: entries.reduce((sum, [, interval]) => sum + interval.mean, 0),
    evidence: entries.every(([, interval]) => intervalComplete(interval, study)) ? "complete" : "partial",
  };
}

function metric(interval: PlantLiteConfidenceInterval, study: PlantLiteStudyRecord): PlantLiteDecisionMetric {
  return { value: interval.mean, interval, evidence: intervalComplete(interval, study) ? "complete" : "partial" };
}

function hasCompleteFailureEvidence(study: PlantLiteStudyRecord): boolean {
  const loss = failureLoss(study);
  return !!loss && loss.evidence === "complete";
}

function haveSameFailureScope(studies: PlantLiteStudyRecord[]): boolean {
  const scopes = studies.map((study) => failureLoss(study)?.resourceIds.join("\u0000"));
  return scopes.every(Boolean) && new Set(scopes).size === 1;
}

function hasCompleteUnitEnergyEvidence(study: PlantLiteStudyRecord): boolean {
  const energy = study.outcome.energy;
  return !!energy
    && intervalComplete(energy.energyPerCompletedItemKwh, study)
    && intervalComplete(energy.electricityCostPerCompletedItem, study)
    && intervalComplete(energy.carbonEmissionPerCompletedItemKg, study);
}

function haveComparableEconomicAssumption(
  studies: PlantLiteStudyRecord[],
  key: "electricityPricePerKwh" | "carbonEmissionFactorKgPerKwh",
): boolean {
  const assumptions = studies.map((study) => study.model?.energyEconomics);
  if (assumptions.some((value) => !value || !Number.isFinite(value[key]))) return false;
  return new Set(assumptions.map((value) => `${value![key]}\u0000${value!.source ?? "estimate"}`)).size === 1;
}

function acceptanceTargetStatus(
  studies: PlantLiteStudyRecord[],
  baseline: PlantLiteStudyRecord,
): "comparable" | "not-set" | "inconsistent-targets" {
  if (!hasNumericTarget(baseline.acceptanceTargets)) return "not-set";
  const baselineKey = acceptanceTargetKey(baseline.acceptanceTargets);
  return studies.every((study) => acceptanceTargetKey(study.acceptanceTargets) === baselineKey)
    ? "comparable" : "inconsistent-targets";
}

function rowAcceptanceStatus(
  study: PlantLiteStudyRecord,
  targetStatus: "comparable" | "not-set" | "inconsistent-targets",
): PlantLiteDecisionAcceptanceStatus {
  if (targetStatus === "not-set") return "not-set";
  if (targetStatus === "inconsistent-targets") return "inconsistent-targets";
  return assessPlantLiteAcceptance(study)?.status ?? "not-set";
}

function hasNumericTarget(targets: PlantLiteAcceptanceTargets | undefined): boolean {
  return !!targets && Object.entries(targets).some(([key, value]) => key !== "basis" && typeof value === "number" && Number.isFinite(value));
}

function acceptanceTargetKey(targets: PlantLiteAcceptanceTargets | undefined): string {
  if (!targets) return "";
  const { basis: _basis, ...values } = targets;
  return JSON.stringify(Object.entries(values).filter(([, value]) => typeof value === "number" && Number.isFinite(value)).sort(([left], [right]) => left.localeCompare(right)));
}

function deduplicateCandidates(studies: PlantLiteStudyRecord[]): PlantLiteStudyRecord[] {
  const labels = new Set<string>();
  return studies
    .filter((study) => {
      const label = study.comparison?.candidateLabel ?? study.id;
      if (labels.has(label)) return false;
      labels.add(label);
      return true;
    })
    .sort((left, right) => (left.comparison?.candidateLabel ?? left.name).localeCompare(right.comparison?.candidateLabel ?? right.name, "zh-CN"));
}

export function assessPlantLiteComparability(candidate: PlantLiteStudyRecord, baseline: PlantLiteStudyRecord): PlantLiteComparability {
  if (baseline.outcome.status !== "completed") return { comparable: false, reason: "基线未完整运行，不能计算改善结论。" };
  if (candidate.outcome.status !== "completed") return { comparable: false, reason: "当前方案未完整运行，不能与基线比较。" };
  if (!hasCompleteCoreEvidence(baseline) || !hasCompleteCoreEvidence(candidate)) {
    return { comparable: false, reason: "核心指标样本数与有效重复次数不一致，请重新运行。" };
  }
  if (candidate.execution.engineId !== baseline.execution.engineId || candidate.execution.engineVersion !== baseline.execution.engineVersion) {
    return { comparable: false, reason: "求解引擎版本不同，请用同一版本重新运行。" };
  }
  if (candidate.seed !== baseline.seed) return { comparable: false, reason: "随机种子不同，不能把随机波动当作方案改善。" };
  if (candidate.replications !== baseline.replications || candidate.outcome.completedReplications !== baseline.outcome.completedReplications) {
    return { comparable: false, reason: "有效重复次数不同，请按相同实验规模运行。" };
  }
  const current = candidate.execution.limits;
  const reference = baseline.execution.limits;
  if (current.durationMinutes !== reference.durationMinutes || (current.warmupMinutes ?? 0) !== (reference.warmupMinutes ?? 0)
    || current.maxEvents !== reference.maxEvents || current.maxResources !== reference.maxResources) {
    return { comparable: false, reason: "运行时长、预热期或资源上限不同，数值结论已隐藏。" };
  }
  return { comparable: true, reason: "相同引擎、随机种子、统计窗口和重复次数，可直接比较。" };
}

function hasCompleteCoreEvidence(study: PlantLiteStudyRecord): boolean {
  return study.outcome.completedReplications === study.replications
    && intervalComplete(study.outcome.throughputPerHour, study)
    && intervalComplete(study.outcome.averageWip, study)
    && intervalComplete(study.outcome.averageLeadTimeMinutes, study);
}

function intervalComplete(interval: PlantLiteConfidenceInterval, study: PlantLiteStudyRecord): boolean {
  return interval.samples >= 2
    && interval.samples === study.outcome.completedReplications
    && [interval.mean, interval.lower95, interval.upper95].every(Number.isFinite);
}

function assessInterval(candidate: PlantLiteStudyRecord, baseline: PlantLiteStudyRecord, isBaseline: boolean): PlantLiteIntervalAssessment {
  if (isBaseline) return "baseline";
  const current = candidate.outcome.throughputPerHour;
  const reference = baseline.outcome.throughputPerHour;
  if (current.lower95 > reference.upper95) return "improved";
  if (current.upper95 < reference.lower95) return "worsened";
  return "overlap";
}

function bestStudy(
  studies: PlantLiteStudyRecord[],
  value: (study: PlantLiteStudyRecord) => number,
  direction: "min" | "max",
): PlantLiteStudyRecord | undefined {
  return studies.reduce<PlantLiteStudyRecord | undefined>((best, study) => {
    if (!best) return study;
    return direction === "max" ? value(study) > value(best) ? study : best : value(study) < value(best) ? study : best;
  }, undefined);
}

function formatEvidenceWindow(study: PlantLiteStudyRecord): string {
  const { durationMinutes, warmupMinutes = 0 } = study.execution.limits;
  return `${study.outcome.completedReplications} 次重复 · 总时长 ${durationMinutes} 分 · 预热 ${warmupMinutes} 分 · ${study.execution.engineVersion}`;
}
