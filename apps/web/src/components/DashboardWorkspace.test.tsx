import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { calculateDashboardEditorZoom, calculateDashboardRuntimeViewport, DashboardWorkspace, snapDashboardFrame } from "./DashboardWorkspace";

vi.mock("./DashboardWidgetRuntime", () => ({
  DashboardWidgetView: () => null,
  useDashboardMetrics: () => ({ metrics: {}, datasets: [], pipelines: [], fieldsByProduct: {}, statusByProduct: {}, connected: false }),
  widgetBackground: () => "transparent"
}));

vi.mock("./SceneViewportPreview", () => ({ SceneViewportPreview: () => null }));

vi.mock("./ProfessionalCodeEditor", () => ({ ProfessionalCodeEditor: () => null }));

const application = migrateSceneSnapshotV1(pureFixture as SceneSnapshot);
const project: ProjectRecord = {
  id: application.metadata.projectId,
  name: "大屏项目",
  description: "",
  models: [],
  createdAt: application.metadata.createdAt,
  updatedAt: application.metadata.updatedAt
};

describe("DashboardWorkspace", () => {
  it("fits the entire logical dashboard into the editor viewport", () => {
    expect(calculateDashboardEditorZoom({ width: 3840, height: 2160 }, 1280, 720)).toBe(0.294);
    expect(calculateDashboardEditorZoom({ width: 320, height: 320 }, 1920, 1080)).toBe(2);
  });

  it("calculates contain, cover, stretch, and fixed large-screen fit modes", () => {
    const page = { width: 3840, height: 1080 };

    expect(calculateDashboardRuntimeViewport({ ...page, viewportFit: "contain" }, 1952, 1112)).toMatchObject({ scaleX: 1952 / 3840, scaleY: 1952 / 3840, stageWidth: 1952, stageHeight: 549, offsetX: 0 });
    const cover = calculateDashboardRuntimeViewport({ ...page, viewportFit: "cover" }, 1952, 1112);
    expect(cover.scaleX).toBeCloseTo(1112 / 1080);
    expect(cover.stageWidth).toBe(1952);
    expect(cover.stageHeight).toBe(1112);
    expect(cover.offsetX).toBeCloseTo((1952 - 3840 * (1112 / 1080)) / 2);
    expect(calculateDashboardRuntimeViewport({ ...page, viewportFit: "stretch" }, 1952, 1112)).toMatchObject({ scaleX: 1952 / 3840, scaleY: 1112 / 1080, stageWidth: 1952, stageHeight: 1112 });
    expect(calculateDashboardRuntimeViewport({ ...page, viewportFit: "fixed" }, 1952, 1112)).toMatchObject({ scaleX: 1, scaleY: 1, stageWidth: 3840, stageHeight: 1080 });
  });

  it("snaps move and resize frames to guides and component edges", () => {
    expect(snapDashboardFrame({ x: 96, y: 194, width: 100, height: 80 }, "move", [200], [200], 6)).toEqual({ frame: { x: 100, y: 200, width: 100, height: 80 }, lines: { x: [200], y: [200] } });
    expect(snapDashboardFrame({ x: 20, y: 30, width: 176, height: 166 }, "resize", [200], [200], 6)).toEqual({ frame: { x: 20, y: 30, width: 180, height: 170 }, lines: { x: [200], y: [200] } });
  });

  it("renders user-defined large-screen resolution controls and overflow diagnostics", () => {
    const page = application.pages[0]!;
    page.width = 3840;
    page.height = 1080;
    page.viewportFit = "contain";
    page.nodes[0]!.frame.x = 3900;

    const html = renderToStaticMarkup(<DashboardWorkspace
      locale="zh-CN"
      application={application}
      project={project}
      page={page}
      rendererBackend="webgl"
      dirty={false}
      canUndo={false}
      canRedo={false}
      busy={false}
      selection={[]}
      variables={{}}
      onBack={() => undefined}
      onSelectPage={() => undefined}
      onEnterScene={() => undefined}
      onOpenTopology={() => undefined}
      onOpenData={() => undefined}
      onSelectionChange={() => undefined}
      onObjectInteraction={() => undefined}
      onNodeInteraction={() => undefined}
      onCommand={() => undefined}
      onUndo={() => undefined}
      onRedo={() => undefined}
      onSave={() => undefined}
      onPublish={() => undefined}
      onViewStateChange={() => undefined}
    />);

    expect(html).toContain("双联大屏 · 3840 × 1080");
    expect(html).toContain("逻辑分辨率");
    expect(html).toContain("完整显示（推荐）");
    expect(html).toContain("1 个组件越界");
    expect(html).toContain('aria-label="页面宽度"');
  });
});
