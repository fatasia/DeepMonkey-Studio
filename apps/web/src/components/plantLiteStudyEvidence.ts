import type {
  PlantLiteConfidenceInterval,
  PlantLiteStudyRecord,
} from "@bim-studio/contracts";

/**
 * 只有输入、执行环境和全部统计证据都一致时，才把一次运行标记为精确复现。
 * 时间戳和记录 ID 属于运行元数据，不参与确定性结果比较。
 */
export function isExactPlantLiteReproduction(
  candidate: PlantLiteStudyRecord,
  baseline: PlantLiteStudyRecord | undefined,
): boolean {
  if (!baseline || candidate.reproductionOf !== baseline.id) return false;
  return candidate.inputFingerprint === baseline.inputFingerprint
    && sameExecution(candidate.execution, baseline.execution)
    && sameOutcome(candidate.outcome, baseline.outcome);
}

function sameExecution(
  left: PlantLiteStudyRecord["execution"],
  right: PlantLiteStudyRecord["execution"],
): boolean {
  return left.engineId === right.engineId
    && left.engineVersion === right.engineVersion
    && left.inputFingerprint === right.inputFingerprint
    && left.deterministic === right.deterministic
    && left.limits.durationMinutes === right.limits.durationMinutes
    && left.limits.maxEvents === right.limits.maxEvents
    && left.limits.maxResources === right.limits.maxResources;
}

function sameOutcome(
  left: PlantLiteStudyRecord["outcome"],
  right: PlantLiteStudyRecord["outcome"],
): boolean {
  return left.status === right.status
    && left.completedReplications === right.completedReplications
    && sameInterval(left.throughputPerHour, right.throughputPerHour)
    && sameInterval(left.averageWip, right.averageWip)
    && sameInterval(left.averageLeadTimeMinutes, right.averageLeadTimeMinutes)
    && sameIntervalMap(left.resourceUtilization95, right.resourceUtilization95)
    && JSON.stringify(left.bottlenecks) === JSON.stringify(right.bottlenecks);
}

function sameIntervalMap(
  left: Record<string, PlantLiteConfidenceInterval>,
  right: Record<string, PlantLiteConfidenceInterval>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return JSON.stringify(leftKeys) === JSON.stringify(rightKeys)
    && leftKeys.every((key) => !!left[key] && !!right[key] && sameInterval(left[key], right[key]));
}

function sameInterval(left: PlantLiteConfidenceInterval, right: PlantLiteConfidenceInterval): boolean {
  return left.mean === right.mean
    && left.sampleStandardDeviation === right.sampleStandardDeviation
    && left.lower95 === right.lower95
    && left.upper95 === right.upper95
    && left.samples === right.samples;
}
