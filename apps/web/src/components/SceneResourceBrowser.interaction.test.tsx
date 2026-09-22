import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SceneResourceBrowser } from "./SceneResourceBrowser";

const state = vi.hoisted(() => ({ values: [] as unknown[], set: vi.fn(), updateCategory: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: (initial: unknown) => [state.values.length ? state.values.shift() : typeof initial === "function" ? initial() : initial, state.set] }));
vi.mock("./useAssetLibraryCatalog", () => ({ useAssetLibraryCatalog: () => ({
  result: { items: [], total: 0, categories: [{ id: "环境搭建", name: "环境搭建", count: 4 }] },
  category: "all", updateSearch: vi.fn(), updateCategory: state.updateCategory,
}) }));
vi.mock("./useSceneResourceDrag", () => ({ useSceneResourceDrag: () => ({ begin: vi.fn(), over: vi.fn(), drop: vi.fn(), cancel: vi.fn() }) }));
type Element = ReactElement<Record<string, any>>;
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  return isValidElement<Record<string, any>>(node) ? [node, ...walk(node.props.children)] : [];
}
describe("resource browser submission routes", () => {
  beforeEach(() => { state.values = []; state.set.mockClear(); state.updateCategory.mockClear(); });
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
});
