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
    expect(renderView({ preparation, busy: true })).toContain("正在运行关节限位");
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
      },
      targets: [{ id: "target-1", position: { x: 1.2, y: 0, z: .8 } }],
      objects: [expect.objectContaining({ id: "tool-1", role: "tool" }), expect.objectContaining({ id: "fence-1", role: "obstacle", bounds: expect.any(Object) })],
    });
    // 场景合同没有模型包围盒时保持缺失，不能伪造通用机器人尺寸。
    expect(prepared.input?.robot.bounds).toBeUndefined();
  });

  it("blocks a stale explicit target instead of silently dropping it", () => {
    const scene = sceneFixture();
    scene.models[0]!.rig!.robot!.targetObjectIds = ["target-1", "deleted-target"];
    const prepared = prepareRobotAssistantScene(scene);
    expect(prepared.input).toBeUndefined();
    expect(prepared.issue).toContain("deleted-target");
  });

  it("uses progressive disclosure and exposes review actions without a dispatch action", () => {
    const preparation = prepareRobotAssistantScene(sceneFixture());
    const result = composeRobotWorkcellAssistant(preparation.input!, auditFixture());
    const html = renderView({ preparation, result });
    expect(html).toContain("任务草稿");
    expect(html).toContain("可达性与关节限位");
    expect(html).toContain("碰撞初筛");
    expect(html).toContain("节拍预算");
    expect(html).toContain("缺失证据");
    expect(html).toContain("正式仿真清单");
    expect(html).toContain("保存待复核草稿");
    expect(html).toContain("打开正式仿真");
    expect(html).toContain("AABB 初筛");
    expect(html).not.toMatch(/<button[^>]*>[^<]*下发/);
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
    busy={busy} saving={false} saved={false} error={error}
    onRun={vi.fn()} onSave={vi.fn()} onOpenFormalSimulation={vi.fn()}
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
  return {
    generatedBy: "workcell-validation-plugin", sceneId: "scene-robot", status: "needs-data", summary: "初筛完成",
    inventory: { robot: 1, tool: 1, target: 1, equipment: 0, obstacle: 1, unknown: 0 }, findings: [],
    collisionPairs: [{ objectIds: ["tool-1", "fence-1"], distance: 1.2, intersects: false, required: true }],
    reachability: [{ robotId: "robot-1", targetId: "target-1", distance: 1.44, minimumReach: 0, maximumReach: 2, status: "reachable" }],
    incompleteObjectIds: ["robot-1", "tool-1"], evidenceCoverage: .6, evidenceFingerprint: "a".repeat(64),
    validationDraft: { objective: "验证工位任务", acceptanceCriteria: ["完成 AABB 初筛"], objectIds: ["robot-1", "target-1"] },
  };
}
