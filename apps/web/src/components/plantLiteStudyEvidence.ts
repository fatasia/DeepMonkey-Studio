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
    && candidate.modelFingerprint === baseline.modelFingerprint
    && JSON.stringify(candidate.model ?? null) === JSON.stringify(baseline.model ?? null)
    && JSON.stringify(candidate.acceptanceTargets ?? null) === JSON.stringify(baseline.acceptanceTargets ?? null)
    && sameExecution(candidate.execution, baseline.execution)
    && JSON.stringify(candidate.trace ?? null) === JSON.stringify(baseline.trace ?? null)
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
    && (left.limits.warmupMinutes ?? 0) === (right.limits.warmupMinutes ?? 0)
    && left.limits.maxEvents === right.limits.maxEvents
    && left.limits.maxResources === right.limits.maxResources
    && JSON.stringify(left.trace ?? null) === JSON.stringify(right.trace ?? null);
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
    && sameNodeMetrics(left.nodeMetrics95, right.nodeMetrics95)
    && sameIntervalMap(left.resourceUtilization95, right.resourceUtilization95)
    && sameOptionalIntervalMap(left.resourceFailedMinutes95, right.resourceFailedMinutes95)
    && JSON.stringify(left.productTypeMetrics95 ?? null) === JSON.stringify(right.productTypeMetrics95 ?? null)
    && JSON.stringify(left.productionOrderMetrics95 ?? null) === JSON.stringify(right.productionOrderMetrics95 ?? null)
    && JSON.stringify(left.quality ?? null) === JSON.stringify(right.quality ?? null)
    && JSON.stringify(left.energy ?? null) === JSON.stringify(right.energy ?? null)
    && JSON.stringify(left.bottlenecks) === JSON.stringify(right.bottlenecks);
}

function sameNodeMetrics(
  left: PlantLiteStudyRecord["outcome"]["nodeMetrics95"],
  right: PlantLiteStudyRecord["outcome"]["nodeMetrics95"],
): boolean {
  if (!left || !right) return left === right;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return JSON.stringify(leftKeys) === JSON.stringify(rightKeys) && leftKeys.every((key) => {
    const leftMetric = left[key];
    const rightMetric = right[key];
    return !!leftMetric && !!rightMetric
      && sameInterval(leftMetric.utilization, rightMetric.utilization)
      && sameInterval(leftMetric.averageQueueLength, rightMetric.averageQueueLength)
      && sameInterval(leftMetric.blockedMinutes, rightMetric.blockedMinutes)
      && sameInterval(leftMetric.starvedMinutes, rightMetric.starvedMinutes)
      && sameOptionalInterval(leftMetric.changeoverCount, rightMetric.changeoverCount)
      && sameOptionalInterval(leftMetric.changeoverMinutes, rightMetric.changeoverMinutes);
  });
}

function sameOptionalInterval(
  left: PlantLiteConfidenceInterval | undefined,
  right: PlantLiteConfidenceInterval | undefined,
): boolean {
  if (!left || !right) return left === right;
  return sameInterval(left, right);
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

function sameOptionalIntervalMap(
  left: Record<string, PlantLiteConfidenceInterval> | undefined,
  right: Record<string, PlantLiteConfidenceInterval> | undefined,
): boolean {
  if (!left || !right) return left === right;
  return sameIntervalMap(left, right);
}

function sameInterval(left: PlantLiteConfidenceInterval, right: PlantLiteConfidenceInterval): boolean {
  return left.mean === right.mean
    && left.sampleStandardDeviation === right.sampleStandardDeviation
    && left.lower95 === right.lower95
    && left.upper95 === right.upper95
    && left.samples === right.samples;
}
