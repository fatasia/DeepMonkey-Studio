import type { PlantLiteAcceptanceTargets, PlantLiteStudyRequest } from "@bim-studio/contracts";

export type PlantLiteNumericAcceptanceKey = keyof Omit<PlantLiteAcceptanceTargets, "basis">;

export function updatePlantLiteAcceptanceTarget(
  request: PlantLiteStudyRequest,
  key: PlantLiteNumericAcceptanceKey,
  value: number | undefined,
): PlantLiteStudyRequest {
  const targets = { ...request.acceptanceTargets };
  if (value === undefined) delete targets[key];
  else targets[key] = value;
  return withTargets(request, targets);
}

export function updatePlantLiteAcceptanceBasis(request: PlantLiteStudyRequest, basis: string): PlantLiteStudyRequest {
  const targets = { ...request.acceptanceTargets };
  if (basis) targets.basis = basis;
  else delete targets.basis;
  return withTargets(request, targets);
}

export function plantLiteAcceptanceTargetIssues(request: PlantLiteStudyRequest): string[] {
  const targets = request.acceptanceTargets;
  if (!targets) return [];
  const issues: string[] = [];
  if (targets.basis !== undefined && targets.basis.trim().length > 160) issues.push("验收依据不能超过 160 个字符");
  const definitions: Array<[PlantLiteNumericAcceptanceKey, string, number]> = [
    ["minimumThroughputPerHour", "最低吞吐", 1_000_000_000],
    ["maximumAverageWip", "最大平均 WIP", 1_000_000_000],
    ["maximumAverageLeadTimeMinutes", "最大平均交付周期", 525_600],
    ["maximumEnergyPerCompletedItemKwh", "最大单位能耗", 1_000_000_000],
    ["maximumElectricityCostPerCompletedItem", "最大单位电费", 1_000_000_000],
    ["maximumCarbonEmissionPerCompletedItemKg", "最大单位碳排", 1_000_000_000],
  ];
  for (const [key, label, maximum] of definitions) {
    const value = targets[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > maximum)) {
      issues.push(`${label}必须大于 0 且不超过 ${maximum}`);
    }
  }
  return issues;
}

function withTargets(request: PlantLiteStudyRequest, targets: PlantLiteAcceptanceTargets): PlantLiteStudyRequest {
  const hasTarget = Object.entries(targets).some(([key, value]) => key === "basis"
    ? typeof value === "string" && value.trim().length > 0
    : typeof value === "number");
  if (hasTarget) return { ...request, acceptanceTargets: targets };
  const { acceptanceTargets: _targets, ...rest } = request;
  return rest;
}
