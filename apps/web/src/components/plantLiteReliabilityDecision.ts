import type {
  PlantLiteConfidenceInterval,
  PlantLiteFailureProfile,
  PlantLiteModel,
  PlantLiteStudyRecord,
} from "@bim-studio/contracts";
import { assessPlantLiteComparability } from "./plantLiteScenarioDecisionModel";
import {
  listPlantLiteReliabilityOptions,
  plantLiteDistributionMean,
  PLANT_LITE_RELIABILITY_GROUP_PREFIX,
  type PlantLiteReliabilityOption,
} from "./plantLiteReliabilityStrategy";

export type PlantLiteReliabilityStrategyKind = "baseline" | "increase-mtbf" | "reduce-mttr";
export type PlantLiteReliabilityAssessment = "baseline" | "improved" | "worsened" | "overlap" | "unavailable";

export interface PlantLiteReliabilityDecisionRow {
  study: PlantLiteStudyRecord;
  label: string;
  kind: PlantLiteReliabilityStrategyKind;
  comparable: boolean;
  comparabilityReason: string;
  evidenceStatus: "complete" | "incomparable" | "missing-downtime";
  mtbfMinutes: number;
  mttrMinutes: number;
  failedMinutes?: PlantLiteConfidenceInterval;
  failedMinutesAssessment: PlantLiteReliabilityAssessment;
  throughputAssessment: PlantLiteReliabilityAssessment;
  energyPerItemKwh?: number;
  costPerItem?: number;
  recommended: boolean;
}

export interface PlantLiteReliabilityRecommendation {
  status: "single-leading" | "baseline-leading" | "tradeoff" | "unavailable";
  studyIds: string[];
  rationale: string;
}

export interface PlantLiteReliabilityDecision {
  groupId: string;
  resource: PlantLiteReliabilityOption;
  baselineStudy: PlantLiteStudyRecord;
  energyStatus: "ready" | "not-modeled" | "incomplete";
  rows: PlantLiteReliabilityDecisionRow[];
  recommendation: PlantLiteReliabilityRecommendation;
}

/**
 * 从同一可靠性实验组生成停机、物流与能源的可比证据。
 * 推荐仅做无权重的均值 Pareto 筛选，不代替维护投入与风险评审。
 */
export function derivePlantLiteReliabilityDecision(
  results: PlantLiteStudyRecord[],
): PlantLiteReliabilityDecision | undefined {
  const latest = results[0];
  const comparison = latest?.comparison;
  if (!latest || !comparison?.groupId.startsWith(PLANT_LITE_RELIABILITY_GROUP_PREFIX)) return undefined;
  const baseline = results.find((study) => study.id === comparison.baselineStudyId);
  if (!baseline?.model) return undefined;
  const candidates = deduplicateCandidates(results.filter((study) => study.comparison?.groupId === comparison.groupId));
  if (!candidates.length) return undefined;
  const resource = resolveReliabilityResource(baseline, candidates, comparison.groupId);
  if (!resource) return undefined;

  const orderedCandidates = candidates.sort((left, right) => strategyOrder(
    candidateStrategyKind(baseline.model!, left.model, resource.resourceId),
  ) - strategyOrder(candidateStrategyKind(baseline.model!, right.model, resource.resourceId)));
  const rows = [baseline, ...orderedCandidates].map((study, index) => createDecisionRow(
    study,
    baseline,
    resource,
    index === 0,
  ));
  const energyStatus = reliabilityEnergyStatus(rows);
  const recommendation = deriveRecommendation(rows, energyStatus);
  const recommendedIds = new Set(recommendation.studyIds);
  return {
    groupId: comparison.groupId,
    resource,
    baselineStudy: baseline,
    energyStatus,
    rows: rows.map((row) => ({ ...row, recommended: recommendedIds.has(row.study.id) })),
    recommendation,
  };
}

function createDecisionRow(
  study: PlantLiteStudyRecord,
  baseline: PlantLiteStudyRecord,
  option: PlantLiteReliabilityOption,
  isBaseline: boolean,
): PlantLiteReliabilityDecisionRow {
  const conditionCheck = assessPlantLiteComparability(study, baseline);
  const kind = isBaseline ? "baseline" : candidateStrategyKind(baseline.model!, study.model, option.resourceId);
  const modelScopeValid = isBaseline || (kind !== undefined && sameModelOutsideFailure(baseline.model!, study.model, option.resourceId));
  const comparable = conditionCheck.comparable && modelScopeValid && kind !== undefined;
  const comparabilityReason = !conditionCheck.comparable ? conditionCheck.reason
    : !modelScopeValid ? "候选修改了目标 MTBF/MTTR 之外的模型输入，不能归因于维护策略。"
      : "相同引擎、seed、统计窗口与重复次数，且仅修改一个可靠性参数。";
  const failure = findFailure(study.model, option.resourceId);
  const mtbfMinutes = failure ? plantLiteDistributionMean(failure.timeToFailure) : undefined;
  const mttrMinutes = failure ? plantLiteDistributionMean(failure.repairTime) : undefined;
  const failedMinutes = comparable ? study.outcome.resourceFailedMinutes95?.[option.resourceId] : undefined;
  const downtimeComplete = !!failedMinutes && failedMinutes.samples === study.outcome.completedReplications;
  const energy = comparable && completeEnergy(study) ? study.outcome.energy : undefined;
  return {
    study,
    label: isBaseline ? "当前基线" : study.comparison?.candidateLabel ?? study.name,
    kind: kind ?? "baseline",
    comparable,
    comparabilityReason,
    evidenceStatus: !comparable ? "incomparable" : downtimeComplete ? "complete" : "missing-downtime",
    mtbfMinutes: mtbfMinutes ?? option.mtbfMinutes,
    mttrMinutes: mttrMinutes ?? option.mttrMinutes,
    ...(failedMinutes ? { failedMinutes } : {}),
    failedMinutesAssessment: comparable && downtimeComplete
      ? assessInterval(failedMinutes, baseline.outcome.resourceFailedMinutes95?.[option.resourceId], true, isBaseline)
      : "unavailable",
    throughputAssessment: comparable
      ? assessInterval(study.outcome.throughputPerHour, baseline.outcome.throughputPerHour, false, isBaseline)
      : "unavailable",
    ...(energy ? {
      energyPerItemKwh: energy.energyPerCompletedItemKwh.mean,
      costPerItem: energy.electricityCostPerCompletedItem.mean,
    } : {}),
    recommended: false,
  };
}

function resolveReliabilityResource(
  baseline: PlantLiteStudyRecord,
  candidates: PlantLiteStudyRecord[],
  groupId: string,
): PlantLiteReliabilityOption | undefined {
  const options = listPlantLiteReliabilityOptions(baseline);
  const encodedId = groupId.startsWith(`${PLANT_LITE_RELIABILITY_GROUP_PREFIX}${baseline.id}:`)
    ? groupId.slice(`${PLANT_LITE_RELIABILITY_GROUP_PREFIX}${baseline.id}:`.length)
    : "";
  const parsedId = safeDecode(encodedId);
  const parsed = options.find((option) => option.resourceId === parsedId);
  if (parsed && candidates.every((study) => isReliabilityCandidate(baseline.model!, study.model, parsed.resourceId))) return parsed;
  const inferred = options.filter((option) => candidates.every((study) => isReliabilityCandidate(
    baseline.model!,
    study.model,
    option.resourceId,
  )));
  return inferred.length === 1 ? inferred[0] : undefined;
}

function isReliabilityCandidate(
  baseline: PlantLiteModel,
  candidate: PlantLiteModel | undefined,
  resourceId: string,
): boolean {
  return sameModelOutsideFailure(baseline, candidate, resourceId)
    && candidateStrategyKind(baseline, candidate, resourceId) !== undefined;
}

function candidateStrategyKind(
  baseline: PlantLiteModel,
  candidate: PlantLiteModel | undefined,
  resourceId: string,
): Exclude<PlantLiteReliabilityStrategyKind, "baseline"> | undefined {
  const reference = findFailure(baseline, resourceId);
  const current = findFailure(candidate, resourceId);
  if (!reference || !current) return undefined;
  const sameMtbf = JSON.stringify(reference.timeToFailure) === JSON.stringify(current.timeToFailure);
  const sameMttr = JSON.stringify(reference.repairTime) === JSON.stringify(current.repairTime);
  const referenceMtbf = plantLiteDistributionMean(reference.timeToFailure);
  const currentMtbf = plantLiteDistributionMean(current.timeToFailure);
  const referenceMttr = plantLiteDistributionMean(reference.repairTime);
  const currentMttr = plantLiteDistributionMean(current.repairTime);
  if (!sameMtbf && sameMttr && referenceMtbf !== undefined && currentMtbf !== undefined && currentMtbf > referenceMtbf) return "increase-mtbf";
  if (sameMtbf && !sameMttr && referenceMttr !== undefined && currentMttr !== undefined && currentMttr < referenceMttr) return "reduce-mttr";
  return undefined;
}

function sameModelOutsideFailure(
  baseline: PlantLiteModel,
  candidate: PlantLiteModel | undefined,
  resourceId: string,
): boolean {
  const referenceFailure = findFailure(baseline, resourceId);
  if (!candidate || !referenceFailure || !findFailure(candidate, resourceId)) return false;
  const normalized = structuredClone(candidate);
  const resource = normalized.resources?.find((entry) => entry.id === resourceId);
  if (!resource) return false;
  resource.failure = structuredClone(referenceFailure);
  return JSON.stringify(normalized) === JSON.stringify(baseline);
}

function findFailure(model: PlantLiteModel | undefined, resourceId: string): PlantLiteFailureProfile | undefined {
  return model?.resources?.find((resource) => resource.id === resourceId)?.failure;
}

function reliabilityEnergyStatus(rows: PlantLiteReliabilityDecisionRow[]): PlantLiteReliabilityDecision["energyStatus"] {
  if (rows.every((row) => !row.study.outcome.energy)) return "not-modeled";
  return rows.every((row) => completeEnergy(row.study)) ? "ready" : "incomplete";
}

function completeEnergy(study: PlantLiteStudyRecord): boolean {
  const energy = study.outcome.energy;
  return !!energy
    && energy.energyPerCompletedItemKwh.samples === study.outcome.completedReplications
    && energy.electricityCostPerCompletedItem.samples === study.outcome.completedReplications;
}

function deriveRecommendation(
  rows: PlantLiteReliabilityDecisionRow[],
  energyStatus: PlantLiteReliabilityDecision["energyStatus"],
): PlantLiteReliabilityRecommendation {
  const kinds = new Set(rows.map((row) => row.kind));
  const complete = rows.length === 3
    && kinds.has("baseline")
    && kinds.has("increase-mtbf")
    && kinds.has("reduce-mttr")
    && rows.every((row) => row.evidenceStatus === "complete")
    && energyStatus !== "incomplete";
  if (!complete) return {
    status: "unavailable",
    studyIds: [],
    rationale: "需完成基线、提高 MTBF、缩短 MTTR 三个同条件运行，并具备完整故障损失证据后再推荐。",
  };

  const useEnergy = energyStatus === "ready";
  const frontier = rows.filter((candidate) => !rows.some((other) => other.study.id !== candidate.study.id
    && dominates(other, candidate, useEnergy)));
  const objectives = `吞吐↑、故障产能损失↓、WIP↓、交付期↓${useEnergy ? "、单位能耗与电费↓" : ""}`;
  if (frontier.length === 1) {
    const winner = frontier[0]!;
    const baselineLeading = winner.kind === "baseline";
    return {
      status: baselineLeading ? "baseline-leading" : "single-leading",
      studyIds: [winner.study.id],
      rationale: `${winner.label}在${objectives}的均值非支配筛选中领先；建议优先验证，但未计入维护投入、备件与人工成本。`,
    };
  }
  return {
    status: "tradeoff",
    studyIds: frontier.map((row) => row.study.id),
    rationale: `${frontier.map((row) => row.label).join("、")}构成非支配候选（${objectives}）；缺少维护投入权重，不能宣称唯一最优。`,
  };
}

function dominates(
  left: PlantLiteReliabilityDecisionRow,
  right: PlantLiteReliabilityDecisionRow,
  useEnergy: boolean,
): boolean {
  const leftValues = objectives(left, useEnergy);
  const rightValues = objectives(right, useEnergy);
  if (!leftValues || !rightValues) return false;
  return leftValues.every((value, index) => value <= rightValues[index]!)
    && leftValues.some((value, index) => value < rightValues[index]!);
}

/** 最小化向量；吞吐取负数，因此仍按越小越好处理。 */
function objectives(row: PlantLiteReliabilityDecisionRow, useEnergy: boolean): number[] | undefined {
  const downtime = row.failedMinutes?.mean;
  if (downtime === undefined) return undefined;
  const values = [
    -row.study.outcome.throughputPerHour.mean,
    downtime,
    row.study.outcome.averageWip.mean,
    row.study.outcome.averageLeadTimeMinutes.mean,
  ];
  if (!useEnergy) return values;
  if (row.energyPerItemKwh === undefined || row.costPerItem === undefined) return undefined;
  return [...values, row.energyPerItemKwh, row.costPerItem];
}

function assessInterval(
  candidate: PlantLiteConfidenceInterval,
  baseline: PlantLiteConfidenceInterval | undefined,
  lowerIsBetter: boolean,
  isBaseline: boolean,
): PlantLiteReliabilityAssessment {
  if (isBaseline) return "baseline";
  if (!baseline) return "unavailable";
  if (lowerIsBetter) {
    if (candidate.upper95 < baseline.lower95) return "improved";
    if (candidate.lower95 > baseline.upper95) return "worsened";
  } else {
    if (candidate.lower95 > baseline.upper95) return "improved";
    if (candidate.upper95 < baseline.lower95) return "worsened";
  }
  return "overlap";
}

function deduplicateCandidates(studies: PlantLiteStudyRecord[]): PlantLiteStudyRecord[] {
  const labels = new Set<string>();
  return studies.filter((study) => {
    const label = study.comparison?.candidateLabel ?? study.id;
    if (labels.has(label)) return false;
    labels.add(label);
    return true;
  });
}

function strategyOrder(kind: PlantLiteReliabilityStrategyKind | undefined): number {
  if (kind === "increase-mtbf") return 0;
  if (kind === "reduce-mttr") return 1;
  return 2;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
