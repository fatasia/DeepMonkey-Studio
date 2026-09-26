import type { Vector3Value } from "./geometry.js";
import type { HumanPercentileFigure } from "./humanFigure.js";

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
  /**
   * 增量字段:标准分数层。仅在调用方显式传入百分位人体/任务因子/姿态编码时输出,
   * 未提供时缺省——既有字段语义不受影响,也不构成 NIOSH/OWAS 认证结论。
   */
  nioshLifting?: NioshLiftingScore;
  owasPosture?: OwasPostureScore;
  /** 本次筛查应用的人体档案(近似,非医学级);仅在调用方显式提供时输出。 */
  humanFigureApplied?: HumanPercentileFigure;
}

/** NIOSH 提举方程(1994 修订版)任务变量,公制口径。 */
export interface NioshLiftingFactors {
  /** 单件实际载荷 kg(LI 的分子)。 */
  loadMassKg: number;
  /** 手到双踝中点的水平距离 H,cm;≤25 取 HM=1,>63 官方 HM=0。 */
  horizontalCm: number;
  /** 起点手高 V,cm;>175 官方 VM=0。 */
  verticalOriginCm: number;
  /** 垂直行程 D,cm;<25 官方按 25 处理,>175 官方 DM=0。 */
  travelCm: number;
  /** 躯干不对称转角 A,度;>135 官方 AM=0。 */
  asymmetryDeg: number;
  /** 提举频率 F,次/分钟;<0.2 官方按 0.2 处理,>15 官方 FM=0。 */
  liftsPerMinute: number;
  /** 持续时间档:short ≤1 小时 / moderate 1-2 小时 / long 2-8 小时。 */
  durationCategory: NioshDurationCategory;
  /** 手-物耦合质量;无法判定时按 fair 处理并在结果 note 声明。 */
  coupling: "good" | "fair" | "poor";
}

export type NioshDurationCategory = "short" | "moderate" | "long";

export interface NioshMultiplierSet {
  hm: number;
  vm: number;
  dm: number;
  am: number;
  fm: number;
  cm: number;
}

export interface NioshLiftingScore {
  standard: "NIOSH-1994";
  multipliers: NioshMultiplierSet;
  /** 推荐重量限值 kg;0 表示官方禁止组合(H/V/D/A/F 越界)。 */
  recommendedWeightLimitKg: number;
  /** 提举指数 = 载荷/RWL;RWL=0 时无定义(null)。 */
  liftingIndex: number | null;
  prohibitedReason?: string;
  note: string;
}

/** OWAS 姿态四元组(背/臂/腿/载荷)。编码含义见 owasPosture 实现。 */
export interface OwasPostureInput {
  /** 1 直立 2 前弯 3 扭转 4 弯且扭。 */
  back: 1 | 2 | 3 | 4;
  /** 1 双臂低于肩 2 单臂不低于肩 3 双臂不低于肩。 */
  arm: 1 | 2 | 3;
  /** 1 坐姿 2 双腿伸直站立 3 单腿承重站立 4 双膝弯曲 5 单膝弯曲承重 6 跪姿 7 行走/移动。 */
  leg: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** 搬运/施力载荷 kg;缺省按 OWAS 惯例归入未知/最重组。 */
  loadMassKg?: number;
}

export interface OwasPostureScore {
  standard: "OWAS";
  /** "背臂腿载" 四位码,如 "2153"。 */
  code: string;
  actionCategory: 1 | 2 | 3 | 4;
  actionLabel: string;
  note: string;
}
