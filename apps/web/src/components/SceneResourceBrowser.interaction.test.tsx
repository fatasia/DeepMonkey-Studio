import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SceneResourceBrowser } from "./SceneResourceBrowser";

const state = vi.hoisted(() => ({ values: [] as unknown[], set: vi.fn(), updateCategory: vi.fn(), dragBegin: vi.fn(), dragDrop: vi.fn(), dragInsert: undefined as ((payload: { source: string; id: string }) => void) | undefined }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => [state.values.length ? state.values.shift() : typeof initial === "function" ? initial() : initial, state.set] }));
vi.mock("./useAssetLibraryCatalog", () => ({ useAssetLibraryCatalog: () => ({
  result: { items: [], total: 0, categories: [{ id: "环境搭建", name: "环境搭建", count: 4 }] },
  category: "all", updateSearch: vi.fn(), updateCategory: state.updateCategory,
}) }));
vi.mock("./useSceneResourceDrag", () => ({ useSceneResourceDrag: (_owner: unknown, insert: (asset: { source: string; id: string }) => void) => {
  state.dragInsert = insert;
  return { begin: state.dragBegin, over: vi.fn(), drop: state.dragDrop, cancel: vi.fn() };
} }));
type Element = ReactElement<Record<string, any>>;
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  return isValidElement<Record<string, any>>(node) ? [node, ...walk(node.props.children)] : [];
}
describe("resource browser submission routes", () => {
  beforeEach(() => { state.values = []; state.set.mockClear(); state.updateCategory.mockClear(); state.dragBegin.mockClear(); state.dragDrop.mockClear(); });
  it("exposes published scene-building categories inside the scene asset panel", () => {
    state.values = ["", "platform", false];
    const tree = SceneResourceBrowser({ locale: "zh-CN", projectId: "project", onInsertProjectModel: vi.fn(), onImportModel: vi.fn(), onInsertPrefab: vi.fn() } as Parameters<typeof SceneResourceBrowser>[0]);
    const category = walk(tree).find(item => item.type === "select" && item.props["aria-label"] === "平台素材分类")!;
    expect(category).toBeDefined();
    expect(walk(category).some(item => item.type === "option" && item.props.value === "环境搭建")).toBe(true);
    category.props.onChange({ target: { value: "环境搭建" } });
    expect(state.updateCategory).toHaveBeenCalledExactlyOnceWith("环境搭建");
  });
  it("discovers built-in fences from platform search and inserts through the existing prefab route", () => {
    const onInsertPrefab = vi.fn();
    const props = { locale: "zh-CN", projectId: "project", onInsertProjectModel: vi.fn(), onImportModel: vi.fn(), onInsertPrefab } as Parameters<typeof SceneResourceBrowser>[0];
    state.values = ["围栏", "platform", false];
    const match = walk(SceneResourceBrowser(props)).find(item => item.props.className === "scene-resource-prefab-match")!;
    expect(match).toBeDefined();
    match.props.onClick();
    expect(state.set).toHaveBeenCalledWith("prefab");
    state.values = ["围栏", "prefab", false];
    const rows = walk(SceneResourceBrowser(props)).filter(item => item.props["data-resource-source"] === "prefab");
    expect(rows.length).toBeGreaterThan(0);
    walk(rows[0]).find(item => item.type === "button")!.props.onClick();
    expect(onInsertPrefab).toHaveBeenCalledWith(expect.objectContaining({ kind: "fence" }));
  });
  it("keeps explicit model load and has no mouseup or panel-wide drop insertion", () => {
    const model = { id: "model", name: "Model", format: "glb", status: "ready" };
    const onInsertProjectModel = vi.fn();
    const tree = SceneResourceBrowser({ locale: "zh-CN", projectModels: [model], onInsertProjectModel, onImportModel: vi.fn(), onInsertPrefab: vi.fn() } as unknown as Parameters<typeof SceneResourceBrowser>[0]);
    const elements = walk(tree), row = elements.find(item => item.props["data-model-id"] === "model")!;
    expect(tree.props.onDrop).toBeUndefined(); expect(tree.props.onDropCapture).toBeUndefined();
    expect(elements.some(item => item.props.onMouseUp || item.props.onMouseDown)).toBe(false);
    row.props.onDragEnd(); expect(onInsertProjectModel).not.toHaveBeenCalled();
    walk(row).find(item => item.type === "button")!.props.onClick();
    expect(onInsertProjectModel).toHaveBeenCalledExactlyOnceWith(model);
    expect(elements.filter(item => item.props.onDrop).map(item => item.props.className)).toEqual(["scene-resource-drop-target"]);
  });
  it("offers a reload action on ready project models and keeps it absent without a manifest", () => {
    const ready = { id: "ready", name: "Ready", format: "glb", status: "ready", manifest: { geometryUrl: "/a.glb" } };
    const pending = { id: "pending", name: "Pending", format: "rvt", status: "processing" };
    const onInsertProjectModel = vi.fn();
    const onReloadProjectModel = vi.fn();
    const props = { locale: "zh-CN", projectModels: [ready, pending], onInsertProjectModel, onReloadProjectModel, onImportModel: vi.fn(), onInsertPrefab: vi.fn() } as unknown as Parameters<typeof SceneResourceBrowser>[0];
    state.values = ["", "project", false];
    const tree = SceneResourceBrowser(props);
    const row = walk(tree).find(item => item.props["data-model-id"] === "ready")!;
    const buttons = walk(row).filter(item => item.type === "button");
    expect(buttons).toHaveLength(2);
    const reload = buttons.find(item => item.props["aria-label"] === "重新加载 Ready")!;
    expect(reload).toBeDefined();
    expect(reload.props.title).toContain("失败保留原资产");
    reload.props.onClick();
    expect(onReloadProjectModel).toHaveBeenCalledExactlyOnceWith(ready);
    expect(onInsertProjectModel).not.toHaveBeenCalled();
    const pendingRow = walk(tree).find(item => item.props["data-model-id"] === "pending")!;
    expect(walk(pendingRow).filter(item => item.type === "button")).toHaveLength(1);
  });
  it("offers user prefabs drag and double-click instantiation through the single insert route", () => {
    const onInsertUserPrefab = vi.fn();
    const prefab = { id: "userprefab:1", name: "工位", category: "产线", version: 2, objects: [{}, {}] };
    const props = { locale: "zh-CN", projectId: "project", onInsertProjectModel: vi.fn(), onImportModel: vi.fn(), onInsertPrefab: vi.fn(), userPrefabs: [prefab], onInsertUserPrefab } as unknown as Parameters<typeof SceneResourceBrowser>[0];
    state.values = ["", "prefab", false];
    const tree = SceneResourceBrowser(props);
    const row = walk(tree).find(item => item.props["data-user-prefab-id"] === "userprefab:1")!;
    expect(row).toBeDefined();
    // 双击实例化:走同一条 onInsertUserPrefab 路线,不另起写路径。
    row.props.onDoubleClick();
    expect(onInsertUserPrefab).toHaveBeenCalledExactlyOnceWith("userprefab:1");
    // 拖放:begin 携带 userPrefab 标识;提交只在落点回调查 onInsertUserPrefab。
    expect(row.props.draggable).toBe(true);
    row.props.onDragStart({ stopPropagation: vi.fn(), dataTransfer: { effectAllowed: "", setData: vi.fn() } });
    expect(state.dragBegin).toHaveBeenCalledExactlyOnceWith(expect.anything(), "userPrefab", "userprefab:1");
    state.dragInsert?.({ source: "userPrefab", id: "userprefab:1" });
    expect(onInsertUserPrefab).toHaveBeenCalledTimes(2);
  });
});
