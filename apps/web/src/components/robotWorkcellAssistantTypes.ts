import type {
  RobotLoadCapabilityState,
  RobotToolLoadState,
  SceneRobotJointState,
  Vector3Value,
  WorkcellAuditInput,
  WorkcellAuditResult,
  WorkcellBounds,
  WorkcellReachabilityResult,
  WorkcellRobotLoadCheck,
} from "@bim-studio/contracts";

export interface RobotAssistantJointInput extends SceneRobotJointState {
  currentAngleDeg?: number;
}

export interface RobotAssistantTargetInput {
  id: string;
  name: string;
  position: Vector3Value;
  /** 未声明等同启用；停用点保留在草稿中，但不进入本次轨迹、节拍与验证。 */
  enabled?: boolean;
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
  /** 规划广相位采用的 TCP/工具/工件组合包络半径。 */
  tcpRadiusMeters?: number;
  jointSpeedDegPerSec?: number;
  controllerOverheadSec?: number;
  toolActionSec?: number;
  safetyMarginPercent?: number;
}

export interface RobotPlanningAssumptionState {
  /** 起步值只用于快速配置；未明确确认前不得执行并生成工程结论。 */
  origin: "starter-values" | "authored";
  status: "unconfirmed" | "engineer-confirmed";
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
    loadCapability?: RobotLoadCapabilityState;
    toolLoad?: RobotToolLoadState;
  };
  targets: RobotAssistantTargetInput[];
  objects: RobotAssistantObjectInput[];
  cycleGoal: RobotCycleGoalInput;
  clearanceThreshold?: number;
  /** 旧记录可省略；新建任务必须显式确认起步规划参数。 */
  planningAssumptions?: RobotPlanningAssumptionState;
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
  /** 只描述快速初筛后的下一步，不能被解释为精确机器人仿真通过。 */
  status: "blocked" | "needs-data" | "ready-for-control-validation";
  taskDraft: {
    id: string;
    name: string;
    robotId: string;
    status: "draft";
    controllerProgramGenerated: false;
    steps: RobotTaskDraftStep[];
  };
  workcellAudit: {
    status: WorkcellAuditResult["status"];
    evidenceCoverage: number;
    evidenceFingerprint: string;
    /** 与本次任务输入配对的轨迹初筛证据；不包含 IK 或机器人骨骼动画。 */
    trajectoryAnalysis?: NonNullable<WorkcellAuditResult["trajectoryAnalysis"]>;
  };
  reachability: WorkcellReachabilityResult[];
  jointLimits: RobotJointLimitCheck[];
  collisionScreening: {
    method: "static-world-aabb-screen";
    status: "aabb-conflict" | "clearance-warning" | "no-aabb-conflict-detected" | "needs-data";
    pairs: WorkcellAuditResult["collisionPairs"];
    declaration: string;
  };
  loadScreening: WorkcellRobotLoadCheck;
  cycleBudget: RobotCycleBudgetResult;
  missingEvidence: string[];
  /** 当前网页能力之外仍需完成的工程校核，始终不能被快速初筛或控制逻辑回放替代。 */
  remainingEngineeringChecks: string[];
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
