import { describe, expect, it, vi } from "vitest";
import pureFixture from "../../contracts/src/__fixtures__/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore, applyStudioCommand, createRenameApplicationCommand } from "./index.js";

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

  it("returns a renamed document without mutating its recursively frozen reducer input", () => {
    const source = document();
    const originalName = source.metadata.name;
    const command = createRenameApplicationCommand("新名称");

    const result = applyStudioCommand(source, command);

    expect(result).not.toBe(source);
    expect(result.metadata.name).toBe("新名称");
    expect(source.metadata.name).toBe(originalName);
    expect(source.pages).not.toBe(result.pages);
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

    store.setSelection([{ kind: "scene", id: "scene-pure-3d" }]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(() => (store.getState().selection as unknown[]).push({})).toThrow();
    expect(() => {
      store.getState().document!.metadata.name = "篡改名称";
    }).toThrow();
    unsubscribe();
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
