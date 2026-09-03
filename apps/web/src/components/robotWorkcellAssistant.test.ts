import { describe, expect, it, vi } from "vitest";
import type { WorkcellAuditInput, WorkcellAuditResult } from "@bim-studio/contracts";
import { buildRobotWorkcellAuditInput, composeRobotWorkcellAssistant, runRobotWorkcellAssistant } from "./robotWorkcellAssistant";
import type { RobotWorkcellAssistantInput } from "./robotWorkcellAssistantTypes";

describe("robot workcell assistant orchestrator", () => {
  it("reuses the standard WorkcellAudit input and keeps the task non-dispatchable", async () => {
    const input = completeInput();
    const auditInput = buildRobotWorkcellAuditInput(input);
    const audit = passedAudit();
    const runner = vi.fn(async (_request: WorkcellAuditInput) => audit);
    const result = await runRobotWorkcellAssistant(input, runner);

    expect(runner).toHaveBeenCalledWith(auditInput);
    expect(auditInput.objects[0]).toMatchObject({
      id: "robot-1", role: "robot",
      robot: {
        links: [{ id: "base/j1", minAngleDeg: -180, maxAngleDeg: 180 }, { id: "base/j1/j2" }],
        targetObjectIds: ["target-1"],
        loadCapability: { ratedPayloadKg: 20 },
        toolLoad: { toolMassKg: 4, carriedPayloadKg: 8 },
      },
    });
    expect(auditInput).toMatchObject({
      planningAssumptions: {
        origin: "authored",
        status: "engineer-confirmed",
        generatedTrajectorySpeedMps: 1,
        generatedTrajectoryTcpRadiusMeters: .1,
      },
      trajectories: [{ tcpRadius: .1 }],
    });
    expect(result).toMatchObject({
      status: "ready-for-control-validation",
      taskDraft: { robotId: "robot-1", status: "draft", controllerProgramGenerated: false },
      confirmationPolicy: { automaticDispatch: false, requiresRobotProgrammer: true, requiresSafetyReview: true },
      collisionScreening: { method: "static-world-aabb-screen", status: "no-aabb-conflict-detected" },
      cycleBudget: { status: "planned-budget-within-target", motionAndProcessLowerBoundSec: 4.2, plannedBudgetSec: 4.62, slackSec: 5.38, completeness: 1 },
      loadScreening: { status: "within-planning-envelope", totalLoadKg: 12, payloadUtilization: .6 },
    });
    expect(result.taskDraft.steps).toHaveLength(3);
    expect(result.taskDraft.steps.every((item) => item.dispatchable === false)).toBe(true);
    expect(result.collisionScreening.declaration).toContain("不等于网格");
    expect(result.remainingEngineeringChecks).toEqual(expect.arrayContaining([
      expect.stringContaining("完整 IK"),
      expect.stringContaining("网格级连续扫掠碰撞"),
    ]));
    expect(result.evidenceFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
  });

  it("retains the matching trajectory evidence for result playback without upgrading partial precision", () => {
    const audit = passedAudit();
    audit.trajectoryAnalysis = trajectoryAnalysis();
    const result = composeRobotWorkcellAssistant(completeInput(), audit);

    expect(result.status).toBe("needs-data");
    expect(result.workcellAudit.trajectoryAnalysis).toEqual(audit.trajectoryAnalysis);
    expect(result.workcellAudit.trajectoryAnalysis).not.toBe(audit.trajectoryAnalysis);
    expect(result.missingEvidence).toContain("轨迹位置或时间精度未完整声明");
  });

  it("blocks an out-of-limit waypoint even when the reach envelope is satisfied", () => {
    const input = completeInput();
    input.targets[0] = { ...input.targets[0]!, jointAnglesDeg: [220, 45] };
    const result = composeRobotWorkcellAssistant(input, passedAudit());
    expect(result.status).toBe("blocked");
    expect(result.jointLimits).toEqual(expect.arrayContaining([expect.objectContaining({ waypointId: "target-1", jointId: "base/j1", status: "outside-limit" })]));
    expect(result.remainingEngineeringChecks).toContain("调整目标位姿后重新求解并验证全部关节限位");
  });

  it("blocks an AABB hit and leaves exact collision as a visible engineering check", () => {
    const audit = passedAudit();
    audit.status = "failed";
    audit.collisionPairs[0] = { objectIds: ["robot-1", "fence-1"], distance: 0, intersects: true, required: true };
    const result = composeRobotWorkcellAssistant(completeInput(), audit);
    expect(result).toMatchObject({ status: "blocked", collisionScreening: { status: "aabb-conflict" } });
    expect(result.remainingEngineeringChecks).toContain("对 AABB 相交对象执行精确网格干涉与最小距离分析");
    expect(result.collisionScreening.declaration).toContain("连续扫掠路径");
  });

  it("blocks a proven planning overload without claiming a dynamics result", () => {
    const audit = passedAudit();
    audit.status = "failed";
    audit.loadChecks[0] = {
      ...audit.loadChecks[0]!,
      status: "exceeds-planning-envelope",
      violations: ["payload"],
      totalLoadKg: 24,
      payloadUtilization: 1.2,
    };
    const result = composeRobotWorkcellAssistant(completeInput(), audit);

    expect(result).toMatchObject({
      status: "blocked",
      loadScreening: { status: "exceeds-planning-envelope", violations: ["payload"] },
    });
    expect(result.remainingEngineeringChecks).toContain("按厂商负载曲线复核腕部力矩、惯量、加减速与动态工况");
  });

  it("reports missing evidence instead of inventing limits, collision or cycle conclusions", () => {
    const input = completeInput();
    delete input.robot.bounds;
    delete input.robot.currentTcpPosition;
    input.robot.joints = input.robot.joints.map(({ currentAngleDeg: _angle, ...joint }) => joint);
    const { jointAnglesDeg: _jointAngles, orientationEulerDeg: _orientation, ...targetWithoutPose } = input.targets[0]!;
    input.targets[0] = targetWithoutPose;
    input.cycleGoal = { targetSec: 10 };
    const audit = passedAudit();
    audit.status = "needs-data";
    audit.incompleteObjectIds = ["robot-1"];
    audit.reachability = [];
    audit.evidenceCoverage = .35;
    const result = composeRobotWorkcellAssistant(input, audit);
    expect(result.status).toBe("needs-data");
    expect(result.cycleBudget).toMatchObject({ status: "needs-data", completeness: 0 });
    expect(result.missingEvidence).toEqual(expect.arrayContaining([
      "机器人本体缺少世界包围盒，无法完成静态障碍初筛",
      "缺少当前位姿或目标关节角，无法完成全部限位检查",
      "部分目标缺少末端姿态约束",
      "未提供 TCP 或关节速度",
    ]));
  });

  it("propagates absent payload and TCP evidence as needs-data", () => {
    const input = completeInput();
    delete input.robot.loadCapability;
    delete input.robot.toolLoad;
    const audit = passedAudit();
    audit.status = "needs-data";
    audit.loadChecks[0] = {
      robotId: "robot-1", toolObjectId: "tool-1", status: "needs-data", violations: [],
      missingFields: ["rated-payload", "tool-mass", "tcp-position", "combined-center-of-mass"],
      evidenceCoverage: .2, declaration: "缺少数据时不输出通过结论。",
    };
    const result = composeRobotWorkcellAssistant(input, audit);

    expect(result.status).toBe("needs-data");
    expect(result.loadScreening).not.toHaveProperty("totalLoadKg");
    expect(result.missingEvidence).toEqual(expect.arrayContaining([
      "负载/TCP待补充：额定负载",
      "负载/TCP待补充：工具质量",
      "负载/TCP待补充：TCP 位置",
      "负载/TCP待补充：组合重心",
    ]));
  });

  it("marks a budget overrun as an estimate, not a controller proof", () => {
    const input = completeInput();
    input.cycleGoal.targetSec = 3;
    const result = composeRobotWorkcellAssistant(input, passedAudit());
    expect(result.cycleBudget).toMatchObject({ status: "planned-budget-over-target", plannedBudgetSec: 4.62 });
    expect(result.cycleBudget.declaration).toContain("不是控制器级节拍承诺");
  });

  it("rejects an audit result containing objects outside the current task", () => {
    const audit = passedAudit();
    audit.reachability.push({ robotId: "other-robot", targetId: "target-1", distance: 1, minimumReach: 0, maximumReach: 2, status: "reachable" });
    expect(() => composeRobotWorkcellAssistant(completeInput(), audit)).toThrow("当前任务范围外");
  });

  it("keeps the fingerprint stable and sensitive to task evidence", () => {
    const first = composeRobotWorkcellAssistant(completeInput(), passedAudit());
    const second = composeRobotWorkcellAssistant(structuredClone(completeInput()), structuredClone(passedAudit()));
    const changedInput = completeInput();
    changedInput.targets[0]!.processTimeSec = 3;
    const changed = composeRobotWorkcellAssistant(changedInput, passedAudit());
    expect(first.evidenceFingerprint).toBe(second.evidenceFingerprint);
    expect(changed.evidenceFingerprint).not.toBe(first.evidenceFingerprint);
  });

  it("rejects unsafe or nonsensical task inputs before the audit call", async () => {
    const input = completeInput();
    input.cycleGoal.targetSec = 0;
    const runner = vi.fn(async () => passedAudit());
    await expect(runRobotWorkcellAssistant(input, runner)).rejects.toThrow("节拍目标");
    expect(runner).not.toHaveBeenCalled();

    const invalidClearance = completeInput();
    invalidClearance.clearanceThreshold = -0.1;
    await expect(runRobotWorkcellAssistant(invalidClearance, runner)).rejects.toThrow("安全间隙");
    expect(runner).not.toHaveBeenCalled();

    const unconfirmedStarter = completeInput();
    unconfirmedStarter.planningAssumptions = { origin: "starter-values", status: "unconfirmed" };
    await expect(runRobotWorkcellAssistant(unconfirmedStarter, runner)).rejects.toThrow("请先确认");
    expect(runner).not.toHaveBeenCalled();
  });

  it("does not invent a minimum motion duration for a colocated target", () => {
    const input = completeInput();
    input.targets[0]!.position = { ...input.robot.currentTcpPosition! };

    expect(buildRobotWorkcellAuditInput(input).trajectories).toBeUndefined();
  });

  it("uses only enabled points, in authored order, for the existing trajectory and task draft", () => {
    const input = completeInput();
    const { settleTimeSec: _settle, ...processTarget } = input.targets[0]!;
    input.targets = [
      { id: "target-disabled", name: "停用点", position: { x: 4, y: 0, z: 0 }, enabled: false },
      { ...processTarget, id: "target-1", name: "工艺点", processTimeSec: 2 },
      { id: "target-2", name: "等待点", position: { x: 2, y: 0, z: 0 }, settleTimeSec: 3 },
    ];
    const audit = passedAudit();
    audit.reachability.push({ robotId: "robot-1", targetId: "target-2", distance: 2, minimumReach: 0, maximumReach: 2, status: "reachable" });

    const auditInput = buildRobotWorkcellAuditInput(input);
    const result = composeRobotWorkcellAssistant(input, audit);

    expect(auditInput.objects[0]?.robot?.targetObjectIds).toEqual(["target-1", "target-2"]);
    expect(auditInput.trajectories?.[0]?.waypoints.map((item) => item.id)).toEqual(["current", "target-1", "target-2"]);
    expect(result.taskDraft.steps.map((item) => [item.targetId, item.type])).toEqual([
      ["target-1", "move-to-target"], ["target-1", "execute-process"],
      ["target-1", "verify-result"],
      ["target-2", "move-to-target"], ["target-2", "verify-result"],
    ]);
    expect(result.cycleBudget.lines.some((item) => item.id.includes("target-disabled"))).toBe(false);
  });
});

function completeInput(): RobotWorkcellAssistantInput {
  return {
    sceneId: "scene-1", taskName: "取放循环",
    robot: {
      id: "robot-1", name: "六轴机器人", baseBonePath: "base", base: { x: 0, y: 0, z: 0 }, currentTcpPosition: { x: 0, y: 0, z: 0 },
      bounds: { min: { x: -.5, y: -.5, z: 0 }, max: { x: .5, y: .5, z: 1 } },
      toolObjectId: "tool-1",
      loadCapability: { ratedPayloadKg: 20, maximumLoadCenterDistanceMeters: .35, source: "configured-prefab" },
      toolLoad: {
        toolMassKg: 4, carriedPayloadKg: 8,
        tcpPositionMeters: { x: 0, y: 0, z: .25 }, tcpOrientationEulerDeg: { x: 0, y: 90, z: 0 },
        combinedCenterOfMassMeters: { x: 0, y: 0, z: .2 }, source: "author-confirmed",
      },
      joints: [
        { bonePath: "base/j1", name: "J1", axis: "z", length: 1, minAngleDeg: -180, maxAngleDeg: 180, currentAngleDeg: 0 },
        { bonePath: "base/j1/j2", name: "J2", axis: "y", length: 1, minAngleDeg: -120, maxAngleDeg: 120, currentAngleDeg: 0 },
      ],
    },
    targets: [{
      id: "target-1", name: "取料点", position: { x: 1, y: 0, z: 0 }, orientationEulerDeg: { x: 180, y: 0, z: 0 },
      jointAnglesDeg: [30, 45], processTimeSec: 2, settleTimeSec: .5,
    }],
    objects: [
      { id: "tool-1", name: "抓手", role: "tool", position: { x: 0, y: 0, z: 0 }, bounds: { min: { x: -.1, y: -.1, z: -.1 }, max: { x: .1, y: .1, z: .1 } } },
      { id: "fence-1", name: "安全围栏", role: "obstacle", position: { x: 3, y: 0, z: 0 }, bounds: { min: { x: 2.8, y: -.2, z: 0 }, max: { x: 3.2, y: .2, z: 2 } } },
    ],
    cycleGoal: { targetSec: 10, tcpSpeedMps: 1, tcpRadiusMeters: .1, jointSpeedDegPerSec: 90, controllerOverheadSec: .2, toolActionSec: .5, safetyMarginPercent: 10 },
    clearanceThreshold: .25,
    planningAssumptions: { origin: "authored", status: "engineer-confirmed" },
  };
}

function passedAudit(): WorkcellAuditResult {
  return {
    generatedBy: "workcell-validation-plugin", status: "passed", sceneId: "scene-1", summary: "AABB 初筛完成",
    inventory: { robot: 1, tool: 1, target: 1, equipment: 0, obstacle: 1, unknown: 0 }, findings: [],
    collisionPairs: [{ objectIds: ["robot-1", "fence-1"], distance: 2.3, intersects: false, required: true }],
    reachability: [{ robotId: "robot-1", targetId: "target-1", distance: 1, minimumReach: 0, maximumReach: 2, status: "reachable" }],
    loadChecks: [{
      robotId: "robot-1", toolObjectId: "tool-1", status: "within-planning-envelope", violations: [], missingFields: [],
      ratedPayloadKg: 20, totalLoadKg: 12, payloadUtilization: .6,
      maximumLoadCenterDistanceMeters: .35, loadCenterDistanceMeters: .2, loadCenterUtilization: .2 / .35,
      tcpOffsetDistanceMeters: .25, evidenceCoverage: 1, capabilitySource: "configured-prefab", toolLoadSource: "author-confirmed",
      declaration: "仅做规划筛查。",
    }],
    incompleteObjectIds: [], evidenceCoverage: 1, evidenceFingerprint: "a".repeat(64),
    validationDraft: { objective: "验证工位", acceptanceCriteria: ["AABB 初筛"], objectIds: ["robot-1", "target-1"] },
  };
}

function trajectoryAnalysis(): NonNullable<WorkcellAuditResult["trajectoryAnalysis"]> {
  return {
    method: "piecewise-linear-tcp-sphere-aabb-v1", approximation: "conservative-broad-phase",
    declaration: "连续检查仅覆盖分段线性 TCP 包围球。", precisionStatus: "partial",
    jointChecks: [],
    segmentChecks: [{ trajectoryId: "assistant-path:robot-1", segmentId: "assistant-path:robot-1:0-1", startTimeSec: 0, endTimeSec: 1, lengthMeters: 1, potentialObstacleIds: [] }],
    avoidanceCandidates: [], scheduleConflicts: [],
    cycle: { trajectories: [{ trajectoryId: "assistant-path:robot-1", robotId: "robot-1", durationSec: 1, pathLengthMeters: 1, averageTcpSpeedMps: 1 }], scheduleSpanSec: 1, maxConcurrentRobots: 1 },
  };
}
