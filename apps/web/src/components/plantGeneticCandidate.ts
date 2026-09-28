import type { PlantLiteModel, PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";
import { validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";

export interface PlantGeneticCandidate {
  stationId: string;
  minimumMinutes: number;
  maximumMinutes: number;
  baseMinutes: number;
}

/** Screening only: the final candidate always runs through the authoritative DES Study API. */
export function plantGeneticCandidate(study: PlantLiteStudyRecord): PlantGeneticCandidate | undefined {
  if (study.outcome.status !== "completed" || !study.model || study.outcome.completedReplications < 2) return undefined;
  if (study.model.nodes.length > 80 || study.execution.limits.maxResources > 100 || study.model.id.endsWith("-review-only")) return undefined;
  const station = study.model.nodes.find((node) => node.kind === "station" && node.processingTime.kind === "deterministic" && node.processingTime.value > 0.01);
  if (!station || station.kind !== "station" || station.processingTime.kind !== "deterministic") return undefined;
  const baseMinutes = station.processingTime.value;
  return { stationId: station.id, baseMinutes, minimumMinutes: baseMinutes * 0.8, maximumMinutes: baseMinutes * 1.2 };
}

export function plantGeneticModel(baseModel: PlantLiteModel, stationId: string, minutes: number): PlantLiteModel {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("候选工时必须是正数分钟。");
  const model = structuredClone(baseModel);
  const station = model.nodes.find((node) => node.id === stationId);
  if (!station || station.kind !== "station" || station.processingTime.kind !== "deterministic") throw new Error("工位已变化，请重新选择基线。");
  station.processingTime = { kind: "deterministic", value: minutes };
  if (!validatePlantLiteModel(model).valid) throw new Error("候选模型校验未通过，不会提交正式 Study。");
  return model;
}

export function plantGeneticStudyRequest(study: PlantLiteStudyRecord, stationId: string, minutes: number, fingerprint: string): PlantLiteStudyRequest {
  const candidate = plantGeneticCandidate(study);
  if (!study.model || !candidate || candidate.stationId !== stationId || minutes < candidate.minimumMinutes - 1e-6 || minutes > candidate.maximumMinutes + 1e-6 || fingerprint.length > 100 || !/^[a-zA-Z0-9:_-]+$/.test(fingerprint)) throw new Error("基线、工时范围或候选指纹无效，无法提交正式 Study。");
  return {
    name: `${study.name.slice(0, 35)} · GA候选`, templateId: study.templateId,
    model: plantGeneticModel(study.model, stationId, minutes), seed: study.seed,
    replications: study.replications, limits: { ...study.execution.limits },
    ...(study.execution.trace ? { trace: { ...study.execution.trace } } : {}),
    ...(study.acceptanceTargets ? { acceptanceTargets: { ...study.acceptanceTargets } } : {}),
    comparison: { groupId: `ga:${study.id}`.slice(0, 160), baselineStudyId: study.id,
      parameterLabel: "工位确定性工时（分钟）", candidateLabel: `GA筛查 ${minutes.toFixed(3)} 分 · ${fingerprint.slice(0, 18)}` },
  };
}
