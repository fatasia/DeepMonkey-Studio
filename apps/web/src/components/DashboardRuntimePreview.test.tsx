import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type SceneSnapshot, type WidgetNode } from "@bim-studio/contracts";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { DashboardRuntimePreview } from "./DashboardRuntimePreview";
import { DashboardNode } from "./DashboardCanvasNode";

vi.mock("./SceneViewportPreview", () => ({ SceneViewportPreview: () => null }));
const application = migrateSceneSnapshotV1(fixture as SceneSnapshot);
const project = { id: application.metadata.projectId, name: "项目", description: "", createdAt: "", updatedAt: "", models: [] };
const callbacks = { onClose: vi.fn(), onPublish: vi.fn(), onSelectPage: vi.fn(), onFilterChange: vi.fn(), onVariableChange: vi.fn(), onSelectionChange: vi.fn(), onObjectInteraction: vi.fn(), onNodeInteraction: vi.fn() };
describe("runtime presentation boundary", () => {
  it("omits author navigation from the public runtime without changing author preview", () => {
    const props = { locale: "zh-CN" as const, rendererBackend: "webgl" as const, application, project, page: application.pages[0]!, metrics: {}, variables: {}, filters: {}, connected: false, ...callbacks };
    expect(renderToStaticMarkup(<DashboardRuntimePreview {...props} />)).toContain("返回编辑");
    const publicHtml = renderToStaticMarkup(<DashboardRuntimePreview {...props} readOnly />);
    expect(publicHtml).not.toContain("返回编辑");
    expect(publicHtml).not.toContain("发布更新");
    expect(publicHtml).toContain("项目控制");
  });
  it("makes clickable display widgets keyboard reachable only in runtime", () => {
    const node: WidgetNode = { id: "next", name: "next", kind: "data-widget", frame: { x: 0, y: 0, width: 300, height: 100 }, zIndex: 1, widget: { type: "text", title: "进入下一页", key: "next", unit: "" } };
    const document = { ...application, interactions: [{ id: "go", name: "下一页", enabled: true, source: { kind: "widget" as const, id: "next" }, trigger: "click" as const, actions: [] }] };
    const props = { ...callbacks, application: document, project, node, frame: node.frame, metric: undefined, variables: {}, filters: {}, selected: false, locale: "zh-CN" as const, rendererBackend: "webgl" as const, onInteraction: vi.fn(), onSelect: vi.fn(), onEnterScene: vi.fn(), onTransformStart: vi.fn() };
    expect(renderToStaticMarkup(<DashboardNode {...props} runtime />)).toContain('role="button" tabindex="0" aria-label="进入下一页"');
    expect(renderToStaticMarkup(<DashboardNode {...props} />)).not.toContain('tabindex="0"');
  });
});
