import type { Vector3Value } from "./geometry.js";

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
}

export interface WorkcellAuditObject {
  id: string;
  name: string;
  role: WorkcellObjectRole;
  position: Vector3Value;
  bounds?: WorkcellBounds;
  robot?: WorkcellRobotChain;
}

export interface WorkcellAuditInput {
  sceneId: string;
  objects: WorkcellAuditObject[];
  clearanceThreshold?: number;
  trajectories?: WorkcellRobotTrajectory[];
}

export interface WorkcellAuditFinding {
  id: string;
  category: "collision" | "clearance" | "reachability" | "binding" | "trajectory" | "schedule" | "data";
  severity: "error" | "warning" | "info";
  title: string;
  detail: string;
  objectIds: string[];
  nextAction: string;
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
