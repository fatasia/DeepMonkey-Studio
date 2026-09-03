import type { Vector3Value } from "./geometry.js";
import type { WorkcellErgonomicsCheck, WorkcellErgonomicsProfile } from "./ergonomics.js";
import type { RobotLoadCapabilityState, RobotToolLoadState } from "./robot.js";

export type WorkcellObjectRole = "robot" | "tool" | "target" | "equipment" | "obstacle" | "unknown";

export interface WorkcellBounds {
  min: Vector3Value;
  max: Vector3Value;
}

export interface WorkcellRobotLink {
  id: string;
  name: string;
  length: number;
  minAngleDeg: number;
  maxAngleDeg: number;
  /** 未声明时只校验位置限位，不对关节速度作通过结论。 */
  maxSpeedDegPerSec?: number;
}

/** 首版只表达品牌无关的关节链，不生成或下发机器人控制器程序。 */
export interface WorkcellRobotChain {
  base: Vector3Value;
  links: WorkcellRobotLink[];
  toolObjectId?: string;
  targetObjectIds?: string[];
  loadCapability?: RobotLoadCapabilityState;
  toolLoad?: RobotToolLoadState;
}

export interface WorkcellAuditObject {
  id: string;
  name: string;
  role: WorkcellObjectRole;
  position: Vector3Value;
  bounds?: WorkcellBounds;
  robot?: WorkcellRobotChain;
}

/**
 * 场景适配器可提供快速起步值，但它们只有在工程师确认后才能参与“通过”结论。
 * 数值仍保留在原有字段中；这里记录来源和场景候选轨迹的推导基准，便于持久化追溯。
 */
export interface WorkcellPlanningAssumptionState {
  origin: "starter-values" | "authored" | "imported";
  status: "unconfirmed" | "engineer-confirmed";
  generatedTrajectorySpeedMps?: number;
  generatedTrajectoryTcpRadiusMeters?: number;
  reference?: string;
}

export type WorkcellPlanningEvidenceMissingField =
  | "planning-confirmation"
  | "clearance-threshold"
  | "trajectory-time-basis"
  | "trajectory-tcp-radius"
  | "trajectory-radius-basis"
  | "trajectory-radius-mismatch"
  | "import-reference";

/** 本次确定性审计实际采用的规划基准；旧结果可不含该字段。 */
export interface WorkcellPlanningEvidence {
  status: "confirmed" | "needs-data";
  origin?: WorkcellPlanningAssumptionState["origin"];
  clearanceThresholdMeters?: number;
  generatedTrajectorySpeedMps?: number;
  generatedTrajectoryTcpRadiusMeters?: number;
  sceneDerivedTrajectoryIds: string[];
  missingFields: WorkcellPlanningEvidenceMissingField[];
  evidenceCoverage: number;
  declaration: string;
}

export interface WorkcellAuditInput {
  sceneId: string;
  objects: WorkcellAuditObject[];
  clearanceThreshold?: number;
  /** 旧记录可省略；场景自动生成的起步参数必须携带并显式确认。 */
  planningAssumptions?: WorkcellPlanningAssumptionState;
  trajectories?: WorkcellRobotTrajectory[];
  ergonomicsProfiles?: WorkcellErgonomicsProfile[];
}

export interface WorkcellAuditFinding {
  id: string;
  category: "collision" | "clearance" | "reachability" | "binding" | "trajectory" | "schedule" | "load" | "ergonomics" | "data";
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  objectIds: string[];
  nextAction: string;
}

export type WorkcellRobotLoadMissingField =
  | "tool-binding"
  | "rated-payload"
  | "rated-load-center"
  | "capability-source"
  | "tool-mass"
  | "carried-payload"
  | "tcp-position"
  | "tcp-orientation"
  | "combined-center-of-mass"
  | "tool-load-source";

/**
 * 仅做规划阶段的额定质量与组合重心包络筛查。
 * 不计算腕部力矩、惯量、加减速或厂商负载曲线，也不能作为控制器/安全认证结论。
 */
export interface WorkcellRobotLoadCheck {
  robotId: string;
  toolObjectId?: string;
  status: "within-planning-envelope" | "exceeds-planning-envelope" | "needs-data";
  violations: Array<"payload" | "load-center">;
  missingFields: WorkcellRobotLoadMissingField[];
  ratedPayloadKg?: number;
  totalLoadKg?: number;
  payloadUtilization?: number;
  maximumLoadCenterDistanceMeters?: number;
  loadCenterDistanceMeters?: number;
  loadCenterUtilization?: number;
  tcpOffsetDistanceMeters?: number;
  evidenceCoverage: number;
  capabilitySource?: RobotLoadCapabilityState["source"];
  capabilityReference?: string;
  toolLoadSource?: RobotToolLoadState["source"];
  toolLoadReference?: string;
  declaration: string;
}

export interface WorkcellCollisionPair {
  objectIds: [string, string];
  distance: number;
  intersects: boolean;
  required: boolean;
}

export interface WorkcellReachabilityResult {
  robotId: string;
  targetId: string;
  distance: number;
  minimumReach: number;
  maximumReach: number;
  status: "reachable" | "outside" | "inner-dead-zone" | "needs-data";
}

export interface WorkcellTrajectoryWaypoint {
  id: string;
  timeSec: number;
  position: Vector3Value;
  /** 顺序与机器人 links 一致；缺失时明确返回 needs-data，不猜测 IK。 */
  jointAnglesDeg?: number[];
}

export interface WorkcellRobotTrajectory {
  id: string;
  name: string;
  robotId: string;
  waypoints: WorkcellTrajectoryWaypoint[];
  tcpRadius?: number;
  precision?: {
    source: "scene-transform" | "author-confirmed" | "imported";
    positionToleranceMeters?: number;
    timeToleranceSeconds?: number;
    jointToleranceDeg?: number;
  };
}

export interface WorkcellJointConstraintCheck {
  trajectoryId: string;
  waypointId: string;
  jointId: string;
  angleDeg?: number;
  positionStatus: "within-limit" | "outside-limit" | "tolerance-overlap" | "needs-data";
  inboundSpeedDegPerSec?: number;
  speedStatus: "within-limit" | "outside-limit" | "tolerance-overlap" | "not-declared" | "needs-data";
}

export interface WorkcellTrajectorySegmentCheck {
  trajectoryId: string;
  segmentId: string;
  startTimeSec: number;
  endTimeSec: number;
  lengthMeters: number;
  potentialObstacleIds: string[];
}

export interface WorkcellAvoidanceCandidate {
  trajectoryId: string;
  segmentId: string;
  obstacleId: string;
  status: "candidate-found" | "no-simple-candidate";
  waypoints: Vector3Value[];
  addedDistanceMeters?: number;
  declaration: string;
}

export interface WorkcellRobotScheduleConflict {
  trajectoryIds: [string, string];
  robotIds: [string, string];
  segmentIds: [string, string];
  startTimeSec: number;
  endTimeSec: number;
  closestTimeSec: number;
  minimumTcpDistanceMeters: number;
  requiredDistanceMeters: number;
}

export interface WorkcellTrajectoryCycleStatistic {
  trajectoryId: string;
  robotId: string;
  durationSec: number;
  pathLengthMeters: number;
  averageTcpSpeedMps: number;
}

export interface WorkcellTrajectoryAnalysis {
  method: "piecewise-linear-tcp-sphere-aabb-v1";
  approximation: "conservative-broad-phase";
  declaration: string;
  precisionStatus: "declared" | "partial" | "undeclared";
  jointChecks: WorkcellJointConstraintCheck[];
  segmentChecks: WorkcellTrajectorySegmentCheck[];
  avoidanceCandidates: WorkcellAvoidanceCandidate[];
  scheduleConflicts: WorkcellRobotScheduleConflict[];
  cycle: {
    trajectories: WorkcellTrajectoryCycleStatistic[];
    scheduleSpanSec: number;
    maxConcurrentRobots: number;
  };
}

export interface WorkcellAuditResult {
  generatedBy: "workcell-validation-plugin";
  status: "passed" | "warning" | "failed" | "needs-data";
  sceneId: string;
  summary: string;
  inventory: Record<WorkcellObjectRole, number>;
  findings: WorkcellAuditFinding[];
  collisionPairs: WorkcellCollisionPair[];
  reachability: WorkcellReachabilityResult[];
  loadChecks: WorkcellRobotLoadCheck[];
  /** 1.4 起提供；用于证明间隙与场景候选轨迹没有依赖隐藏默认值。 */
  planningEvidence?: WorkcellPlanningEvidence;
  /** 1.3 起提供；可选以兼容旧能力结果与已保存记录。 */
  ergonomicsChecks?: WorkcellErgonomicsCheck[];
  trajectoryAnalysis?: WorkcellTrajectoryAnalysis;
  incompleteObjectIds: string[];
  evidenceCoverage: number;
  evidenceFingerprint: string;
  validationDraft: {
    objective: string;
    acceptanceCriteria: string[];
    objectIds: string[];
  };
}
