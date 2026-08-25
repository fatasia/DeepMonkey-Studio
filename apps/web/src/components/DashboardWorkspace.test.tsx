import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { calculateDashboardRuntimeViewport, DashboardWorkspace } from "./DashboardWorkspace";

vi.mock("./DashboardWidgetRuntime", () => ({
  DashboardWidgetView: () => null,
  useDashboardMetrics: () => ({ metrics: {}, datasets: [], pipelines: [], fieldsByProduct: {}, statusByProduct: {}, connected: false }),
  widgetBackground: () => "transparent"
}));

vi.mock("./SceneViewportPreview", () => ({ SceneViewportPreview: () => null }));

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
  it("calculates contain, cover, stretch, and fixed large-screen fit modes", () => {
    const page = { width: 3840, height: 1080 };

    expect(calculateDashboardRuntimeViewport({ ...page, viewportFit: "contain" }, 1952, 1112)).toMatchObject({ scaleX: 0.5, scaleY: 0.5, stageWidth: 1920, stageHeight: 540, offsetX: 0 });
    expect(calculateDashboardRuntimeViewport({ ...page, viewportFit: "cover" }, 1952, 1112)).toMatchObject({ scaleX: 1, scaleY: 1, stageWidth: 1920, stageHeight: 1080, offsetX: -960 });
    expect(calculateDashboardRuntimeViewport({ ...page, viewportFit: "stretch" }, 1952, 1112)).toMatchObject({ scaleX: 0.5, scaleY: 1, stageWidth: 1920, stageHeight: 1080 });
    expect(calculateDashboardRuntimeViewport({ ...page, viewportFit: "fixed" }, 1952, 1112)).toMatchObject({ scaleX: 1, scaleY: 1, stageWidth: 3840, stageHeight: 1080 });
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
