import { isValidElement, type ReactNode, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[], effects: [] as Array<() => (() => void)>, context: {} as Record<string, any> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useEffect: (effect: () => (() => void)) => { state.effects.push(effect); },
  useRef: (value: unknown) => state.cells[state.cursor++] ??= { current: value },
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.cells)) state.cells[index] = typeof initial === "function" ? initial() : initial;
    return [state.cells[index], (next: any) => { state.cells[index] = typeof next === "function" ? next(state.cells[index]) : next; }];
  },
}));
vi.mock("./dashboardWorkspaceContext", () => ({ useDashboardWorkspace: () => state.context }));
vi.mock("./DashboardComponentLibrary", () => ({ DashboardComponentLibrary: () => null }));
import { DashboardLayerList } from "./DashboardWorkspaceLeftPanel";
type Element = ReactElement<Record<string, any>>;
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...walk(node.props.children)];
}
function render() { state.cursor = 0; return walk(DashboardLayerList()); }
function clickTitle(title: string, modifiers = {}) {
  const button = render().find(item => item.type === "button" && item.props.title === title)!;
  expect(button).toBeDefined();
  button.props.onClick({ detail: 1, ctrlKey: false, metaKey: false, shiftKey: false, ...modifiers });
}
beforeEach(() => {
  state.cells = [];
  state.effects = [];
  const nodes = ["a", "b", "c"].map((id, index) => ({ id, kind: "data-widget", zIndex: 3 - index,
    ...(index < 2 ? { groupId: "group" } : {}), frame: { x: 0, y: 0, width: 100, height: 100 }, widget: { type: "text", title: id } }));
  state.context = { locale: "zh-CN", page: { id: "page", nodes }, dashboardGroups: [{ id: "group", label: "组", nodes: nodes.slice(0, 2) }],
    selectedNodeIds: [], setSelectedNodeIds: (ids: string[]) => { state.context.selectedNodeIds = ids; },
    onSelectionChange: vi.fn(), onNodeInteraction: vi.fn() };
});
it("dispatches actual row click handlers for single, Ctrl and Shift selection", () => {
  clickTitle("a"); clickTitle("c", { shiftKey: true });
  expect(state.context.selectedNodeIds).toEqual(["a", "b", "c"]);
  clickTitle("b", { ctrlKey: true });
  expect(state.context.selectedNodeIds).toEqual(["a", "c"]);
  clickTitle("c"); clickTitle("c");
  expect(state.context.selectedNodeIds).toEqual(["c"]);
  expect(state.context.onNodeInteraction).toHaveBeenCalledWith("c");
});
it("allows inspecting locked rows while their drag and delete actions stay disabled", () => {
  state.context.page.nodes[1].locked = true;
  clickTitle("b");
  expect(state.context.selectedNodeIds).toEqual(["b"]);
  const row = render().find(item => item.props.className?.includes("dashboard-layer-row") && item.props.className.includes("locked"))!;
  expect(row.props.draggable).toBe(false);
  expect(walk(row).find(item => item.props["aria-label"] === "删除组件")?.props.disabled).toBe(true);
  clickTitle("a"); clickTitle("c", { shiftKey: true });
  expect(state.context.selectedNodeIds).toEqual(["a", "b", "c"]);
});
it("announces a rejected drop and clears its message when another drag starts", () => {
  state.context.reorderLayerByDrop = vi.fn(() => "locked-order-gap");
  state.context.setDraggedLayerId = vi.fn();
  state.context.setLayerDropTargetId = vi.fn();
  const row = render().find(item => item.props.className?.includes("dashboard-layer-row"))!;
  const source = render().filter(item => item.props.className?.includes("dashboard-layer-row"))[2]!;
  const event = { clientY: 1, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 30 }) }, preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { setData: vi.fn() } };
  source.props.onDragStart(event);
  row.props.onDrop(event);
  expect(state.context.reorderLayerByDrop).toHaveBeenCalledWith("c", "a", { position: "before", targetKind: "item" });
  expect(render().find(item => item.props.role === "status")?.props.children).toContain("没有排序空间");
  row.props.onDragStart(event);
  expect(render().some(item => item.props.role === "status")).toBe(false);
});
it("rejects dragging an unlocked member of a mixed locked selection with an explicit message", () => {
  state.context.page.nodes[1].locked = true; state.context.selectedNodeIds = ["a", "b"];
  state.context.reorderLayerByDrop = vi.fn(); state.context.setDraggedLayerId = vi.fn(); state.context.setLayerDropTargetId = vi.fn();
  const rows = render().filter(item => item.props.className?.includes("dashboard-layer-row"));
  const event = { preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { setData: vi.fn() } };
  rows[0]!.props.onDragStart(event);
  expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.dataTransfer.setData).not.toHaveBeenCalled();
  expect(render().find(item => item.props.role === "status")?.props.children).toContain("包含锁定项");
  rows[2]!.props.onDrop(event); expect(state.context.reorderLayerByDrop).not.toHaveBeenCalled();
  expect(state.context.selectedNodeIds).toEqual(["a", "b"]);
});
it("explains a self-target drop instead of leaving a silent no-op", () => {
  state.context.selectedNodeIds = ["a", "b"];
  state.context.reorderLayerByDrop = vi.fn(); state.context.setDraggedLayerId = vi.fn(); state.context.setLayerDropTargetId = vi.fn();
  const rows = render().filter(item => item.props.className?.includes("dashboard-layer-row"));
  const event = { clientY: 29, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 30 }) }, preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { setData: vi.fn() } };
  rows[0]!.props.onDragStart(event); rows[1]!.props.onDrop(event);
  expect(state.context.reorderLayerByDrop).not.toHaveBeenCalled();
  expect(render().find(item => item.props.role === "status")?.props.children).toContain("目标在本次选择中");
});
it("does not commit an external or cancelled drag, including a late drop", () => {
  state.context.reorderLayerByDrop = vi.fn();
  state.context.setDraggedLayerId = vi.fn(); state.context.setLayerDropTargetId = vi.fn();
  const rows = render().filter(item => item.props.className?.includes("dashboard-layer-row"));
  const event = { clientY: 29, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 30 }) }, preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { setData: vi.fn(), getData: () => "a" } };
  rows[2]!.props.onDrop(event);
  rows[0]!.props.onDragStart(event); rows[0]!.props.onDragEnd(); rows[2]!.props.onDrop(event);
  expect(state.context.reorderLayerByDrop).not.toHaveBeenCalled();
});
it("restores an allowed drop after hovering over the source and rerendering", () => {
  state.context.dashboardGroups = [];
  state.context.page.nodes.forEach((node: { groupId?: string }) => { delete node.groupId; });
  state.context.selectedNodeIds = ["a"];
  state.context.reorderLayerByDrop = vi.fn();
  state.context.setDraggedLayerId = vi.fn(); state.context.setLayerDropTargetId = vi.fn();
  const rows = () => render().filter(item => item.props.className?.includes("dashboard-layer-row"));
  const event = { clientY: 29, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 30 }) },
    preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { setData: vi.fn(), dropEffect: "none" } };
  rows()[0]!.props.onDragStart(event);
  rows()[0]!.props.onDragOver(event);
  expect(event.dataTransfer.dropEffect).toBe("none");
  rows()[2]!.props.onDragOver(event);
  expect(event.dataTransfer.dropEffect).toBe("move");
  expect(rows()[2]!.props["data-layer-drop"]).toBe("after");
  rows()[2]!.props.onDrop(event);
  expect(state.context.reorderLayerByDrop).toHaveBeenCalledExactlyOnceWith("a", "c", { position: "after", targetKind: "item" });
  expect(state.context.setDraggedLayerId).not.toHaveBeenCalled();
  expect(state.context.setLayerDropTargetId).not.toHaveBeenCalled();
});
it("renders authored roots in order and routes whole-group dragging as a group source", () => {
  state.context.page.rootLayerOrder = [{ kind: "node", id: "c" }, { kind: "group", id: "group" }];
  state.context.reorderLayerByDrop = vi.fn();
  const elements = render();
  expect(elements.filter(item => item.type === "button" && item.props.className === "dashboard-layer-select").map(item => item.props.title)).toEqual(["c", "a", "b"]);
  const group = elements.find(item => item.props.className === "dashboard-group-row")!;
  expect(group.props.draggable).toBe(true);
  const event = { clientY: 1, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 30 }) }, preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { setData: vi.fn() } };
  group.props.onDragStart(event);
  render().find(item => item.props.className?.includes("dashboard-layer-row"))!.props.onDrop(event);
  expect(state.context.reorderLayerByDrop).toHaveBeenCalledExactlyOnceWith("group", "c", { position: "before", targetKind: "item", sourceKind: "group" });
});
it("routes F2 to the focused node's existing inspector, and Delete to its row command", () => {
  state.context.setInspectorOpen = vi.fn(); state.context.setInspectorTab = vi.fn(); state.context.deleteLayerNode = vi.fn();
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1)); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  try {
    const tree = () => render().find(item => item.props.role === "tree")!;
    const domRow = { dataset: { nodeId: "b" }, querySelectorAll: vi.fn(() => [] as unknown[]) };
    const event = { key: "F2", nativeEvent: {}, target: { closest: (selector: string) => selector === "[data-layer-keyboard-row]" ? domRow : null },
      currentTarget: { contains: () => true }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    tree().props.onKeyDown(event);
    expect(state.context.selectedNodeIds).toEqual(["b"]);
    expect(state.context.setInspectorOpen).toHaveBeenCalledExactlyOnceWith(true);
    expect(state.context.setInspectorTab).toHaveBeenCalledExactlyOnceWith("content");
    const rendered = render().find(item => item.props["data-node-id"] === "b")!;
    const deletion = walk(rendered).find(item => item.props["data-layer-action"] === "delete")!;
    domRow.querySelectorAll.mockReturnValue([{ disabled: false, matches: () => false, getAttribute: () => null, closest: () => domRow, click: deletion.props.onClick }]);
    tree().props.onKeyDown({ ...event, key: "Delete" });
    expect(state.context.deleteLayerNode).toHaveBeenCalledExactlyOnceWith(state.context.page.nodes[1]);
  } finally { vi.unstubAllGlobals(); }
});
it("cancels on Escape without changing selection or accepting a late drop", () => {
  const windowTarget = new EventTarget(); vi.stubGlobal("window", windowTarget);
  state.context.reorderLayerByDrop = vi.fn();
  state.context.setDraggedLayerId = vi.fn(); state.context.setLayerDropTargetId = vi.fn();
  state.context.selectedNodeIds = ["a", "b"];
  const rows = render().filter(item => item.props.className?.includes("dashboard-layer-row"));
  const cleanup = state.effects[0]!();
  try {
    const event = { clientY: 29, currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 30 }) }, preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { setData: vi.fn() } };
    rows[0]!.props.onDragStart(event);
    const key = new Event("keydown", { cancelable: true }); Object.defineProperty(key, "key", { value: "Escape" });
    windowTarget.dispatchEvent(key); rows[2]!.props.onDrop(event);
    expect(key.defaultPrevented).toBe(true);
    expect(state.context.selectedNodeIds).toEqual(["a", "b"]);
    expect(state.context.reorderLayerByDrop).not.toHaveBeenCalled();
    expect(render().some(item => item.props.className?.split(" ").includes("dragging"))).toBe(false);
    expect(state.context.setDraggedLayerId).not.toHaveBeenCalled();
    expect(state.context.setLayerDropTargetId).not.toHaveBeenCalled();
  } finally { cleanup(); vi.unstubAllGlobals(); }
});
it("collapses children without editing the document or retaining them in range order", () => {
  clickTitle("a");
  const toggle = render().find(item => item.props["aria-label"] === "收起编组“组”")!;
  toggle.props.onClick();
  expect(render().some(item => item.type === "button" && item.props.title === "a")).toBe(false);
  expect(state.context.page.nodes).toHaveLength(3);
  clickTitle("c", { shiftKey: true });
  expect(state.context.selectedNodeIds).toEqual(["c"]);
  expect(render().find(item => item.props["aria-expanded"] !== undefined)?.props["aria-expanded"]).toBe(false);
});
it.each([{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, shiftKey: true }])("retains folded selections when appending %j", modifiers => {
  clickTitle("a");
  render().find(item => item.props["aria-label"] === "收起编组“组”")!.props.onClick();
  state.context.selectedNodeIds.push("deleted");
  clickTitle("c", modifiers);
  expect(state.context.selectedNodeIds).toEqual(["a", "c"]);
  expect(state.context.onSelectionChange).toHaveBeenLastCalledWith([{ kind: "widget", id: "a" }, { kind: "widget", id: "c" }]);
});
