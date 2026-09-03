import type {
  PprBopVersion,
  PprQualitySamplingFrequency,
  PprWorkInstructionQualityCheck,
} from "@bim-studio/contracts";
import type { PprQualityControlCoverage } from "./types.js";

export type PprQualityControlGap = "characteristic" | "specification" | "inspection-method" | "sampling-frequency" | "reaction-plan";

/** Missing authoring fields only. Invalid values are reported separately by validation. */
export function pprQualityControlGaps(check: PprWorkInstructionQualityCheck): PprQualityControlGap[] {
  const gaps: PprQualityControlGap[] = [];
  if (!hasText(check.checkpoint)) gaps.push("characteristic");
  if (!hasCompleteSpecification(check)) gaps.push("specification");
  if (!hasText(check.inspectionMethod)) gaps.push("inspection-method");
  if (!hasCompleteSamplingFrequency(check.samplingFrequency)) gaps.push("sampling-frequency");
  if (!hasText(check.outOfControlReaction)) gaps.push("reaction-plan");
  return gaps;
}

export function isPprQualityControlComplete(check: PprWorkInstructionQualityCheck): boolean {
  return pprQualityControlGaps(check).length === 0;
}

export function calculatePprQualityControlCoverage(
  version: Pick<PprBopVersion, "operations">,
): PprQualityControlCoverage {
  const missingOperationIds: string[] = [];
  const incompleteOperationIds: string[] = [];
  let coveredOperationCount = 0;
  let completeOperationCount = 0;
  let controlPointCount = 0;
  let completeControlPointCount = 0;

  version.operations.forEach((operation) => {
    const checks = operation.workInstruction?.qualityChecks ?? [];
    if (checks.length === 0) {
      missingOperationIds.push(operation.id);
      return;
    }
    coveredOperationCount += 1;
    controlPointCount += checks.length;
    const completeCount = checks.filter(isPprQualityControlComplete).length;
    completeControlPointCount += completeCount;
    if (completeCount === checks.length) completeOperationCount += 1;
    else incompleteOperationIds.push(operation.id);
  });

  const operationCount = version.operations.length;
  return {
    operationCount,
    coveredOperationCount,
    completeOperationCount,
    controlPointCount,
    completeControlPointCount,
    missingOperationIds,
    incompleteOperationIds,
    qualityPlanReady: operationCount > 0 && completeOperationCount === operationCount,
    evidenceScope: "control-plan-definition-only",
  };
}

export function formatPprQualitySpecification(check: PprWorkInstructionQualityCheck): string {
  const unit = check.unit?.trim() ? ` ${check.unit.trim()}` : "";
  if (check.specificationKind === "limits" && isFiniteNumber(check.lowerLimit) && isFiniteNumber(check.upperLimit)) {
    const target = isFiniteNumber(check.targetValue) ? `目标 ${formatNumber(check.targetValue)}${unit} · ` : "";
    return `${target}${formatNumber(check.lowerLimit)}–${formatNumber(check.upperLimit)}${unit}`;
  }
  if (check.specificationKind === "tolerance" && isFiniteNumber(check.targetValue) && isFiniteNumber(check.tolerance)) {
    return `${formatNumber(check.targetValue)} ± ${formatNumber(check.tolerance)}${unit}`;
  }
  return check.acceptanceCriteria?.trim() || "规格待补";
}

export function formatPprSamplingFrequency(frequency: PprQualitySamplingFrequency | undefined): string {
  if (!frequency) return "频率待补";
  if (frequency.mode === "every-item") return "每件（全检）";
  if (frequency.mode === "first-off") return "每批首件";
  if (frequency.mode === "per-batch") return "每批 1 件";
  if (frequency.mode === "once-per-shift") return "每班 1 次";
  return isPositiveInteger(frequency.interval) ? `每 ${frequency.interval} 件` : "每 N 件（待补 N）";
}

function hasCompleteSpecification(check: PprWorkInstructionQualityCheck): boolean {
  if (check.specificationKind === "limits") {
    return isFiniteNumber(check.lowerLimit)
      && isFiniteNumber(check.upperLimit)
      && check.lowerLimit <= check.upperLimit
      && check.tolerance === undefined
      && (check.targetValue === undefined || (isFiniteNumber(check.targetValue) && check.targetValue >= check.lowerLimit && check.targetValue <= check.upperLimit));
  }
  if (check.specificationKind === "tolerance") {
    return isFiniteNumber(check.targetValue)
      && isFiniteNumber(check.tolerance)
      && check.tolerance > 0
      && check.lowerLimit === undefined
      && check.upperLimit === undefined;
  }
  return false;
}

function hasCompleteSamplingFrequency(frequency: PprQualitySamplingFrequency | undefined): boolean {
  if (!frequency) return false;
  if (frequency.mode === "every-n-items") return isPositiveInteger(frequency.interval);
  return ["every-item", "first-off", "per-batch", "once-per-shift"].includes(frequency.mode)
    && frequency.interval === undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1_000_000) / 1_000_000);
}
