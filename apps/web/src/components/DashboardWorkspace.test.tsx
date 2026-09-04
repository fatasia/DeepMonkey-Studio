import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { calculateDashboardEditorFocus, calculateDashboardEditorZoom, calculateDashboardRuntimeViewport, dashboardNodeSelection, DashboardWorkspace, snapDashboardFrame, updateDashboardParameterDraft } from "./DashboardWorkspace";
import { dashboardInsertedNodeName } from "./dashboardWorkspaceModel";

vi.mock("./DashboardWidgetRuntime", () => ({
  DashboardWidgetView: () => null,
  useDashboardMetrics: () => ({ metrics: {}, datasets: [], pipelines: [], fieldsByProduct: {}, statusByProduct: {}, connected: false }),
  widgetBackgroundStyle: () => ({ background: "transparent" })
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

  it("focuses sparse content on ultra-wide pages without losing the explicit page fit", () => {
    const page = { width: 3840, height: 1080 };
    const nodes = [
      { frame: { x: 48, y: 48, width: 720, height: 420 }, visible: true },
      { frame: { x: 48, y: 500, width: 720, height: 420 }, visible: true },
      { frame: { x: 3740, y: 920, width: 240, height: 120 }, visible: true },
    ];
    const smart = calculateDashboardEditorFocus(page, nodes, 960, 640, "smart");

    expect(smart.target).toBe("content");
    expect(smart.zoom).toBeGreaterThan(calculateDashboardEditorZoom(page, 960, 640) * 2);
    expect(smart.centerX).toBeLessThan(600);
    expect(calculateDashboardEditorFocus(page, nodes, 960, 640, "page").target).toBe("page");
  });

  it("opens a populated ultra-wide dashboard at a readable first business chapter", () => {
    const page = { width: 3840, height: 1080 };
    const nodes = [
      { frame: { x: 80, y: 46, width: 3680, height: 92 }, visible: true },
      { frame: { x: 80, y: 166, width: 896, height: 246 }, visible: true },
      { frame: { x: 1008, y: 166, width: 896, height: 246 }, visible: true },
      { frame: { x: 1936, y: 166, width: 896, height: 246 }, visible: true },
      { frame: { x: 2864, y: 166, width: 896, height: 246 }, visible: true },
      { frame: { x: 80, y: 444, width: 2360, height: 526 }, visible: true },
      { frame: { x: 2472, y: 444, width: 1288, height: 526 }, visible: true },
    ];

    const smart = calculateDashboardEditorFocus(page, nodes, 960, 640, "smart");

    expect(smart).toMatchObject({ target: "content", zoom: 0.5 });
    expect(smart.centerX).toBeLessThan(page.width / 2);
    expect(calculateDashboardEditorFocus(page, nodes, 960, 640, "page").zoom).toBeLessThan(0.5);
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

  it("clears every dependent parameter when a parent draft changes", () => {
    const widgets = [
      { title: "区域", key: "region", type: "filter", unit: "" },
      { title: "城市", key: "city", type: "filter", unit: "", parentFilterKey: "region" },
      { title: "站点", key: "site", type: "filter", unit: "", parentFilterKey: "city" }
    ] as const;
    expect(updateDashboardParameterDraft({ region: "华东", city: "上海", site: "一厂" }, widgets, "region", "华北")).toEqual({ region: "华北" });
  });

  it("selects hidden group members for unified control while respecting locks", () => {
    const nodes = [
      { id: "a", groupId: "group:1", visible: true, locked: false },
      { id: "b", groupId: "group:1", visible: false, locked: false },
      { id: "c", groupId: "group:1", visible: true, locked: true },
      { id: "d", visible: true, locked: false }
    ] as unknown as typeof application.pages[0]["nodes"];

    expect(dashboardNodeSelection(nodes, "a", [], false)).toEqual(["a", "b"]);
    expect(dashboardNodeSelection(nodes, "d", ["a"], false)).toEqual(["d"]);
    expect(dashboardNodeSelection(nodes, "d", ["a"], true)).toEqual(["a", "d"]);
  });

  it("keeps the visible resource name when inserting a catalog component", () => {
    const nodes = [{ id: "existing", name: "经营指标卡" }] as unknown as typeof application.pages[0]["nodes"];

    expect(dashboardInsertedNodeName("zh-CN", "value", { title: "经营指标" }, "经营指标卡", [])).toBe("经营指标卡");
    expect(dashboardInsertedNodeName("zh-CN", "value", { title: "经营指标" }, "经营指标卡", nodes)).toBe("经营指标卡 2");
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
      filters={{}}
      onBack={() => undefined}
      onSelectPage={() => undefined}
      onEnterScene={() => undefined}
      onOpenTopology={() => undefined}
      onOpenData={() => undefined}
      onSelectionChange={() => undefined}
      onFilterChange={() => undefined}
      onVariableChange={() => undefined}
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
    expect(html).toContain("拖动时按 Alt 临时关闭");
    expect(html).toContain('aria-label="智能吸附"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="页面宽度"');
    expect(html).toContain("页面与图层");
    expect(html).toContain("纯三维 看板");
    expect(html).toContain("dashboard-page-tabs"); // 2026-09-05 用户决策反转：底部页签恢复
    expect(html).not.toContain("空格/中键平移");
  });
});
