import type { Vector3Value } from "./geometry.js";

export type WorkcellAnthropometrySource = "author-confirmed" | "imported" | "reference-table";
export type WorkcellManualTaskSource = "author-confirmed" | "imported" | "scene-geometry";
export type WorkcellErgonomicsPolicySource = "author-confirmed" | "imported" | "reference-table";

/** 人体尺寸必须由用户或外部数据显式提供；百分位只记录适用人群，不自动推断尺寸。 */
export interface WorkcellAnthropometryInput {
  method?: "percentile" | "explicit";
  percentile?: number;
  statureMeters?: number;
  shoulderHeightMeters?: number;
  elbowHeightMeters?: number;
  functionalReachMeters?: number;
  source?: WorkcellAnthropometrySource;
  reference?: string;
}

export interface WorkcellManualTaskInput {
  workPointObjectId?: string;
  /** 未绑定场景对象时使用的世界坐标；Y 轴为高度。 */
  workPoint?: Vector3Value;
  loadMassKg?: number;
  repetitionsPerHour?: number;
  durationMinutes?: number;
  source?: WorkcellManualTaskSource;
  reference?: string;
}

/** 项目自己的筛查阈值；不等同于 NIOSH、RULA、REBA 或法规限值。 */
export interface WorkcellErgonomicsPolicyInput {
  maximumLoadKg?: number;
  maximumRepetitionsPerHour?: number;
  maximumDurationMinutes?: number;
  neutralHeightToleranceMeters?: number;
  warningUtilizationRatio?: number;
  source?: WorkcellErgonomicsPolicySource;
  reference?: string;
}

export interface WorkcellErgonomicsProfile {
  id: string;
  name: string;
  operatorObjectId?: string;
  anthropometry?: WorkcellAnthropometryInput;
  task?: WorkcellManualTaskInput;
  policy?: WorkcellErgonomicsPolicyInput;
}

export type WorkcellErgonomicsMissingField =
  | "operator-binding"
  | "anthropometry-method"
  | "anthropometry-percentile"
  | "stature"
  | "shoulder-height"
  | "elbow-height"
  | "functional-reach"
  | "anthropometry-source"
  | "anthropometry-reference"
  | "work-point"
  | "load-mass"
  | "repetitions"
  | "duration"
  | "task-source"
  | "task-reference"
  | "maximum-load"
  | "maximum-repetitions"
  | "maximum-duration"
  | "height-tolerance"
  | "warning-utilization"
  | "policy-source"
  | "policy-reference";

export type WorkcellErgonomicsRuleId =
  | "anthropometry-consistency"
  | "shoulder-reach"
  | "forward-reach"
  | "work-height"
  | "manual-load"
  | "manual-frequency"
  | "manual-duration";

export interface WorkcellErgonomicsRuleResult {
  id: WorkcellErgonomicsRuleId;
  label: string;
  status: "pass" | "warn" | "fail" | "needs-data";
  measuredValue?: number;
  limitValue?: number;
  utilization?: number;
  unit?: "m" | "kg" | "次/小时" | "分钟";
  detail: string;
  recommendation: string;
}

export interface WorkcellErgonomicsCheck {
  profileId: string;
  profileName: string;
  operatorObjectId?: string;
  workPointObjectId?: string;
  status: "pass" | "warn" | "fail" | "needs-data";
  missingFields: WorkcellErgonomicsMissingField[];
  rules: WorkcellErgonomicsRuleResult[];
  evidenceCoverage: number;
  recommendations: string[];
  anthropometrySource?: WorkcellAnthropometrySource;
  anthropometryReference?: string;
  taskSource?: WorkcellManualTaskSource;
  taskReference?: string;
  policySource?: WorkcellErgonomicsPolicySource;
  policyReference?: string;
  declaration: string;
}
