import type {
  PlantLiteDistribution,
  PlantLiteFailureProfile,
  PlantLiteModel,
  PlantLiteStudyRecord,
} from "@bim-studio/contracts";
import {
  createPlantLiteSingleVariableSweep,
  type PlantLiteSingleVariableSweep,
} from "./plantLiteBottleneckSweep";

export const PLANT_LITE_RELIABILITY_GROUP_PREFIX = "reliability-strategy:";
export const PLANT_LITE_MTBF_IMPROVEMENT_FACTOR = 1.25;
export const PLANT_LITE_MTTR_REDUCTION_FACTOR = 0.75;

export interface PlantLiteReliabilityOption {
  resourceId: string;
  resourceName: string;
  boundNodeNames: string[];
  mtbfMinutes: number;
  mttrMinutes: number;
}

export interface PlantLiteReliabilityCandidate {
  kind: "increase-mtbf" | "reduce-mttr";
  label: string;
  mtbfMinutes: number;
  mttrMinutes: number;
  failure: PlantLiteFailureProfile;
}

export interface PlantLiteReliabilityStrategySweep extends PlantLiteSingleVariableSweep {
  resourceId: string;
  baseline: PlantLiteReliabilityOption;
  candidates: PlantLiteReliabilityCandidate[];
}

/**
 * 只列出已由工位或搬运节点绑定、且显式配置故障与修复分布的资源。
 * 未绑定资源和缺少 MTBF/MTTR 的资源都不补默认值。
 */
export function listPlantLiteReliabilityOptions(study: PlantLiteStudyRecord): PlantLiteReliabilityOption[] {
  const model = study.model;
  if (!model) return [];
  return (model.resources ?? []).flatMap((resource) => {
    if (!resource.failure) return [];
    const boundNodeNames = model.nodes.flatMap((node) => (node.kind === "station" || node.kind === "transport") && node.resourceId === resource.id
      ? [node.name]
      : []);
    if (!boundNodeNames.length) return [];
    const mtbfMinutes = plantLiteDistributionMean(resource.failure.timeToFailure);
    const mttrMinutes = plantLiteDistributionMean(resource.failure.repairTime);
    if (mtbfMinutes === undefined || mttrMinutes === undefined) return [];
    return [{ resourceId: resource.id, resourceName: resource.name, boundNodeNames, mtbfMinutes, mttrMinutes }];
  });
}

/** 生成两个明确的敏感性候选，不把目标改善幅度冒充预测结果或自动优化。 */
export function createPlantLiteReliabilityCandidates(
  failure: PlantLiteFailureProfile,
): PlantLiteReliabilityCandidate[] {
  const mtbfMinutes = plantLiteDistributionMean(failure.timeToFailure);
  const mttrMinutes = plantLiteDistributionMean(failure.repairTime);
  if (mtbfMinutes === undefined || mttrMinutes === undefined) return [];
  const improvedMtbf = scalePlantLiteDistribution(failure.timeToFailure, PLANT_LITE_MTBF_IMPROVEMENT_FACTOR);
  const reducedMttr = scalePlantLiteDistribution(failure.repairTime, PLANT_LITE_MTTR_REDUCTION_FACTOR);
  return [
    {
      kind: "increase-mtbf",
      label: `提高 MTBF 25%（${formatMinutes(mtbfMinutes)} → ${formatMinutes(mtbfMinutes * PLANT_LITE_MTBF_IMPROVEMENT_FACTOR)} 分）`,
      mtbfMinutes: mtbfMinutes * PLANT_LITE_MTBF_IMPROVEMENT_FACTOR,
      mttrMinutes,
      failure: { timeToFailure: improvedMtbf, repairTime: structuredClone(failure.repairTime) },
    },
    {
      kind: "reduce-mttr",
      label: `缩短 MTTR 25%（${formatMinutes(mttrMinutes)} → ${formatMinutes(mttrMinutes * PLANT_LITE_MTTR_REDUCTION_FACTOR)} 分）`,
      mtbfMinutes,
      mttrMinutes: mttrMinutes * PLANT_LITE_MTTR_REDUCTION_FACTOR,
      failure: { timeToFailure: structuredClone(failure.timeToFailure), repairTime: reducedMttr },
    },
  ];
}

export function createPlantLiteReliabilityStrategySweep(
  study: PlantLiteStudyRecord,
  resourceId: string,
): PlantLiteReliabilityStrategySweep | undefined {
  if (study.outcome.status !== "completed" || study.outcome.completedReplications !== study.replications) return undefined;
  const baseline = listPlantLiteReliabilityOptions(study).find((option) => option.resourceId === resourceId);
  const model = study.model;
  const resource = model?.resources?.find((candidate) => candidate.id === resourceId);
  if (!baseline || !model || !resource?.failure) return undefined;
  const candidates = createPlantLiteReliabilityCandidates(resource.failure);
  if (candidates.length !== 2) return undefined;

  const sweep = createPlantLiteSingleVariableSweep({
    study,
    subjectName: resource.name,
    parameterLabel: `${resource.name} · MTBF / MTTR`,
    groupId: `${PLANT_LITE_RELIABILITY_GROUP_PREFIX}${study.id}:${encodeURIComponent(resource.id)}`,
    values: candidates.map((_, index) => index),
    update: (index) => updateResourceFailure(model, resource.id, candidates[index]?.failure),
    label: (index) => candidates[index]?.label ?? `候选 ${index + 1}`,
  });
  return { ...sweep, resourceId: resource.id, baseline, candidates };
}

export function plantLiteDistributionMean(distribution: PlantLiteDistribution): number | undefined {
  const value = distribution.kind === "deterministic" ? distribution.value
    : distribution.kind === "uniform" ? (distribution.minimum + distribution.maximum) / 2
      : distribution.mean;
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export function scalePlantLiteDistribution(
  distribution: PlantLiteDistribution,
  factor: number,
): PlantLiteDistribution {
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError("分布缩放系数必须是正有限数");
  if (distribution.kind === "deterministic") return { ...distribution, value: distribution.value * factor };
  if (distribution.kind === "uniform") return {
    ...distribution,
    minimum: distribution.minimum * factor,
    maximum: distribution.maximum * factor,
  };
  if (distribution.kind === "normal") return {
    ...distribution,
    mean: distribution.mean * factor,
    standardDeviation: distribution.standardDeviation * factor,
    ...(distribution.minimum === undefined ? {} : { minimum: distribution.minimum * factor }),
  };
  return { ...distribution, mean: distribution.mean * factor };
}

function updateResourceFailure(
  model: PlantLiteModel,
  resourceId: string,
  failure: PlantLiteFailureProfile | undefined,
): PlantLiteModel {
  const next = structuredClone(model);
  if (!failure || !next.resources) return next;
  next.resources = next.resources.map((resource) => resource.id === resourceId
    ? { ...resource, failure: structuredClone(failure) }
    : resource);
  return next;
}

function formatMinutes(value: number): string {
  return Number(value.toFixed(2)).toString();
}
