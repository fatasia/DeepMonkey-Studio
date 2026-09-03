import type { IndustrialValidationStudyRecord, SceneSnapshot } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { VirtualCommissioningWorkbench } from "./VirtualCommissioningWorkbench";

describe("VirtualCommissioningWorkbench product flow", () => {
  it("starts with object selection and only one primary action", () => {
    const html = renderToStaticMarkup(<VirtualCommissioningWorkbench
      projectId="project-1"
      scenes={[sceneFixture()]}
      onOpenTarget={vi.fn()}
    />);

    expect(html).toContain("选择验证对象");
    expect(html).toContain("工位");
    expect(html).toContain("六轴机器人");
    expect(html).toContain("检查任务");
    expect(html.match(/<button/g) ?? []).toHaveLength(1);
    expect(html).not.toContain("机器人工位快速验证");
    expect(html).not.toContain("工位验证流程");
    expect(html).not.toContain('id="commissioning-control-validation"');
    expect(html).not.toContain("自定义用例");
    expect(html).not.toContain("打开正式仿真");
    expect(html).not.toContain("commissioning-formal-simulation");
  });

  it("reopens a generic workcell record without silently switching to a robot task", () => {
    const scene = sceneFixture();
    const study = {
      id: "workcell-study-1", projectId: "project-1", revision: 2, title: "装配工位体检",
      sourceKind: "workcell-audit", studyType: "workcell-audit",
      sceneId: scene.id, objectIds: ["robot-1"], sourceRefs: [],
      objective: "检查当前工位", acceptanceCriteria: ["无阻断项"], status: "failed",
      execution: { engineId: "manufacturing.workcell.audit", engineVersion: "1.1.0", inputFingerprint: "input-1", deterministic: true },
      latestResult: { status: "failed", scenarioId: "workcell-audit:scene-1", evidenceFingerprint: "evidence-1", failureCount: 1, completedAt: "2026-09-03T00:00:00.000Z" },
      createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z",
    } satisfies IndustrialValidationStudyRecord;
    const html = renderToStaticMarkup(<VirtualCommissioningWorkbench
      projectId="project-1" scenes={[scene]} initialStudy={study} onOpenTarget={vi.fn()}
    />);

    expect(html).toContain("检查当前工位");
    expect(html).toContain('class="active attention"');
    expect(html).not.toContain("机器人工位快速验证");
  });
});

function sceneFixture(): SceneSnapshot {
  const transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } };
  return {
    schemaVersion: 1, id: "scene-1", projectId: "project-1", name: "装配工位",
    camera: { position: { x: 3, y: 3, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [{
      modelId: "robot-1", name: "六轴机器人", visible: true, opacity: 1, transform,
      rig: {
        bones: [], ik: [],
        robot: {
          enabled: true, baseBonePath: "root", targetObjectIds: ["target-1"],
          joints: [{ bonePath: "root/j1", name: "J1", axis: "z", length: 2, minAngleDeg: -180, maxAngleDeg: 180 }],
        },
      },
    }],
    primitives: [{ modelId: "target-1", name: "装配目标", kind: "box", color: "#5a8f91", visible: true, opacity: 1, transform }],
    measurements: [], createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z",
  };
}
