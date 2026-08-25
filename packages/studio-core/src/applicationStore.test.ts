import { describe, expect, it, vi } from "vitest";
import pureFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import {
  ApplicationStore,
  applyStudioCommand,
  createRenameApplicationCommand,
  createRenameDashboardPageCommand,
  createDeleteInteractionFlowCommand,
  createDeleteDashboardNodeCommand,
  createInsertDashboardNodeCommand,
  createUpsertInteractionFlowCommand,
  createUpdateDashboardDataWidgetCommand,
  createUpdateDashboardNodeFrameCommand
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
    const updated = applyStudioCommand(added, createUpdateDashboardDataWidgetCommand(pageId, node.id, { ...node.widget, type: "gauge", min: 0, max: 120 }));
    const withFlow = { ...updated, interactions: [{ id: "flow:widget", name: "联动", source: { kind: "widget" as const, id: node.id }, trigger: "click" as const, enabled: true, actions: [] }] };
    const removed = applyStudioCommand(withFlow, createDeleteDashboardNodeCommand(pageId, node.id));

    expect(added.pages[0]!.nodes.at(-1)).toEqual(node);
    expect(updated.pages[0]!.nodes.at(-1)).toMatchObject({ kind: "data-widget", widget: { type: "gauge", max: 120 } });
    expect(removed.pages[0]!.nodes.some((candidate) => candidate.id === node.id)).toBe(false);
    expect(removed.interactions).toHaveLength(0);
    expect(added.scenes).toBe(source.scenes);
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

    const effects = store.dispatchInteraction({ source: widget, trigger: "click", timestamp: "2026-08-25T00:00:00.000Z" });

    expect(store.getState().selection).toEqual([widget]);
    expect(store.getState().variables).toMatchObject({ selectedLine: "A" });
    expect(effects).toEqual([expect.objectContaining({ action: expect.objectContaining({ type: "focus" }) })]);
    expect(() => (effects as unknown[]).push({})).toThrow();
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
