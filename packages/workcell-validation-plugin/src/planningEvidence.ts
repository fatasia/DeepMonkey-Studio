import type {
  WorkcellAuditInput,
  WorkcellPlanningEvidence,
  WorkcellPlanningEvidenceMissingField,
} from "@bim-studio/contracts";

/**
 * 检查间隙和场景候选轨迹所依赖的规划参数是否可追溯。
 * 显式导入/编写的旧输入仍可运行；只有带 scene-transform 的自动候选轨迹必须提供推导基准。
 */
export function assessWorkcellPlanningEvidence(
  input: WorkcellAuditInput,
  clearanceRequired: boolean,
): WorkcellPlanningEvidence {
  const assumptions = input.planningAssumptions;
  const trajectories = input.trajectories ?? [];
  const sceneDerived = trajectories.filter((item) => item.precision?.source === "scene-transform");
  const missing = new Set<WorkcellPlanningEvidenceMissingField>();
  const checks: boolean[] = [];
  const clearance = finiteNonNegative(input.clearanceThreshold);
  const generatedSpeed = finitePositive(assumptions?.generatedTrajectorySpeedMps);
  const generatedRadius = finitePositive(assumptions?.generatedTrajectoryTcpRadiusMeters);

  if (clearanceRequired || input.clearanceThreshold !== undefined) {
    checks.push(clearance !== undefined);
    if (clearance === undefined) missing.add("clearance-threshold");
  }

  if (trajectories.length) {
    const radiiDeclared = trajectories.every((item) => finitePositive(item.tcpRadius) !== undefined);
    checks.push(radiiDeclared);
    if (!radiiDeclared) missing.add("trajectory-tcp-radius");
  }

  if (assumptions) {
    const confirmed = assumptions.status === "engineer-confirmed";
    checks.push(confirmed);
    if (!confirmed) missing.add("planning-confirmation");
    if (assumptions.origin === "imported") {
      const referenced = Boolean(assumptions.reference?.trim());
      checks.push(referenced);
      if (!referenced) missing.add("import-reference");
    }
  }

  if (sceneDerived.length) {
    const confirmed = assumptions?.status === "engineer-confirmed";
    if (!assumptions || !confirmed) missing.add("planning-confirmation");
    checks.push(Boolean(assumptions));

    checks.push(generatedSpeed !== undefined);
    if (generatedSpeed === undefined) missing.add("trajectory-time-basis");

    checks.push(generatedRadius !== undefined);
    if (generatedRadius === undefined) missing.add("trajectory-radius-basis");

    const radiiMatch = generatedRadius !== undefined
      && sceneDerived.every((item) => valuesMatch(item.tcpRadius, generatedRadius));
    checks.push(radiiMatch);
    if (generatedRadius !== undefined && !radiiMatch) missing.add("trajectory-radius-mismatch");
  }

  const missingFields = [...missing];
  const rawCoverage = checks.length ? checks.filter(Boolean).length / checks.length : 1;
  const evidenceCoverage = missingFields.length ? Math.min(0.5, rawCoverage) : 1;
  const status = missingFields.length ? "needs-data" as const : "confirmed" as const;
  return {
    status,
    ...(assumptions ? { origin: assumptions.origin } : {}),
    ...(clearance !== undefined ? { clearanceThresholdMeters: clearance } : {}),
    ...(generatedSpeed !== undefined
      ? { generatedTrajectorySpeedMps: generatedSpeed }
      : {}),
    ...(generatedRadius !== undefined
      ? { generatedTrajectoryTcpRadiusMeters: generatedRadius }
      : {}),
    sceneDerivedTrajectoryIds: sceneDerived.map((item) => item.id),
    missingFields,
    evidenceCoverage,
    declaration: status === "confirmed"
      ? "间隙阈值与场景候选轨迹的速度/TCP 包络基准均来自显式输入或工程师确认；结论仍只属于规划快速初筛。"
      : "规划起步值或轨迹推导基准尚未确认/声明；依赖这些近似值的间隙、轨迹与时序结果不得作为通过结论。",
  };
}

export function planningEvidenceMissingLabel(value: WorkcellPlanningEvidenceMissingField): string {
  return ({
    "planning-confirmation": "规划起步值确认",
    "clearance-threshold": "安全间隙阈值",
    "trajectory-time-basis": "候选轨迹速度基准",
    "trajectory-tcp-radius": "轨迹 TCP 包络半径",
    "trajectory-radius-basis": "候选轨迹 TCP 半径基准",
    "trajectory-radius-mismatch": "轨迹 TCP 半径与推导基准一致性",
    "import-reference": "导入参数引用",
  })[value];
}

function finitePositive(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNonNegative(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function valuesMatch(value: number | undefined, expected: number): boolean {
  return value !== undefined && Number.isFinite(value) && Math.abs(value - expected) <= 1e-9;
}
