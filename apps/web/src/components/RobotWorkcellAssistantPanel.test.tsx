import type { SceneSnapshot, WorkcellAuditResult } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { composeRobotWorkcellAssistant } from "./robotWorkcellAssistant";
import {
  prepareRobotAssistantScene,
  RobotWorkcellAssistantPanelView,
} from "./RobotWorkcellAssistantPanel";

describe("RobotWorkcellAssistantPanel", () => {
  it("shows a useful empty state when no robot chain is configured", () => {
    const html = renderView({ preparation: prepareRobotAssistantScene({ ...sceneFixture(), models: [] }) });
    expect(html).toContain("还不能生成工位任务");
    expect(html).toContain("尚未启用机器人关节链");
    expect(html).toContain("disabled");
  });

  it("renders complete loading and error feedback", () => {
    const preparation = prepareRobotAssistantScene(sceneFixture());
    expect(renderView({ preparation, busy: true })).toContain("正在生成任务并执行快速初筛");
    expect(renderView({ preparation, error: "审计服务超时" })).toContain("审计服务超时");
  });

  it("derives robot, explicit targets, current joint angles and primitive bounds from the scene", () => {
    const prepared = prepareRobotAssistantScene(sceneFixture());
    expect(prepared.issue).toBeUndefined();
    expect(prepared.input).toMatchObject({
      sceneId: "scene-robot",
      robot: {
        id: "robot-1", currentTcpPosition: { x: .3, y: 0, z: 1.2 },
        joints: [{ bonePath: "base/j1", currentAngleDeg: 90 }],
        loadCapability: { ratedPayloadKg: 20, maximumLoadCenterDistanceMeters: .35 },
        toolLoad: { toolMassKg: 4, carriedPayloadKg: 8 },
      },
      targets: [{ id: "target-1", position: { x: 1.2, y: 0, z: .8 } }],
      objects: [expect.objectContaining({ id: "tool-1", role: "tool" }), expect.objectContaining({ id: "fence-1", role: "obstacle", bounds: expect.any(Object) })],
    });
    // 场景合同没有模型包围盒时保持缺失，不能伪造通用机器人尺寸。
    expect(prepared.input?.robot.bounds).toBeUndefined();
    expect(prepared.input?.cycleGoal).toMatchObject({ targetSec: 30, tcpSpeedMps: .5, tcpRadiusMeters: .1, jointSpeedDegPerSec: 90, safetyMarginPercent: 20 });
    expect(prepared.input?.planningAssumptions).toEqual({ origin: "starter-values", status: "unconfirmed" });
  });

  it("blocks a stale explicit target instead of silently dropping it", () => {
    const scene = sceneFixture();
    scene.models[0]!.rig!.robot!.targetObjectIds = ["target-1", "deleted-target"];
    const prepared = prepareRobotAssistantScene(scene);
    expect(prepared.input).toBeUndefined();
    expect(prepared.issue).toContain("deleted-target");
  });

  it("uses progressive disclosure and exposes a truthful control-validation handoff", () => {
    const preparation = prepareRobotAssistantScene(sceneFixture());
    preparation.input!.planningAssumptions = { origin: "starter-values", status: "engineer-confirmed" };
    const result = composeRobotWorkcellAssistant(preparation.input!, auditFixture());
    const html = renderView({ preparation, result });
    expect(html).toContain("任务草稿");
    expect(html).toContain("可达性与关节限位");
    expect(html).toContain("碰撞初筛");
    expect(html).toContain("节拍预算");
    expect(html).toContain("负载与 TCP 规划筛查");
    expect(html).toContain("60.0%");
    expect(html).toContain("缺失证据");
    expect(html).toContain("后续工程校核");
    expect(html).toContain("保存快速初筛");
    expect(html).toContain("验证控制逻辑");
    expect(html).toContain("快速初筛证据不足");
    expect(html).toContain("AABB 初筛");
    expect(html).toContain("机器人轨迹快速初筛");
    expect(html).toContain("轨迹时间轴");
    expect(html).toContain("尚不驱动机器人骨骼");
    expect(html).toContain("不会把未完成的几何校核判为通过");
    expect(html).not.toContain("打开正式仿真");
    expect(html).not.toMatch(/<button[^>]*>[^<]*下发/);
  });

  it("exposes editable validation and per-target timing parameters before running", () => {
    const preparation = prepareRobotAssistantScene(sceneFixture());
    const html = renderToStaticMarkup(<RobotWorkcellAssistantPanelView
      preparation={preparation} busy={false} saving={false} continuing={false} saved={false} error=""
      onRun={vi.fn()} onSave={vi.fn()} onContinueValidation={vi.fn()} onInputChange={vi.fn()}
    />);
    expect(html).toContain("验证参数");
    expect(html).toContain("目标节拍");
    expect(html).toContain("TCP 速度");
    expect(html).toContain("TCP 包络半径");
    expect(html).toContain("安全间隙");
    expect(html).toContain("负载与 TCP 规划参数");
    expect(html).toContain("工具质量");
    expect(html).toContain("组合重心");
    expect(html).toContain("工艺点与路径序列");
    expect(html).toContain("拖动或 Alt + ↑↓ 调整顺序");
    expect(html).toContain("动作");
    expect(html).toContain("移动 + 工艺");
    expect(html).toContain("上移 装配目标");
    expect(html).toContain("删除 装配目标");
    expect(html).toContain("装配目标");
    expect(html).toContain("待确认起步参数");
    expect(html).toContain("生成任务并验证");
    expect(html).toContain("即确认其仅用于本次规划初筛");
    expect(html).not.toMatch(/class="robot-assistant-run"[^>]*disabled/);
    expect((html.match(/type="number"/g) ?? []).length).toBeGreaterThanOrEqual(10);
  });
});

function renderView({ preparation, result, busy = false, error = "" }: {
  preparation: ReturnType<typeof prepareRobotAssistantScene>;
  result?: ReturnType<typeof composeRobotWorkcellAssistant>;
  busy?: boolean;
  error?: string;
}) {
  return renderToStaticMarkup(<RobotWorkcellAssistantPanelView
    preparation={preparation} {...(result ? { result } : {})}
    busy={busy} saving={false} continuing={false} saved={false} error={error}
    onRun={vi.fn()} onSave={vi.fn()} onContinueValidation={vi.fn()}
  />);
}

function sceneFixture(): SceneSnapshot {
  const transform = (x: number, y: number, z: number) => ({
    position: { x, y, z }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 },
  });
  return {
    schemaVersion: 1, id: "scene-robot", projectId: "project-1", name: "装配工位",
    camera: { position: { x: 4, y: 3, z: 4 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [
      {
        modelId: "robot-1", name: "六轴机器人", visible: true, opacity: 1, transform: transform(0, 0, 0),
        rig: {
          bones: [{ bonePath: "base/j1", rotation: { x: 0, y: 0, z: Math.PI / 2 } }], ik: [],
          robot: {
            enabled: true, baseBonePath: "base", toolObjectId: "tool-1", targetObjectIds: ["target-1"],
            joints: [{ bonePath: "base/j1", name: "J1", axis: "z", length: 2, minAngleDeg: -180, maxAngleDeg: 180 }],
            loadCapability: { ratedPayloadKg: 20, maximumLoadCenterDistanceMeters: .35, source: "configured-prefab" },
            toolLoad: {
              toolMassKg: 4, carriedPayloadKg: 8,
              tcpPositionMeters: { x: 0, y: 0, z: .25 }, tcpOrientationEulerDeg: { x: 0, y: 90, z: 0 },
              combinedCenterOfMassMeters: { x: 0, y: 0, z: .2 }, source: "author-confirmed",
            },
          },
        },
      },
      { modelId: "tool-1", name: "末端工具", visible: true, opacity: 1, transform: transform(.3, 0, 1.2) },
    ],
    primitives: [
      { modelId: "target-1", name: "装配目标", visible: true, opacity: 1, kind: "box", color: "#fff", transform: transform(1.2, 0, .8) },
      { modelId: "fence-1", name: "安全围栏", visible: true, opacity: 1, kind: "box", color: "#fff", transform: transform(3, 0, 1) },
    ],
    measurements: [], createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z",
  };
}

function auditFixture(): WorkcellAuditResult {
  const trajectoryDuration = Math.hypot(.9, .4) / .5;
  return {
    generatedBy: "workcell-validation-plugin", sceneId: "scene-robot", status: "needs-data", summary: "初筛完成",
    inventory: { robot: 1, tool: 1, target: 1, equipment: 0, obstacle: 1, unknown: 0 }, findings: [],
    collisionPairs: [{ objectIds: ["tool-1", "fence-1"], distance: 1.2, intersects: false, required: true }],
    reachability: [{ robotId: "robot-1", targetId: "target-1", distance: 1.44, minimumReach: 0, maximumReach: 2, status: "reachable" }],
    loadChecks: [{
      robotId: "robot-1", toolObjectId: "tool-1", status: "within-planning-envelope", violations: [], missingFields: [],
      ratedPayloadKg: 20, totalLoadKg: 12, payloadUtilization: .6,
      maximumLoadCenterDistanceMeters: .35, loadCenterDistanceMeters: .2, loadCenterUtilization: .2 / .35,
      tcpOffsetDistanceMeters: .25, evidenceCoverage: 1, capabilitySource: "configured-prefab", toolLoadSource: "author-confirmed",
      declaration: "仅做规划筛查，不替代动力学。",
    }],
    trajectoryAnalysis: {
      method: "piecewise-linear-tcp-sphere-aabb-v1", approximation: "conservative-broad-phase",
      declaration: "连续检查仅覆盖分段线性 TCP 包围球。", precisionStatus: "partial",
      jointChecks: [],
      segmentChecks: [{
        trajectoryId: "assistant-path:robot-1", segmentId: "assistant-path:robot-1:0-1",
        startTimeSec: 0, endTimeSec: trajectoryDuration, lengthMeters: Math.hypot(.9, .4), potentialObstacleIds: [],
      }],
      avoidanceCandidates: [], scheduleConflicts: [],
      cycle: { trajectories: [{ trajectoryId: "assistant-path:robot-1", robotId: "robot-1", durationSec: trajectoryDuration, pathLengthMeters: Math.hypot(.9, .4), averageTcpSpeedMps: .5 }], scheduleSpanSec: trajectoryDuration, maxConcurrentRobots: 1 },
    },
    incompleteObjectIds: ["robot-1", "tool-1"], evidenceCoverage: .6, evidenceFingerprint: "a".repeat(64),
    validationDraft: { objective: "验证工位任务", acceptanceCriteria: ["完成 AABB 初筛"], objectIds: ["robot-1", "target-1"] },
  };
}
