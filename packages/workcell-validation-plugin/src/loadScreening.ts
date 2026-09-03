import type {
  Vector3Value,
  WorkcellAuditObject,
  WorkcellRobotLoadCheck,
  WorkcellRobotLoadMissingField,
} from "@bim-studio/contracts";

const REQUIRED_FIELD_COUNT = 10;
const DECLARATION = "仅按用户声明的额定质量与组合重心距离做规划筛查；不计算腕部力矩、惯量、加减速或厂商负载曲线，不能作为控制器或安全认证结论。";

export function analyzeRobotLoadCapabilities(objects: WorkcellAuditObject[]): WorkcellRobotLoadCheck[] {
  const objectById = new Map(objects.map((item) => [item.id, item]));
  return objects.filter((item) => item.role === "robot").map((robot) => {
    const chain = robot.robot;
    const capability = chain?.loadCapability;
    const toolLoad = chain?.toolLoad;
    const toolObjectId = chain?.toolObjectId;
    const missingFields: WorkcellRobotLoadMissingField[] = [];
    if (!toolObjectId || objectById.get(toolObjectId)?.role !== "tool") missingFields.push("tool-binding");
    if (!positive(capability?.ratedPayloadKg)) missingFields.push("rated-payload");
    if (!positive(capability?.maximumLoadCenterDistanceMeters)) missingFields.push("rated-load-center");
    if (!evidenceSource(capability?.source)) missingFields.push("capability-source");
    if (!nonNegative(toolLoad?.toolMassKg)) missingFields.push("tool-mass");
    if (!nonNegative(toolLoad?.carriedPayloadKg)) missingFields.push("carried-payload");
    if (!finiteVector(toolLoad?.tcpPositionMeters)) missingFields.push("tcp-position");
    if (!finiteVector(toolLoad?.tcpOrientationEulerDeg)) missingFields.push("tcp-orientation");
    if (!finiteVector(toolLoad?.combinedCenterOfMassMeters)) missingFields.push("combined-center-of-mass");
    if (!evidenceSource(toolLoad?.source)) missingFields.push("tool-load-source");

    const configuredRatedPayloadKg = capability?.ratedPayloadKg;
    const configuredLoadCenterMeters = capability?.maximumLoadCenterDistanceMeters;
    const configuredToolMassKg = toolLoad?.toolMassKg;
    const configuredCarriedPayloadKg = toolLoad?.carriedPayloadKg;
    const configuredCenterOfMass = toolLoad?.combinedCenterOfMassMeters;
    const configuredTcpPosition = toolLoad?.tcpPositionMeters;
    const ratedPayloadKg = positive(configuredRatedPayloadKg) ? configuredRatedPayloadKg : undefined;
    const maximumLoadCenterDistanceMeters = positive(configuredLoadCenterMeters) ? configuredLoadCenterMeters : undefined;
    const totalLoadKg = nonNegative(configuredToolMassKg) && nonNegative(configuredCarriedPayloadKg)
      ? configuredToolMassKg + configuredCarriedPayloadKg
      : undefined;
    const loadCenterDistanceMeters = finiteVector(configuredCenterOfMass)
      ? magnitude(configuredCenterOfMass)
      : undefined;
    const tcpOffsetDistanceMeters = finiteVector(configuredTcpPosition)
      ? magnitude(configuredTcpPosition)
      : undefined;
    const violations: WorkcellRobotLoadCheck["violations"] = [];
    if (ratedPayloadKg !== undefined && totalLoadKg !== undefined && totalLoadKg > ratedPayloadKg + 1e-9) violations.push("payload");
    if (maximumLoadCenterDistanceMeters !== undefined && loadCenterDistanceMeters !== undefined
      && loadCenterDistanceMeters > maximumLoadCenterDistanceMeters + 1e-9) violations.push("load-center");
    const status: WorkcellRobotLoadCheck["status"] = violations.length
      ? "exceeds-planning-envelope"
      : missingFields.length ? "needs-data" : "within-planning-envelope";

    return {
      robotId: robot.id,
      ...(toolObjectId ? { toolObjectId } : {}),
      status,
      violations,
      missingFields,
      ...(ratedPayloadKg !== undefined ? { ratedPayloadKg } : {}),
      ...(totalLoadKg !== undefined ? {
        totalLoadKg,
        ...(ratedPayloadKg !== undefined ? { payloadUtilization: totalLoadKg / ratedPayloadKg } : {}),
      } : {}),
      ...(maximumLoadCenterDistanceMeters !== undefined ? { maximumLoadCenterDistanceMeters } : {}),
      ...(loadCenterDistanceMeters !== undefined ? {
        loadCenterDistanceMeters,
        ...(maximumLoadCenterDistanceMeters !== undefined
          ? { loadCenterUtilization: loadCenterDistanceMeters / maximumLoadCenterDistanceMeters }
          : {}),
      } : {}),
      ...(tcpOffsetDistanceMeters !== undefined ? { tcpOffsetDistanceMeters } : {}),
      evidenceCoverage: Math.max(0, (REQUIRED_FIELD_COUNT - missingFields.length) / REQUIRED_FIELD_COUNT),
      ...(evidenceSource(capability?.source) ? { capabilitySource: capability.source } : {}),
      ...(capability?.reference?.trim() ? { capabilityReference: capability.reference.trim() } : {}),
      ...(evidenceSource(toolLoad?.source) ? { toolLoadSource: toolLoad.source } : {}),
      ...(toolLoad?.reference?.trim() ? { toolLoadReference: toolLoad.reference.trim() } : {}),
      declaration: DECLARATION,
    };
  });
}

function magnitude(value: Vector3Value): number {
  return Math.hypot(value.x, value.y, value.z);
}

function positive(value: number | undefined): value is number {
  return Number.isFinite(value) && value! > 0;
}

function nonNegative(value: number | undefined): value is number {
  return Number.isFinite(value) && value! >= 0;
}

function finiteVector(value: Vector3Value | undefined): value is Vector3Value {
  return Boolean(value && [value.x, value.y, value.z].every(Number.isFinite));
}

function evidenceSource(value: string | undefined): value is "configured-prefab" | "author-confirmed" | "imported" {
  return value === "configured-prefab" || value === "author-confirmed" || value === "imported";
}
