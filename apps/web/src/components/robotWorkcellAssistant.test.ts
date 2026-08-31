import { describe, expect, it, vi } from "vitest";
import type { WorkcellAuditInput, WorkcellAuditResult } from "@bim-studio/contracts";
import { buildRobotWorkcellAuditInput, composeRobotWorkcellAssistant, runRobotWorkcellAssistant } from "./robotWorkcellAssistant";
import type { RobotWorkcellAssistantInput } from "./robotWorkcellAssistantTypes";

describe("robot workcell assistant orchestrator", () => {
  it("reuses the standard WorkcellAudit input and keeps the task non-dispatchable", async () => {
    const input = completeInput();
    const auditInput = buildRobotWorkcellAuditInput(input);
    const runner = vi.fn(async (_request: WorkcellAuditInput) => passedAudit());
    const result = await runRobotWorkcellAssistant(input, runner);

    expect(runner).toHaveBeenCalledWith(auditInput);
    expect(auditInput.objects[0]).toMatchObject({
      id: "robot-1", role: "robot",
      robot: { links: [{ id: "base/j1", minAngleDeg: -180, maxAngleDeg: 180 }, { id: "base/j1/j2" }], targetObjectIds: ["target-1"] },
    });
    expect(result).toMatchObject({
      status: "ready-for-formal-simulation",
      taskDraft: { status: "draft", controllerProgramGenerated: false },
      confirmationPolicy: { automaticDispatch: false, requiresRobotProgrammer: true, requiresSafetyReview: true },
      collisionScreening: { method: "static-world-aabb-screen", status: "no-aabb-conflict-detected" },
      cycleBudget: { status: "planned-budget-within-target", motionAndProcessLowerBoundSec: 4.2, plannedBudgetSec: 4.62, slackSec: 5.38, completeness: 1 },
    });
    expect(result.taskDraft.steps).toHaveLength(3);
    expect(result.taskDraft.steps.every((item) => item.dispatchable === false)).toBe(true);
    expect(result.collisionScreening.declaration).toContain("不等于网格");
    expect(result.evidenceFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
  });

  it("blocks an out-of-limit waypoint even when the reach envelope is satisfied", () => {
    const input = completeInput();
    input.targets[0] = { ...input.targets[0]!, jointAnglesDeg: [220, 45] };
    const result = composeRobotWorkcellAssistant(input, passedAudit());
    expect(result.status).toBe("blocked");
    expect(result.jointLimits).toEqual(expect.arrayContaining([expect.objectContaining({ waypointId: "target-1", jointId: "base/j1", status: "outside-limit" })]));
    expect(result.formalSimulationItems).toContain("调整目标位姿后重新求解并验证全部关节限位");
  });

  it("blocks an AABB hit but explicitly leaves exact collision to formal simulation", () => {
    const audit = passedAudit();
    audit.status = "failed";
    audit.collisionPairs[0] = { objectIds: ["robot-1", "fence-1"], distance: 0, intersects: true, required: true };
    const result = composeRobotWorkcellAssistant(completeInput(), audit);
    expect(result).toMatchObject({ status: "blocked", collisionScreening: { status: "aabb-conflict" } });
    expect(result.formalSimulationItems).toContain("对 AABB 相交对象执行精确网格干涉与最小距离分析");
    expect(result.collisionScreening.declaration).toContain("连续扫掠路径");
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
  });
});

function completeInput(): RobotWorkcellAssistantInput {
  return {
    sceneId: "scene-1", taskName: "取放循环",
    robot: {
      id: "robot-1", name: "六轴机器人", baseBonePath: "base", base: { x: 0, y: 0, z: 0 }, currentTcpPosition: { x: 0, y: 0, z: 0 },
      bounds: { min: { x: -.5, y: -.5, z: 0 }, max: { x: .5, y: .5, z: 1 } },
      joints: [
        { bonePath: "base/j1", name: "J1", axis: "z", length: 1, minAngleDeg: -180, maxAngleDeg: 180, currentAngleDeg: 0 },
        { bonePath: "base/j1/j2", name: "J2", axis: "y", length: 1, minAngleDeg: -120, maxAngleDeg: 120, currentAngleDeg: 0 },
      ],
    },
    targets: [{
      id: "target-1", name: "取料点", position: { x: 1, y: 0, z: 0 }, orientationEulerDeg: { x: 180, y: 0, z: 0 },
      jointAnglesDeg: [30, 45], processTimeSec: 2, settleTimeSec: .5,
    }],
    objects: [{ id: "fence-1", name: "安全围栏", role: "obstacle", position: { x: 3, y: 0, z: 0 }, bounds: { min: { x: 2.8, y: -.2, z: 0 }, max: { x: 3.2, y: .2, z: 2 } } }],
    cycleGoal: { targetSec: 10, tcpSpeedMps: 1, jointSpeedDegPerSec: 90, controllerOverheadSec: .2, toolActionSec: .5, safetyMarginPercent: 10 },
    clearanceThreshold: .25,
  };
}

function passedAudit(): WorkcellAuditResult {
  return {
    generatedBy: "workcell-validation-plugin", status: "passed", sceneId: "scene-1", summary: "AABB 初筛完成",
    inventory: { robot: 1, tool: 0, target: 1, equipment: 0, obstacle: 1, unknown: 0 }, findings: [],
    collisionPairs: [{ objectIds: ["robot-1", "fence-1"], distance: 2.3, intersects: false, required: true }],
    reachability: [{ robotId: "robot-1", targetId: "target-1", distance: 1, minimumReach: 0, maximumReach: 2, status: "reachable" }],
    incompleteObjectIds: [], evidenceCoverage: 1, evidenceFingerprint: "a".repeat(64),
    validationDraft: { objective: "验证工位", acceptanceCriteria: ["AABB 初筛"], objectIds: ["robot-1", "target-1"] },
  };
}
