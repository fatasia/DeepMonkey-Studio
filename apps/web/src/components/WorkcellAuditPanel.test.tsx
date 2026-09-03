import type { IndustrialValidationStudyRecord, SceneSnapshot } from "@bim-studio/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkcellAuditPanel } from "./WorkcellAuditPanel";

vi.mock("../api", () => ({
  api: { invokeCapability: vi.fn(), saveValidationStudy: vi.fn() },
}));

const scene = {
  schemaVersion: 1,
  id: "scene-1",
  projectId: "project-1",
  name: "焊装工位",
  camera: {
    position: { x: 0, y: 2, z: 5 },
    target: { x: 0, y: 0, z: 0 },
    mode: "orbit",
  },
  models: [],
  primitives: [{
    modelId: "robot-1",
    name: "机器人",
    kind: "box",
    visible: true,
    opacity: 1,
    color: "#cccccc",
    transform: {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
    },
  }],
  measurements: [],
  createdAt: "2026-08-31T08:00:00.000Z",
  updatedAt: "2026-08-31T08:00:00.000Z",
} satisfies SceneSnapshot;

describe("WorkcellAuditPanel", () => {
  it("restores the latest persisted audit evidence after refresh", () => {
    const study = {
      id: "study-1",
      revision: 4,
      sourceKind: "workcell-audit",
      sceneId: scene.id,
      latestResult: {
        status: "failed",
        scenarioId: "workcell-audit:scene-1",
        evidenceFingerprint: "workcell-evidence-4",
        failureCount: 2,
        completedAt: "2026-08-31T08:00:00.000Z",
      },
    } as IndustrialValidationStudyRecord;

    const html = renderToStaticMarkup(
      <WorkcellAuditPanel
        projectId="project-1"
        scene={scene}
        study={study}
        onOpenTarget={vi.fn()}
      />,
    );

    expect(html).toContain("上次快速验证已留证 · v4");
    expect(html).toContain("2 项待处理");
    expect(html).toContain("workcell-evidence-4");
    expect(html).toContain("系统起步值尚未确认");
    expect(html).toContain("先检查并确认本次规划基准");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="先检查并确认本次规划基准"/);
    expect(html).toContain("场景中尚未确认人工作业");
    expect(html).toContain("添加人工作业");
  });
});
