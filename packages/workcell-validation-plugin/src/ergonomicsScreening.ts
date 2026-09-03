import type {
  Vector3Value,
  WorkcellAuditObject,
  WorkcellErgonomicsCheck,
  WorkcellErgonomicsMissingField,
  WorkcellErgonomicsProfile,
  WorkcellErgonomicsRuleResult,
} from "@bim-studio/contracts";

const BASE_REQUIRED_FIELDS = 18;
const DECLARATION = "仅按显式人体尺寸、场景作业点和项目筛查阈值进行规划初筛；不求解完整人体姿态、生物力学载荷，也不输出 NIOSH、RULA、REBA、ISO 或法规认证结论。";

export function analyzeHumanErgonomics(
  profiles: WorkcellErgonomicsProfile[],
  objects: WorkcellAuditObject[],
): WorkcellErgonomicsCheck[] {
  const objectById = new Map(objects.map((item) => [item.id, item]));
  return profiles.slice(0, 20).map((profile) => analyzeProfile(profile, objectById));
}

function analyzeProfile(
  profile: WorkcellErgonomicsProfile,
  objectById: Map<string, WorkcellAuditObject>,
): WorkcellErgonomicsCheck {
  const anthropometry = profile.anthropometry;
  const task = profile.task;
  const policy = profile.policy;
  const operator = profile.operatorObjectId ? objectById.get(profile.operatorObjectId) : undefined;
  const boundWorkPoint = task?.workPointObjectId && task.workPointObjectId !== profile.operatorObjectId
    ? objectById.get(task.workPointObjectId)?.position
    : undefined;
  const workPoint = boundWorkPoint ?? (!task?.workPointObjectId && finiteVector(task?.workPoint) ? task.workPoint : undefined);
  const missingFields: WorkcellErgonomicsMissingField[] = [];
  if (!operator) missingFields.push("operator-binding");
  if (anthropometry?.method !== "percentile" && anthropometry?.method !== "explicit") missingFields.push("anthropometry-method");
  if (anthropometry?.method === "percentile" && !inRange(anthropometry.percentile, 1, 99)) missingFields.push("anthropometry-percentile");
  if (!positive(anthropometry?.statureMeters)) missingFields.push("stature");
  if (!positive(anthropometry?.shoulderHeightMeters)) missingFields.push("shoulder-height");
  if (!positive(anthropometry?.elbowHeightMeters)) missingFields.push("elbow-height");
  if (!positive(anthropometry?.functionalReachMeters)) missingFields.push("functional-reach");
  if (!anthropometrySource(anthropometry?.source)) missingFields.push("anthropometry-source");
  if (requiresReference(anthropometry?.source) && !anthropometry?.reference?.trim()) missingFields.push("anthropometry-reference");
  if (!workPoint) missingFields.push("work-point");
  if (!nonNegative(task?.loadMassKg)) missingFields.push("load-mass");
  if (!nonNegative(task?.repetitionsPerHour)) missingFields.push("repetitions");
  if (!positive(task?.durationMinutes)) missingFields.push("duration");
  if (!taskSource(task?.source)) missingFields.push("task-source");
  if (task?.source === "imported" && !task.reference?.trim()) missingFields.push("task-reference");
  if (!positive(policy?.maximumLoadKg)) missingFields.push("maximum-load");
  if (!positive(policy?.maximumRepetitionsPerHour)) missingFields.push("maximum-repetitions");
  if (!positive(policy?.maximumDurationMinutes)) missingFields.push("maximum-duration");
  if (!positive(policy?.neutralHeightToleranceMeters)) missingFields.push("height-tolerance");
  if (!inRange(policy?.warningUtilizationRatio, 0.01, 1)) missingFields.push("warning-utilization");
  if (!policySource(policy?.source)) missingFields.push("policy-source");
  if (requiresReference(policy?.source) && !policy?.reference?.trim()) missingFields.push("policy-reference");

  const configuredStature = anthropometry?.statureMeters;
  const configuredShoulderHeight = anthropometry?.shoulderHeightMeters;
  const configuredElbowHeight = anthropometry?.elbowHeightMeters;
  const configuredReach = anthropometry?.functionalReachMeters;
  const configuredWarning = policy?.warningUtilizationRatio;
  const configuredHeightTolerance = policy?.neutralHeightToleranceMeters;
  const configuredLoad = task?.loadMassKg;
  const configuredFrequency = task?.repetitionsPerHour;
  const configuredDuration = task?.durationMinutes;
  const configuredMaximumLoad = policy?.maximumLoadKg;
  const configuredMaximumFrequency = policy?.maximumRepetitionsPerHour;
  const configuredMaximumDuration = policy?.maximumDurationMinutes;
  const stature = positive(configuredStature) ? configuredStature : undefined;
  const shoulderHeight = positive(configuredShoulderHeight) ? configuredShoulderHeight : undefined;
  const elbowHeight = positive(configuredElbowHeight) ? configuredElbowHeight : undefined;
  const reach = positive(configuredReach) ? configuredReach : undefined;
  const warning = inRange(configuredWarning, 0.01, 1) ? configuredWarning : undefined;
  const horizontalReach = operator && workPoint ? Math.hypot(workPoint.x - operator.position.x, workPoint.z - operator.position.z) : undefined;
  const shoulderReach = operator && workPoint && shoulderHeight !== undefined
    ? Math.hypot(horizontalReach!, workPoint.y - (operator.position.y + shoulderHeight))
    : undefined;
  const heightOffset = operator && workPoint && elbowHeight !== undefined
    ? Math.abs(workPoint.y - operator.position.y - elbowHeight)
    : undefined;
  const rules: WorkcellErgonomicsRuleResult[] = [
    anthropometryRule(stature, shoulderHeight, elbowHeight, reach),
    utilizationRule("shoulder-reach", "肩点三维可达", shoulderReach, reach, warning, "m", "将人员或工位靠近作业点，并用人体模型复核关节姿态。"),
    utilizationRule("forward-reach", "水平前伸", horizontalReach, reach, warning, "m", "把物料、按钮或工具移入近身工作区，必要时采用滑台或转台。"),
    utilizationRule("work-height", "工作高度偏差", heightOffset, positive(configuredHeightTolerance) ? configuredHeightTolerance : undefined, warning, "m", "调整工作台、升降机构或站姿高度，使操作点接近声明的肘高工作区。"),
    utilizationRule("manual-load", "单次搬运负荷", nonNegative(configuredLoad) ? configuredLoad : undefined, positive(configuredMaximumLoad) ? configuredMaximumLoad : undefined, warning, "kg", "降低单件重量、拆分载荷或配置助力与吊装装置。"),
    utilizationRule("manual-frequency", "搬运频次", nonNegative(configuredFrequency) ? configuredFrequency : undefined, positive(configuredMaximumFrequency) ? configuredMaximumFrequency : undefined, warning, "次/小时", "重新平衡工序、降低重复频次，并评估轮岗或自动化。"),
    utilizationRule("manual-duration", "连续作业时长", positive(configuredDuration) ? configuredDuration : undefined, positive(configuredMaximumDuration) ? configuredMaximumDuration : undefined, warning, "分钟", "缩短连续暴露时间，增加恢复时间或采用轮岗。"),
  ];
  const status = overallStatus(rules, missingFields);
  const requiredFields = BASE_REQUIRED_FIELDS
    + (anthropometry?.method === "percentile" ? 1 : 0)
    + (requiresReference(anthropometry?.source) ? 1 : 0)
    + (task?.source === "imported" ? 1 : 0)
    + (requiresReference(policy?.source) ? 1 : 0);
  const recommendations = unique([
    ...rules.filter((item) => item.status === "warn" || item.status === "fail").map((item) => item.recommendation),
    ...(missingFields.length ? ["补齐人体、任务与筛查策略证据后重新运行，缺失项不作通过判断。"] : []),
  ]);
  return {
    profileId: profile.id,
    profileName: profile.name,
    ...(profile.operatorObjectId ? { operatorObjectId: profile.operatorObjectId } : {}),
    ...(task?.workPointObjectId ? { workPointObjectId: task.workPointObjectId } : {}),
    status,
    missingFields,
    rules,
    evidenceCoverage: Math.max(0, (requiredFields - missingFields.length) / requiredFields),
    recommendations,
    ...(anthropometrySource(anthropometry?.source) ? { anthropometrySource: anthropometry.source } : {}),
    ...(anthropometry?.reference?.trim() ? { anthropometryReference: anthropometry.reference.trim() } : {}),
    ...(taskSource(task?.source) ? { taskSource: task.source } : {}),
    ...(task?.reference?.trim() ? { taskReference: task.reference.trim() } : {}),
    ...(policySource(policy?.source) ? { policySource: policy.source } : {}),
    ...(policy?.reference?.trim() ? { policyReference: policy.reference.trim() } : {}),
    declaration: DECLARATION,
  };
}

function anthropometryRule(
  stature: number | undefined,
  shoulderHeight: number | undefined,
  elbowHeight: number | undefined,
  reach: number | undefined,
): WorkcellErgonomicsRuleResult {
  const complete = stature !== undefined && shoulderHeight !== undefined && elbowHeight !== undefined && reach !== undefined;
  if (!complete) return missingRule("anthropometry-consistency", "人体参数一致性", "补齐身高、肩高、肘高与功能可达距离。", "补齐显式人体尺寸并核对数据来源。");
  const plausibleOrder = stature > shoulderHeight && shoulderHeight > elbowHeight && reach <= stature;
  return {
    id: "anthropometry-consistency",
    label: "人体参数一致性",
    status: plausibleOrder ? "pass" : "fail",
    detail: plausibleOrder ? "身高、肩高、肘高与功能可达距离的相对关系有效。" : "人体尺寸的相对关系无效，不能用于规划筛查。",
    recommendation: "检查单位与人体数据表，确保身高 > 肩高 > 肘高且功能可达距离不大于身高。",
  };
}

function utilizationRule(
  id: Exclude<WorkcellErgonomicsRuleResult["id"], "anthropometry-consistency">,
  label: string,
  measured: number | undefined,
  limit: number | undefined,
  warning: number | undefined,
  unit: NonNullable<WorkcellErgonomicsRuleResult["unit"]>,
  recommendation: string,
): WorkcellErgonomicsRuleResult {
  if (measured === undefined || limit === undefined || warning === undefined) {
    return missingRule(id, label, "测量值、项目限值或预警比例不完整。", recommendation);
  }
  const utilization = measured / limit;
  const status = utilization > 1 + 1e-9 ? "fail" : utilization >= warning ? "warn" : "pass";
  return {
    id, label, status, measuredValue: measured, limitValue: limit, utilization, unit,
    detail: `${label} ${format(measured)} ${unit}，项目筛查限值 ${format(limit)} ${unit}，利用率 ${format(utilization * 100)}%。`,
    recommendation,
  };
}

function missingRule(id: WorkcellErgonomicsRuleResult["id"], label: string, detail: string, recommendation: string): WorkcellErgonomicsRuleResult {
  return { id, label, status: "needs-data", detail, recommendation };
}

function overallStatus(
  rules: WorkcellErgonomicsRuleResult[],
  missingFields: WorkcellErgonomicsMissingField[],
): WorkcellErgonomicsCheck["status"] {
  if (rules.some((item) => item.status === "fail")) return "fail";
  if (missingFields.length || rules.some((item) => item.status === "needs-data")) return "needs-data";
  return rules.some((item) => item.status === "warn") ? "warn" : "pass";
}

function finiteVector(value: Vector3Value | undefined): value is Vector3Value {
  return Boolean(value && [value.x, value.y, value.z].every(Number.isFinite));
}
function positive(value: number | undefined): value is number { return Number.isFinite(value) && value! > 0; }
function nonNegative(value: number | undefined): value is number { return Number.isFinite(value) && value! >= 0; }
function inRange(value: number | undefined, minimum: number, maximum: number): value is number {
  return Number.isFinite(value) && value! >= minimum && value! <= maximum;
}
function requiresReference(value: string | undefined): boolean { return value === "imported" || value === "reference-table"; }
function anthropometrySource(value: string | undefined): value is "author-confirmed" | "imported" | "reference-table" {
  return value === "author-confirmed" || value === "imported" || value === "reference-table";
}
function taskSource(value: string | undefined): value is "author-confirmed" | "imported" | "scene-geometry" {
  return value === "author-confirmed" || value === "imported" || value === "scene-geometry";
}
function policySource(value: string | undefined): value is "author-confirmed" | "imported" | "reference-table" {
  return value === "author-confirmed" || value === "imported" || value === "reference-table";
}
function format(value: number): string { return Number(value.toFixed(3)).toString(); }
function unique(values: string[]): string[] { return [...new Set(values)]; }
