import { describe, expect, it, vi } from "vitest";
import pureFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import {
  ApplicationStore,
  applyStudioCommand,
  createRenameApplicationCommand,
  createRenameDashboardPageCommand,
  createInsertDashboardPageCommand,
  createDeleteDashboardPageCommand,
  createDeleteInteractionFlowCommand,
  createDeleteScriptModuleCommand,
  createDeleteDashboardNodeCommand,
  createDeleteDashboardNodesCommand,
  createInsertDashboardNodeCommand,
  createInsertDashboardNodesCommand,
  createUpsertInteractionFlowCommand,
  createUpsertScriptModuleCommand,
  createUpsertTopologyCommand,
  createUpdateDashboardDataWidgetCommand,
  createUpdateDashboardDataWidgetsCommand,
  createUpdateDashboardNodeFrameCommand,
  createUpdateDashboardNodeFramesCommand,
  createUpdateDashboardNodeOrderCommand,
  createUpdateDashboardNodeStateCommand,
  createUpdateDashboardNodeStatesCommand,
  createUpdateDashboardPageViewportCommand,
  createUpdateDashboardPageGuidesCommand
} from "./index.js";

function document() {
  return migrateSceneSnapshotV1(pureFixture as SceneSnapshot);
}

function containsFunction(value: unknown): boolean {
  if (typeof value === "function") {
    return true;
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some(containsFunction);
}

describe("StudioCommand", () => {
  it("is pure serializable data", () => {
    const command = createRenameApplicationCommand("新名称");

    expect(structuredClone(command)).toEqual(command);
    expect(JSON.parse(JSON.stringify(command))).toEqual(command);
    expect(command).toMatchObject({
      type: "application.rename",
      label: "重命名应用为“新名称”",
      payload: { name: "新名称" }
    });
    expect(containsFunction(command)).toBe(false);
  });

  it("returns a renamed document without mutating its input", () => {
    const source = document();
    const originalName = source.metadata.name;
    const command = createRenameApplicationCommand("新名称");

    const result = applyStudioCommand(source, command);

    expect(result).not.toBe(source);
    expect(result.metadata.name).toBe("新名称");
    expect(source.metadata.name).toBe(originalName);
    expect(source.pages).toBe(result.pages);
    expect(source.scenes).toBe(result.scenes);
  });

  it("renames dashboard pages and updates node frames through serializable commands", () => {
    const source = document();
    const page = source.pages[0]!;
    const node = page.nodes[0]!;
    const renamed = applyStudioCommand(source, createRenameDashboardPageCommand(page.id, "生产总览"));
    const frame = { x: 120, y: 80, width: 1280, height: 720 };
    const moved = applyStudioCommand(renamed, createUpdateDashboardNodeFrameCommand(page.id, node.id, frame));

    expect(renamed.pages[0]?.name).toBe("生产总览");
    expect(moved.pages[0]?.nodes[0]?.frame).toEqual(frame);
    expect(source.pages[0]?.name).not.toBe("生产总览");
    expect(source.pages[0]?.nodes[0]?.frame).not.toEqual(frame);
    expect(renamed.scenes).toBe(source.scenes);
    expect(moved.scenes).toBe(source.scenes);
  });

  it("updates a dashboard logical resolution and restores it through undo", () => {
    const source = document();
    const page = source.pages[0]!;
    const store = new ApplicationStore(source);

    store.dispatch(createUpdateDashboardPageViewportCommand(page.id, { width: 3840, height: 1080, viewportFit: "cover" }));

    expect(store.getState().document?.pages[0]).toMatchObject({ width: 3840, height: 1080, viewportFit: "cover" });
    expect(store.undo()).toBe(true);
    expect(store.getState().document?.pages[0]).toMatchObject({ width: 1920, height: 1080, viewportFit: "contain" });
    expect(() => createUpdateDashboardPageViewportCommand(page.id, { width: 100, height: 1080, viewportFit: "contain" })).toThrow("页面宽度");
  });

  it("persists dashboard guides as one undoable page command", () => {
    const source = document();
    const page = source.pages[0]!;
    const store = new ApplicationStore(source);
    store.dispatch(createUpdateDashboardPageGuidesCommand(page.id, [
      { id: "guide:x", orientation: "vertical", position: 320 },
      { id: "guide:y", orientation: "horizontal", position: 180 }
    ]));
    expect(store.getState().document?.pages[0]?.guides).toEqual([
      { id: "guide:x", orientation: "vertical", position: 320 },
      { id: "guide:y", orientation: "horizontal", position: 180 }
    ]);
    expect(store.undo()).toBe(true);
    expect(store.getState().document?.pages[0]?.guides).toBeUndefined();
  });

  it("adds and deletes complete dashboard pages with their interactions", () => {
    const source = document();
    const original = source.pages[0]!;
    const page = { ...structuredClone(original), id: "page:copy", name: "复制页面", nodes: original.nodes.map((node) => ({ ...structuredClone(node), id: `copy:${node.id}` })) };
    const flow = { id: "flow:copy", name: "复制联动", source: { kind: "page" as const, id: page.id }, trigger: "click" as const, enabled: true, actions: [] };
    const inserted = applyStudioCommand(source, createInsertDashboardPageCommand(page, [flow]));
    const deleted = applyStudioCommand(inserted, createDeleteDashboardPageCommand(page.id));

    expect(inserted.pages.at(-1)).toEqual(page);
    expect(inserted.interactions.at(-1)).toEqual(flow);
    expect(deleted.pages).toEqual(source.pages);
    expect(deleted.interactions).toEqual(source.interactions);
    expect(() => applyStudioCommand(source, createDeleteDashboardPageCommand(original.id))).toThrow("至少需要保留一个");
  });

  it("moves multiple dashboard nodes as one undoable command", () => {
    const source = document();
    const page = source.pages[0]!;
    const first = page.nodes[0]!;
    const second = { ...structuredClone(first), id: "second-node", frame: { x: 20, y: 30, width: 200, height: 100 } };
    page.nodes.push(second);
    const store = new ApplicationStore(source);

    store.dispatch(createUpdateDashboardNodeFramesCommand(page.id, [
      { nodeId: first.id, frame: { ...first.frame, x: 100 } },
      { nodeId: second.id, frame: { ...second.frame, x: 120 } }
    ]));

    expect(store.getState().document?.pages[0]?.nodes.map((node) => node.frame.x)).toEqual([100, 120]);
    expect(store.undo()).toBe(true);
    expect(store.getState().document?.pages[0]?.nodes.map((node) => node.frame.x)).toEqual([first.frame.x, 20]);
  });

  it("reorders dashboard layers as one undoable command", () => {
    const source = document();
    const page = source.pages[0]!;
    const first = page.nodes[0]!;
    const second = { ...structuredClone(first), id: "second-layer", zIndex: 1 };
    page.nodes.push(second);
    const store = new ApplicationStore(source);
    store.dispatch(createUpdateDashboardNodeOrderCommand(page.id, [{ nodeId: first.id, zIndex: 1 }, { nodeId: second.id, zIndex: 0 }]));
    expect(store.getState().document?.pages[0]?.nodes.map((node) => node.zIndex)).toEqual([1, 0]);
    expect(store.undo()).toBe(true);
    expect(store.getState().document?.pages[0]?.nodes.map((node) => node.zIndex)).toEqual([first.zIndex, 1]);
  });

  it("pastes, locks, hides, and deletes dashboard nodes with undoable commands", () => {
    const source = document();
    const page = source.pages[0]!;
    const originals = page.nodes.length;
    const copies = [
      { ...structuredClone(page.nodes[0]!), id: "copy:1", locked: false },
      { ...structuredClone(page.nodes[0]!), id: "copy:2", visible: true }
    ];
    const store = new ApplicationStore(source);

    store.dispatch(createInsertDashboardNodesCommand(page.id, copies));
    store.dispatch(createUpdateDashboardNodeStateCommand(page.id, copies[0]!.id, { locked: true, visible: false }));
    store.dispatch(createUpdateDashboardNodeStatesCommand(page.id, copies.map((node) => ({ nodeId: node.id, state: { selectable: false, groupId: "group:1", groupName: "泵站指标" } })), "编组"));
    expect(store.getState().document?.pages[0]?.nodes).toHaveLength(originals + 2);
    expect(store.getState().document?.pages[0]?.nodes.find((node) => node.id === copies[0]!.id)).toMatchObject({ locked: true, visible: false, selectable: false, groupId: "group:1", groupName: "泵站指标" });

    store.dispatch(createDeleteDashboardNodesCommand(page.id, copies.map((node) => node.id)));
    expect(store.getState().document?.pages[0]?.nodes).toHaveLength(originals);
    expect(store.undo()).toBe(true);
    expect(store.getState().document?.pages[0]?.nodes).toHaveLength(originals + 2);
  });

  it("rejects dashboard commands that target missing pages or nodes", () => {
    const source = document();
    const page = source.pages[0]!;

    expect(() => applyStudioCommand(source, createRenameDashboardPageCommand("missing", "名称"))).toThrow("应用中不存在页面");
    expect(() => applyStudioCommand(source, createUpdateDashboardNodeFrameCommand(page.id, "missing", { x: 0, y: 0, width: 10, height: 10 }))).toThrow("不存在组件");
  });

  it("upserts and removes interaction flows without cloning unrelated scene state", () => {
    const source = document();
    const flow = {
      id: "flow:line-focus",
      name: "产线定位",
      source: { kind: "widget", id: source.pages[0]!.nodes[0]!.id } as const,
      trigger: "click" as const,
      enabled: true,
      actions: [{ id: "focus", type: "focus" as const, enabled: true, target: { kind: "object" as const, modelId: "machine:1" } }]
    };

    const added = applyStudioCommand(source, createUpsertInteractionFlowCommand(flow));
    const renamed = applyStudioCommand(added, createUpsertInteractionFlowCommand({ ...flow, name: "定位设备" }));
    const removed = applyStudioCommand(renamed, createDeleteInteractionFlowCommand(flow.id));

    expect(added.interactions).toContainEqual(flow);
    expect(renamed.interactions).toHaveLength(1);
    expect(renamed.interactions[0]?.name).toBe("定位设备");
    expect(removed.interactions).toHaveLength(0);
    expect(added.scenes).toBe(source.scenes);
  });

  it("creates, updates, deletes, and restores behavior scripts through undoable commands", () => {
    const source = document();
    const template = source.scripts[0]!;
    const script = { ...structuredClone(template), id: "script:agv", name: "AGV 实时运动", code: "function onUpdate(ctx) {}" };
    const store = new ApplicationStore({ ...source, scripts: [] });

    store.dispatch(createUpsertScriptModuleCommand(script));
    store.dispatch(createUpsertScriptModuleCommand({ ...script, name: "AGV 运动" }));
    expect(store.getState().document?.scripts).toEqual([{ ...script, name: "AGV 运动" }]);

    store.dispatch(createDeleteScriptModuleCommand(script.id));
    expect(store.getState().document?.scripts).toEqual([]);
    expect(store.undo()).toBe(true);
    expect(store.getState().document?.scripts).toEqual([{ ...script, name: "AGV 运动" }]);
  });

  it("creates and updates topology documents through undoable commands", () => {
    const source = { ...document(), topologies: [] };
    const store = new ApplicationStore(source);
    const topology = { id: "topology:line", name: "产线拓扑", nodes: [], edges: [] };

    store.dispatch(createUpsertTopologyCommand(topology));
    store.dispatch(createUpsertTopologyCommand({ ...topology, name: "装配线拓扑" }));

    expect(store.getState().document?.topologies).toEqual([{ ...topology, name: "装配线拓扑" }]);
    expect(store.undo()).toBe(true);
    expect(store.getState().document?.topologies).toEqual([topology]);
  });

  it("creates, updates, and deletes a native data widget atomically", () => {
    const source = document();
    const pageId = source.pages[0]!.id;
    const node = {
      id: "widget:throughput",
      kind: "data-widget" as const,
      frame: { x: 48, y: 64, width: 320, height: 180 },
      zIndex: 2,
      widget: { title: "产量", key: "line.output", type: "value" as const, unit: "件" }
    };

    const added = applyStudioCommand(source, createInsertDashboardNodeCommand(pageId, node));
    const renamed = applyStudioCommand(added, createUpdateDashboardNodeStateCommand(pageId, node.id, { name: "产量指标" }));
    const updated = applyStudioCommand(renamed, createUpdateDashboardDataWidgetCommand(pageId, node.id, { ...node.widget, type: "gauge", min: 0, max: 120 }));
    const withFlow = { ...updated, interactions: [{ id: "flow:widget", name: "联动", source: { kind: "widget" as const, id: node.id }, trigger: "click" as const, enabled: true, actions: [] }] };
    const removed = applyStudioCommand(withFlow, createDeleteDashboardNodeCommand(pageId, node.id));

    expect(added.pages[0]!.nodes.at(-1)).toEqual(node);
    expect(renamed.pages[0]!.nodes.at(-1)).toMatchObject({ name: "产量指标" });
    expect(updated.pages[0]!.nodes.at(-1)).toMatchObject({ kind: "data-widget", widget: { type: "gauge", max: 120 } });
    expect(removed.pages[0]!.nodes.some((candidate) => candidate.id === node.id)).toBe(false);
    expect(removed.interactions).toHaveLength(0);
    expect(added.scenes).toBe(source.scenes);
  });

  it("updates a group of data widgets in one command", () => {
    const source = document();
    const pageId = source.pages[0]!.id;
    const nodes = ["a", "b"].map((id, index) => ({
      id: `widget:${id}`,
      kind: "data-widget" as const,
      frame: { x: index * 200, y: 0, width: 180, height: 120 },
      zIndex: index,
      widget: { title: id, key: `old.${id}`, type: "value" as const, unit: "" }
    }));
    const added = applyStudioCommand(source, createInsertDashboardNodesCommand(pageId, nodes));
    const updated = applyStudioCommand(added, createUpdateDashboardDataWidgetsCommand(pageId, nodes.map((node) => ({ nodeId: node.id, widget: { ...node.widget, datasetId: "new" } }))));

    expect(updated.pages[0]!.nodes.filter((node) => nodes.some((candidate) => candidate.id === node.id))).toEqual(nodes.map((node) => ({ ...node, widget: { ...node.widget, datasetId: "new" } })));
  });
});

describe("ApplicationStore", () => {
  it("dispatches, undoes, and redoes a serializable command", () => {
    const store = new ApplicationStore(document());

    store.dispatch(createRenameApplicationCommand("新名称"));

    expect(store.getState()).toMatchObject({ dirty: true, canUndo: true, canRedo: false });
    expect(store.getState().document?.metadata.name).toBe("新名称");
    expect(store.undo()).toBe(true);
    expect(store.getState()).toMatchObject({ dirty: false, canUndo: false, canRedo: true });
    expect(store.getState().document?.metadata.name).toBe("纯三维");
    expect(store.redo()).toBe(true);
    expect(store.getState().document?.metadata.name).toBe("新名称");
  });

  it("resets history when a different document is loaded", () => {
    const store = new ApplicationStore(document());

    store.dispatch(createRenameApplicationCommand("临时名称"));
    store.load(document());

    expect(store.getState()).toMatchObject({ dirty: false, canUndo: false, canRedo: false });
  });

  it("acknowledges an autosave without resetting selection or undo history", () => {
    const store = new ApplicationStore(document());
    const selected = { kind: "widget" as const, id: document().pages[0]!.nodes[0]!.id };
    store.setSelection([selected]);
    store.dispatch(createRenameApplicationCommand("已保存名称"));
    const requestDocument = structuredClone(store.getState().document!);
    const saved = { ...requestDocument, metadata: { ...requestDocument.metadata, revision: requestDocument.metadata.revision + 1, updatedAt: "2026-08-26T12:00:00.000Z" } };

    store.acknowledgeSave(saved);

    expect(store.getState()).toMatchObject({ dirty: false, canUndo: true, selection: [selected] });
    expect(store.getState().document?.metadata.revision).toBe(saved.metadata.revision);
    expect(store.undo()).toBe(true);
    expect(store.getState()).toMatchObject({ dirty: true, canRedo: true, selection: [selected] });
    expect(store.redo()).toBe(true);
    expect(store.getState()).toMatchObject({ dirty: false, selection: [selected] });

    store.dispatch(createRenameApplicationCommand("请求期间的新修改"));
    store.acknowledgeSave(saved);
    expect(store.getState().document?.metadata.name).toBe("请求期间的新修改");
    expect(store.getState()).toMatchObject({ dirty: true, selection: [selected] });
  });

  it("publishes one immutable snapshot per subscriber notification", () => {
    const store = new ApplicationStore(document());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const initial = store.getState();

    expect(store.getState()).toBe(initial);

    store.setSelection([{ kind: "scene", id: "scene-pure-3d" }]);

    const selected = store.getState();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(selected).not.toBe(initial);
    expect(selected.document).toBe(initial.document);
    expect(store.getState()).toBe(selected);
    expect(() => (selected.selection as unknown[]).push({})).toThrow();
    expect(() => {
      selected.document!.metadata.name = "篡改名称";
    }).toThrow();
    store.setSelection([{ kind: "scene", id: "scene-pure-3d" }]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("shares transient selection, variables, and filters without dirtying the document", () => {
    const source = document();
    source.data.variables = [{ id: "temperature", value: 21 }];
    const store = new ApplicationStore(source);

    store.setSelection([{ kind: "widget", id: source.pages[0]!.nodes[0]!.id }]);
    store.setVariable("temperature", 24);
    store.setFilter("line", "A");

    expect(store.getState()).toMatchObject({
      dirty: false,
      variables: { temperature: 24 },
      filters: { line: "A" }
    });
    expect(() => { store.getState().variables.temperature = 30; }).toThrow();
    expect(store.getState().document?.data.variables[0]?.value).toBe(21);
  });

  it("dispatches interaction data into shared runtime state and returns immutable host effects", () => {
    const source = document();
    const widget = { kind: "widget", id: source.pages[0]!.nodes[0]!.id } as const;
    source.interactions = [{
      id: "flow:one",
      name: "二维控制三维",
      source: widget,
      trigger: "click",
      enabled: true,
      actions: [
        { id: "data", type: "setData", enabled: true, dataKey: "selectedLine", value: "A" },
        { id: "focus", type: "focus", enabled: true }
      ]
    }];
    const store = new ApplicationStore(source);

    const result = store.dispatchInteraction({ source: widget, trigger: "click", timestamp: "2026-08-25T00:00:00.000Z" });

    expect(store.getState().selection).toEqual([widget]);
    expect(store.getState().variables).toMatchObject({ selectedLine: "A" });
    expect(result.matchedFlowIds).toEqual(["flow:one"]);
    expect(result.effects).toEqual([expect.objectContaining({ action: expect.objectContaining({ type: "focus" }) })]);
    expect(() => (result.effects as unknown[]).push({})).toThrow();
  });

  it("clears redo history when dispatching after an undo", () => {
    const store = new ApplicationStore(document());

    store.dispatch(createRenameApplicationCommand("第一次重命名"));
    store.undo();
    store.dispatch(createRenameApplicationCommand("分支重命名"));

    expect(store.getState()).toMatchObject({ canUndo: true, canRedo: false });
    expect(store.redo()).toBe(false);
  });

  it("rejects commands without an open document", () => {
    const store = new ApplicationStore();

    expect(() => store.dispatch(createRenameApplicationCommand("新名称"))).toThrow("没有已打开的应用文档");
  });
});
