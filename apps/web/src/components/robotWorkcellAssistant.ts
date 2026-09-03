import type { SceneRobotJointState, WorkcellAuditInput, WorkcellAuditResult, WorkcellRobotTrajectory } from "@bim-studio/contracts";
import { normalizeRobotKinematicsState } from "../viewer/robotKinematics";
import { estimateRobotCycleBudget } from "./robotWorkcellCycleBudget";
import type {
  RobotJointLimitCheck, RobotTaskDraftStep, RobotWorkcellAssistantInput,
  RobotWorkcellAssistantResult, WorkcellAuditRunner,
} from "./robotWorkcellAssistantTypes";
import { activeRobotPathTargets } from "./robotWorkcellPathEditing";

/**
 * 编排现有 WorkcellAudit：先生成标准审计输入，再基于审计证据组织任务草稿。
 * 此模块不求解 IK、不做网格碰撞，也不生成任何机器人控制器指令。
 */
export async function runRobotWorkcellAssistant(input: RobotWorkcellAssistantInput, runAudit: WorkcellAuditRunner): Promise<RobotWorkcellAssistantResult> {
  validateInput(input);
  if (input.planningAssumptions?.status !== "engineer-confirmed") throw new Error("请先确认速度、TCP 包络、动作时间、裕量与安全间隙等规划参数");
  const audit = await runAudit(buildRobotWorkcellAuditInput(input));
  return composeRobotWorkcellAssistant(input, audit);
}

export function buildRobotWorkcellAuditInput(input: RobotWorkcellAssistantInput): WorkcellAuditInput {
  validateInput(input);
  const robot = normalizedRobot(input);
  const trajectory = assistantTrajectory(input);
  const activeTargets = activeRobotPathTargets(input);
  return {
    sceneId: input.sceneId,
    ...(input.clearanceThreshold !== undefined ? { clearanceThreshold: input.clearanceThreshold } : {}),
    ...(input.planningAssumptions ? {
      planningAssumptions: {
        origin: input.planningAssumptions.origin,
        status: input.planningAssumptions.status,
        ...(input.cycleGoal.tcpSpeedMps !== undefined ? { generatedTrajectorySpeedMps: input.cycleGoal.tcpSpeedMps } : {}),
        ...(input.cycleGoal.tcpRadiusMeters !== undefined ? { generatedTrajectoryTcpRadiusMeters: input.cycleGoal.tcpRadiusMeters } : {}),
      },
    } : {}),
    objects: [
      {
        id: input.robot.id, name: input.robot.name, role: "robot", position: { ...input.robot.base },
        ...(input.robot.bounds ? { bounds: cloneBounds(input.robot.bounds) } : {}),
        robot: {
          base: { ...input.robot.base },
          links: robot.joints.map((joint) => ({ id: joint.bonePath, name: joint.name, length: joint.length, minAngleDeg: joint.minAngleDeg, maxAngleDeg: joint.maxAngleDeg })),
          ...(input.robot.toolObjectId ? { toolObjectId: input.robot.toolObjectId } : {}),
          targetObjectIds: activeTargets.map((item) => item.id),
          ...(input.robot.loadCapability ? { loadCapability: structuredClone(input.robot.loadCapability) } : {}),
          ...(input.robot.toolLoad ? { toolLoad: structuredClone(input.robot.toolLoad) } : {}),
        },
      },
      ...input.targets.map((target) => ({ id: target.id, name: target.name, role: "target" as const, position: { ...target.position } })),
      ...input.objects.map((object) => ({
        id: object.id, name: object.name, role: object.role, position: { ...object.position },
        ...(object.bounds ? { bounds: cloneBounds(object.bounds) } : {}),
      })),
    ],
    ...(trajectory ? { trajectories: [trajectory] } : {}),
  };
}

function assistantTrajectory(input: RobotWorkcellAssistantInput): WorkcellRobotTrajectory | undefined {
  const tcpSpeed = input.cycleGoal.tcpSpeedMps;
  const tcpRadius = input.cycleGoal.tcpRadiusMeters;
  if (!positive(tcpSpeed) || !positive(tcpRadius)) return undefined;
  let elapsed = 0;
  let previous = input.robot.currentTcpPosition ?? input.robot.base;
  const currentAngles = input.robot.joints.map((item) => item.currentAngleDeg);
  const waypoints: WorkcellRobotTrajectory["waypoints"] = [{
    id: "current",
    timeSec: 0,
    position: { ...previous },
    ...(currentAngles.every((item): item is number => item !== undefined && Number.isFinite(item))
      ? { jointAnglesDeg: currentAngles }
      : {}),
  }];
  for (const target of activeRobotPathTargets(input)) {
    const distance = vectorDistance(previous, target.position);
    // 重合目标不产生虚构的最短运动时间；工艺/稳定时间仍在节拍预算中单独计算。
    if (distance <= 1e-9) continue;
    elapsed += distance / tcpSpeed;
    waypoints.push({
      id: target.id,
      timeSec: elapsed,
      position: { ...target.position },
      ...(target.jointAnglesDeg ? { jointAnglesDeg: [...target.jointAnglesDeg] } : {}),
    });
    previous = target.position;
  }
  if (waypoints.length < 2) return undefined;
  return {
    id: `assistant-path:${input.robot.id}`,
    name: `${input.robot.name} · 任务直线候选`,
    robotId: input.robot.id,
    tcpRadius,
    precision: { source: "scene-transform" },
    waypoints,
  };
}

export function composeRobotWorkcellAssistant(input: RobotWorkcellAssistantInput, audit: WorkcellAuditResult): RobotWorkcellAssistantResult {
  validateInput(input);
  if (audit.sceneId !== input.sceneId || audit.generatedBy !== "workcell-validation-plugin") throw new Error("工位审计结果与当前任务不匹配");
  validateAuditScope(input, audit);
  const robot = normalizedRobot(input);
  const jointLimits = checkJointLimits(input, robot.joints);
  const cycleBudget = estimateRobotCycleBudget(input);
  const activeTargets = activeRobotPathTargets(input);
  const reachability = audit.reachability.filter((item) => item.robotId === input.robot.id && activeTargets.some((target) => target.id === item.targetId));
  const loadScreening = audit.loadChecks.find((item) => item.robotId === input.robot.id);
  if (!loadScreening) throw new Error("工位审计结果缺少当前机器人的负载/TCP筛查证据");
  const missingEvidence = buildMissingEvidence(input, audit, reachability.length, jointLimits, cycleBudget.completeness, loadScreening);
  const collisionStatus: RobotWorkcellAssistantResult["collisionScreening"]["status"] = audit.status === "needs-data" || audit.incompleteObjectIds.length
    ? "needs-data"
    : audit.collisionPairs.some((item) => item.intersects)
      ? "aabb-conflict"
      : audit.findings.some((item) => item.category === "clearance") ? "clearance-warning" : "no-aabb-conflict-detected";
  const outsideLimit = jointLimits.some((item) => item.status === "outside-limit");
  const unreachable = reachability.some((item) => item.status === "outside" || item.status === "inner-dead-zone");
  const status: RobotWorkcellAssistantResult["status"] = outsideLimit || unreachable || collisionStatus === "aabb-conflict" || loadScreening.status === "exceeds-planning-envelope"
    ? "blocked"
    : missingEvidence.length || collisionStatus === "needs-data" ? "needs-data" : "ready-for-control-validation";
  const taskSteps = buildTaskSteps(input);
  const resultBase = {
    generatedBy: "robot-workcell-assistant-orchestrator" as const,
    status,
    taskDraft: {
      id: `robot-task-draft:${input.sceneId}:${input.robot.id}`, name: input.taskName, status: "draft" as const,
      robotId: input.robot.id, controllerProgramGenerated: false as const, steps: taskSteps,
    },
    workcellAudit: {
      status: audit.status,
      evidenceCoverage: audit.evidenceCoverage,
      evidenceFingerprint: audit.evidenceFingerprint,
      ...(audit.trajectoryAnalysis ? { trajectoryAnalysis: structuredClone(audit.trajectoryAnalysis) } : {}),
    },
    reachability: reachability.map((item) => ({ ...item })),
    jointLimits,
    collisionScreening: {
      method: "static-world-aabb-screen" as const, status: collisionStatus,
      pairs: audit.collisionPairs.map((item) => ({ ...item, objectIds: [...item.objectIds] as [string, string] })),
      declaration: "仅完成静态世界 AABB 初筛；未发现包围盒冲突不等于网格级连续扫掠路径、连杆或电缆不会碰撞。",
    },
    loadScreening: structuredClone(loadScreening),
    cycleBudget,
    missingEvidence,
    remainingEngineeringChecks: remainingEngineeringChecks(input, audit, jointLimits),
    confirmationPolicy: {
      automaticDispatch: false as const, controllerProgramGenerated: false as const,
      requiresRobotProgrammer: true as const, requiresSafetyReview: true as const,
      requiredBeforeDispatch: ["机器人离线仿真通过", "安全回路与联锁验收通过", "机器人程序员核对控制器程序", "现场低速单步试运行并由授权人员确认"],
    },
  };
  return { ...resultBase, evidenceFingerprint: fingerprint({ input, auditFingerprint: audit.evidenceFingerprint, result: resultBase }), fingerprintAlgorithm: "fnv1a64-canonical-v1" };
}

function normalizedRobot(input: RobotWorkcellAssistantInput) {
  return normalizeRobotKinematicsState({
    enabled: true, baseBonePath: input.robot.baseBonePath,
    ...(input.robot.toolObjectId ? { toolObjectId: input.robot.toolObjectId } : {}),
    targetObjectIds: activeRobotPathTargets(input).map((item) => item.id),
    joints: input.robot.joints.map(({ currentAngleDeg: _current, ...joint }) => ({ ...joint })),
  });
}

function checkJointLimits(input: RobotWorkcellAssistantInput, joints: SceneRobotJointState[]): RobotJointLimitCheck[] {
  const waypoints = [
    { id: "current", angles: input.robot.joints.map((item) => item.currentAngleDeg) },
    ...activeRobotPathTargets(input).map((item) => ({ id: item.id, angles: item.jointAnglesDeg ?? [] })),
  ];
  return waypoints.flatMap((waypoint) => joints.map((joint, index) => {
    const angle = waypoint.angles[index];
    const status = angle === undefined || !Number.isFinite(angle) ? "needs-data" : angle < joint.minAngleDeg || angle > joint.maxAngleDeg ? "outside-limit" : "within-limit";
    return {
      waypointId: waypoint.id, jointId: joint.bonePath, jointName: joint.name,
      ...(angle !== undefined && Number.isFinite(angle) ? { angleDeg: angle } : {}),
      minAngleDeg: joint.minAngleDeg, maxAngleDeg: joint.maxAngleDeg, status,
    };
  }));
}

function buildTaskSteps(input: RobotWorkcellAssistantInput): RobotTaskDraftStep[] {
  return activeRobotPathTargets(input).flatMap((target, index) => {
    const prefix = `step-${index + 1}`;
    return [
      { id: `${prefix}-move`, targetId: target.id, type: "move-to-target" as const, label: `规划移动至 ${target.name}`, dispatchable: false as const },
      ...((target.processTimeSec ?? 0) > 0 ? [{ id: `${prefix}-process`, targetId: target.id, type: "execute-process" as const, label: `执行 ${target.name} 工艺动作`, dispatchable: false as const }] : []),
      ...((target.processTimeSec ?? 0) > 0 || (target.settleTimeSec ?? 0) > 0 ? [{
        id: `${prefix}-verify`, targetId: target.id, type: "verify-result" as const,
        label: (target.settleTimeSec ?? 0) > 0 ? `等待稳定后验证 ${target.name} 结果与联锁` : `验证 ${target.name} 结果与联锁`,
        dispatchable: false as const,
      }] : []),
    ];
  });
}

function buildMissingEvidence(
  input: RobotWorkcellAssistantInput,
  audit: WorkcellAuditResult,
  reachabilityCount: number,
  limits: RobotJointLimitCheck[],
  cycleCompleteness: number,
  loadScreening: RobotWorkcellAssistantResult["loadScreening"],
): string[] {
  const trajectory = audit.trajectoryAnalysis;
  const activeTargets = activeRobotPathTargets(input);
  const potentialTrajectoryConflicts = trajectory?.segmentChecks.reduce((total, item) => total + item.potentialObstacleIds.length, 0) ?? 0;
  return unique([
    ...(input.robot.bounds ? [] : ["机器人本体缺少世界包围盒，无法完成静态障碍初筛"]),
    ...audit.incompleteObjectIds.map((id) => `对象 ${id} 缺少世界包围盒`),
    ...(reachabilityCount === activeTargets.length ? [] : ["部分目标缺少关节链可达包络结论"]),
    ...(limits.some((item) => item.status === "needs-data") ? ["缺少当前位姿或目标关节角，无法完成全部限位检查"] : []),
    ...(activeTargets.every((item) => item.orientationEulerDeg) ? [] : ["部分目标缺少末端姿态约束"]),
    ...(cycleCompleteness === 1 ? [] : ["节拍估算缺少完整 TCP/关节位姿或速度参数"]),
    ...(!input.cycleGoal.tcpSpeedMps && !input.cycleGoal.jointSpeedDegPerSec ? ["未提供 TCP 或关节速度"] : []),
    ...(trajectory && trajectory.precisionStatus !== "declared" ? ["轨迹位置或时间精度未完整声明"] : []),
    ...(potentialTrajectoryConflicts ? [`${potentialTrajectoryConflicts} 个轨迹/障碍广相位潜在冲突待网格级复核`] : []),
    ...(trajectory?.scheduleConflicts.length ? [`${trajectory.scheduleConflicts.length} 个多机器人时间段冲突待消解`] : []),
    ...loadScreening.missingFields.map((field) => `负载/TCP待补充：${loadFieldLabel(field)}`),
  ]);
}

function remainingEngineeringChecks(input: RobotWorkcellAssistantInput, audit: WorkcellAuditResult, limits: RobotJointLimitCheck[]): string[] {
  return unique([
    "带目标姿态、工具坐标系和奇异点检查的完整 IK 求解",
    "机器人各连杆、工具、工件、电缆与障碍物的网格级连续扫掠碰撞",
    "控制器加减速、jerk、转角圆滑、速度覆盖和 IO 等待的节拍仿真",
    "按厂商负载曲线复核腕部力矩、惯量、加减速与动态工况",
    "安全 PLC、围栏门、急停、区域扫描和故障复位联锁验收",
    ...(audit.collisionPairs.some((item) => item.intersects) ? ["对 AABB 相交对象执行精确网格干涉与最小距离分析"] : []),
    ...(limits.some((item) => item.status === "outside-limit") ? ["调整目标位姿后重新求解并验证全部关节限位"] : []),
    ...(activeRobotPathTargets(input).some((item) => !item.orientationEulerDeg) ? ["补充每个启用目标的末端姿态和容差"] : []),
  ]);
}

function validateInput(input: RobotWorkcellAssistantInput): void {
  if (!input.sceneId.trim() || !input.taskName.trim() || !input.robot.id.trim() || !input.robot.name.trim()) throw new Error("机器人工位任务标识和名称不能为空");
  if (!input.robot.joints.length || input.robot.joints.length > 16) throw new Error("机器人关节数量必须为 1–16");
  if (!input.targets.length || input.targets.length > 100 || input.objects.length > 200) throw new Error("机器人工位目标必须为 1–100，场景对象不能超过 200");
  if (!activeRobotPathTargets(input).length) throw new Error("至少启用一个机器人工位目标");
  const ids = [input.robot.id, ...input.targets.map((item) => item.id), ...input.objects.map((item) => item.id)];
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) throw new Error("机器人、目标和对象 ID 必须非空且唯一");
  if (!positive(input.cycleGoal.targetSec)) throw new Error("节拍目标必须大于 0 秒");
  if (input.planningAssumptions?.status === "unconfirmed") throw new Error("请先确认速度、TCP 包络、动作时间、裕量与安全间隙等规划参数");
  if (input.clearanceThreshold !== undefined && (!Number.isFinite(input.clearanceThreshold) || input.clearanceThreshold < 0)) throw new Error("安全间隙不能为负数");
  for (const value of [input.cycleGoal.tcpSpeedMps, input.cycleGoal.jointSpeedDegPerSec]) if (value !== undefined && !positive(value)) throw new Error("TCP 与关节速度必须大于 0");
  if (input.cycleGoal.tcpRadiusMeters !== undefined && !positive(input.cycleGoal.tcpRadiusMeters)) throw new Error("TCP 包络半径必须大于 0");
  for (const value of [input.cycleGoal.controllerOverheadSec, input.cycleGoal.toolActionSec]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("控制器与工具时间不能为负数");
  const margin = input.cycleGoal.safetyMarginPercent;
  if (margin !== undefined && (!Number.isFinite(margin) || margin < 0 || margin > 200)) throw new Error("节拍裕量必须在 0–200% 之间");
  for (const vector of [input.robot.base, input.robot.currentTcpPosition, ...input.targets.map((item) => item.position), ...input.objects.map((item) => item.position)].filter(Boolean)) {
    if (!finiteVector(vector!)) throw new Error("机器人、目标和对象位置必须是有限数值");
  }
  for (const target of input.targets) {
    if (target.orientationEulerDeg && !finiteVector(target.orientationEulerDeg)) throw new Error("目标姿态必须是有限数值");
    for (const value of [target.processTimeSec, target.settleTimeSec]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("工艺与稳定时间不能为负数");
  }
  validateRobotLoadInput(input);
}

function validateAuditScope(input: RobotWorkcellAssistantInput, audit: WorkcellAuditResult): void {
  const ids = new Set([input.robot.id, ...input.targets.map((item) => item.id), ...input.objects.map((item) => item.id)]);
  const unknownPair = audit.collisionPairs.flatMap((item) => item.objectIds).find((id) => !ids.has(id));
  const unknownReach = audit.reachability.find((item) => item.robotId !== input.robot.id || !ids.has(item.targetId));
  const unknownLoad = audit.loadChecks.find((item) => item.robotId !== input.robot.id || (item.toolObjectId !== undefined && !ids.has(item.toolObjectId)));
  if (unknownPair || unknownReach || unknownLoad) throw new Error("工位审计结果包含当前任务范围外的对象");
}

function validateRobotLoadInput(input: RobotWorkcellAssistantInput): void {
  const capability = input.robot.loadCapability;
  const toolLoad = input.robot.toolLoad;
  if (capability?.ratedPayloadKg !== undefined && !positive(capability.ratedPayloadKg)) throw new Error("额定负载必须大于 0 kg");
  if (capability?.maximumLoadCenterDistanceMeters !== undefined && !positive(capability.maximumLoadCenterDistanceMeters)) throw new Error("重心距离上限必须大于 0 m");
  for (const value of [toolLoad?.toolMassKg, toolLoad?.carriedPayloadKg]) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error("工具与工件质量不能为负数");
  }
  for (const value of [toolLoad?.tcpPositionMeters, toolLoad?.tcpOrientationEulerDeg, toolLoad?.combinedCenterOfMassMeters]) {
    if (value !== undefined && !finiteVector(value)) throw new Error("TCP 与组合重心必须是有限数值");
  }
}

function loadFieldLabel(value: RobotWorkcellAssistantResult["loadScreening"]["missingFields"][number]): string {
  return ({
    "tool-binding": "末端工具绑定",
    "rated-payload": "额定负载",
    "rated-load-center": "组合重心距离上限",
    "capability-source": "额定能力来源",
    "tool-mass": "工具质量",
    "carried-payload": "工件质量",
    "tcp-position": "TCP 位置",
    "tcp-orientation": "TCP 姿态",
    "combined-center-of-mass": "组合重心",
    "tool-load-source": "工具负载来源",
  })[value];
}

function cloneBounds(bounds: NonNullable<RobotWorkcellAssistantInput["robot"]["bounds"]>) { return { min: { ...bounds.min }, max: { ...bounds.max } }; }
function finiteVector(value: { x: number; y: number; z: number }): boolean { return [value.x, value.y, value.z].every(Number.isFinite); }
function positive(value: number | undefined): value is number { return value !== undefined && Number.isFinite(value) && value > 0; }
function vectorDistance(left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }): number { return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z); }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function fingerprint(value: unknown): string {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return `fnv1a64-canonical-v1:${hash.toString(16).padStart(16, "0")}`;
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
