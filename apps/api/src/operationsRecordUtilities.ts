import type {
  IndustrialValidationStudyRecord,
  LogisticsExperimentRequest,
  LogisticsExperimentResult,
  PlantLiteStudyRecord,
} from "@bim-studio/contracts";

export function compactRecords<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T => item !== null && item !== undefined)
    : [];
}

export function isPlantLiteStudyRecord(
  value: PlantLiteStudyRecord | null | undefined,
): value is PlantLiteStudyRecord {
  return plantLiteStudyRecordIssue(value) === undefined;
}

export function plantLiteStudyRecordIssue(
  value: PlantLiteStudyRecord | null | undefined,
): string | undefined {
  if (!value || typeof value !== "object") return "Worker 未返回记录对象";
  if (typeof value.id !== "string" || !value.id) return "记录 ID 缺失";
  if (typeof value.projectId !== "string" || !value.projectId)
    return "项目 ID 缺失";
  if (typeof value.inputFingerprint !== "string" || !value.inputFingerprint)
    return "输入指纹缺失";
  if (!value.execution || typeof value.execution !== "object")
    return "执行证据缺失";
  if (!value.outcome || typeof value.outcome !== "object")
    return "结果证据缺失";
  return undefined;
}

export function requiredText(value: string | undefined, label: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

export function finiteInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(Number(value))) : fallback;
}

export function compactError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300) || "未知错误";
}

export function logisticsRequestFromResult(
  result: LogisticsExperimentResult,
): LogisticsExperimentRequest {
  return {
    name: result.name,
    agvCount: result.agvCount,
    bufferCapacity: result.bufferCapacity,
    demandPerHour: result.demandPerHour,
    cycleTimeSec: result.cycleTimeSec,
    chargingMinutesPerHour: result.chargingMinutesPerHour,
    congestionFactor: result.congestionFactor,
    durationHours: result.durationHours,
  };
}

export function inferredValidationStudyType(
  sourceKind: IndustrialValidationStudyRecord["sourceKind"] | undefined,
) {
  return sourceKind === "workcell-audit"
    ? "workcell-audit"
    : "virtual-commissioning";
}
