import type { SceneRobotJointState, Vector3Value, WorkcellAuditInput, WorkcellAuditResult, WorkcellBounds, WorkcellReachabilityResult } from "@bim-studio/contracts";

export interface RobotAssistantJointInput extends SceneRobotJointState {
  currentAngleDeg?: number;
}

export interface RobotAssistantTargetInput {
  id: string;
  name: string;
  position: Vector3Value;
  orientationEulerDeg?: Vector3Value;
  jointAnglesDeg?: number[];
  processTimeSec?: number;
  settleTimeSec?: number;
}

export interface RobotAssistantObjectInput {
  id: string;
  name: string;
  role: "tool" | "equipment" | "obstacle";
  position: Vector3Value;
  bounds?: WorkcellBounds;
}

export interface RobotCycleGoalInput {
  targetSec: number;
  tcpSpeedMps?: number;
  jointSpeedDegPerSec?: number;
  controllerOverheadSec?: number;
  toolActionSec?: number;
  safetyMarginPercent?: number;
}

export interface RobotWorkcellAssistantInput {
  sceneId: string;
  taskName: string;
  robot: {
    id: string;
    name: string;
    baseBonePath: string;
    base: Vector3Value;
    bounds?: WorkcellBounds;
    currentTcpPosition?: Vector3Value;
    joints: RobotAssistantJointInput[];
    toolObjectId?: string;
  };
  targets: RobotAssistantTargetInput[];
  objects: RobotAssistantObjectInput[];
  cycleGoal: RobotCycleGoalInput;
  clearanceThreshold?: number;
}

export interface RobotCycleBudgetLine {
  id: string;
  label: string;
  kind: "cartesian-move" | "joint-move" | "process" | "settle" | "tool" | "controller" | "margin";
  seconds: number;
  basis: string;
}

export interface RobotCycleBudgetResult {
  method: "kinematic-cycle-budget-v1";
  status: "planned-budget-within-target" | "planned-budget-over-target" | "needs-data";
  targetSec: number;
  motionAndProcessLowerBoundSec?: number;
  plannedBudgetSec?: number;
  slackSec?: number;
  completeness: number;
  lines: RobotCycleBudgetLine[];
  declaration: string;
}

export interface RobotJointLimitCheck {
  waypointId: string;
  jointId: string;
  jointName: string;
  angleDeg?: number;
  minAngleDeg: number;
  maxAngleDeg: number;
  status: "within-limit" | "outside-limit" | "needs-data";
}

export interface RobotTaskDraftStep {
  id: string;
  targetId: string;
  type: "move-to-target" | "execute-process" | "verify-result";
  label: string;
  dispatchable: false;
}

export interface RobotWorkcellAssistantResult {
  generatedBy: "robot-workcell-assistant-orchestrator";
  status: "blocked" | "needs-data" | "ready-for-formal-simulation";
  taskDraft: {
    id: string;
    name: string;
    status: "draft";
    controllerProgramGenerated: false;
    steps: RobotTaskDraftStep[];
  };
  workcellAudit: {
    status: WorkcellAuditResult["status"];
    evidenceCoverage: number;
    evidenceFingerprint: string;
  };
  reachability: WorkcellReachabilityResult[];
  jointLimits: RobotJointLimitCheck[];
  collisionScreening: {
    method: "static-world-aabb-screen";
    status: "aabb-conflict" | "clearance-warning" | "no-aabb-conflict-detected" | "needs-data";
    pairs: WorkcellAuditResult["collisionPairs"];
    declaration: string;
  };
  cycleBudget: RobotCycleBudgetResult;
  missingEvidence: string[];
  formalSimulationItems: string[];
  confirmationPolicy: {
    automaticDispatch: false;
    controllerProgramGenerated: false;
    requiresRobotProgrammer: true;
    requiresSafetyReview: true;
    requiredBeforeDispatch: string[];
  };
  evidenceFingerprint: string;
  fingerprintAlgorithm: "fnv1a64-canonical-v1";
}

export type WorkcellAuditRunner = (input: WorkcellAuditInput) => Promise<WorkcellAuditResult>;
