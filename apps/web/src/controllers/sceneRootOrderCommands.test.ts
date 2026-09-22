import { describe, expect, it, vi } from "vitest";
import type { SetStateAction } from "react";
import type { SceneRootLayerRef, SceneSelectionSetState } from "@bim-studio/contracts";
import { createSceneOrganizationCommands } from "./sceneOrganizationCommands";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

describe("root ordering commands", () => {
  function setup(onlyPrimitives = false) {
    let roots: SceneRootLayerRef[] | undefined;
    let groups: SceneSelectionSetState[] = [{ id: "g", name: "Group", kind: "group", objectIds: ["child"] }];
    const record = vi.fn();
    const transform = vi.fn();
    const context = {
      engine: { applyTransform: transform }, locale: "zh-CN", sceneOrganizationSelection: new Set(),
      sceneOrganizationObjects: [
        { id: "model", kind: "model", locked: false }, { id: "primitive", kind: "primitive", locked: false },
        { id: "child", kind: "primitive", locked: false }, { id: "locked", kind: "model", locked: true },
      ], selectionSets: groups, rootLayerOrder: roots,
      setRootLayerOrder: (next: SetStateAction<SceneRootLayerRef[] | undefined>) => { roots = typeof next === "function" ? next(roots) : next; },
      setSelectionSets: (next: SetStateAction<SceneSelectionSetState[]>) => { groups = typeof next === "function" ? next(groups) : next; },
      setMessage: vi.fn(), setRevision: vi.fn(), recordSceneEdit: record, runSceneEdit: (change: () => void) => change(),
    } as unknown as SceneEditorControllerContext;
    if (onlyPrimitives) {
      context.selectionSets = [];
      context.sceneOrganizationObjects = ["box-main", "ground"].map(id => ({ id, kind: "primitive", locked: false })) as typeof context.sceneOrganizationObjects;
    }
    return { context, commands: createSceneOrganizationCommands(context), roots: () => roots, groups: () => groups, record, transform };
  }
  it("moves the first of two ungrouped primitives after the last primitive", () => {
    const h = setup(true); h.commands.moveSceneObjectsToGroup(["box-main"], undefined, "ground", "after");
    expect(h.roots()?.map(ref => ref.id)).toEqual(["ground", "box-main"]);
    expect(h.record).toHaveBeenCalledOnce();
  });
  it("moves a primitive before a root model without changing transforms or creating a group", () => {
    const h = setup(); h.commands.moveSceneObjectsToGroup(["primitive"], undefined, "model");
    expect(h.roots()).toEqual([{ kind: "group", id: "g" }, { kind: "object", id: "primitive" }, { kind: "object", id: "model" }, { kind: "object", id: "locked" }]);
    expect(h.groups()).toHaveLength(1); expect(h.transform).not.toHaveBeenCalled(); expect(h.record).toHaveBeenCalledOnce();
  });
  it("moves a group member to root after a model in the same transaction", () => {
    const h = setup(); h.commands.moveSceneObjectsToGroup(["child"], undefined, "model", "after");
    expect(h.groups()[0]?.objectIds).toEqual([]);
    expect(h.roots()?.map(ref => ref.id)).toEqual(["g", "model", "child", "locked", "primitive"]);
    expect(h.record).toHaveBeenCalledOnce();
  });
  it("ignores self drops, invalid destinations and locked sources", () => {
    for (const [source, target] of [["primitive", "primitive"], ["primitive", "missing"], ["locked", "model"]]) {
      const h = setup(); h.commands.moveSceneObjectsToGroup([source!], undefined, target);
      expect(h.roots()).toBeUndefined(); expect(h.record).not.toHaveBeenCalled();
    }
    const mixed = setup(); mixed.commands.moveSceneObjectsToGroup(["primitive", "locked"], undefined, "model");
    expect(mixed.roots()).toBeUndefined(); expect(mixed.record).not.toHaveBeenCalled();
    const wrongGroup = setup(); wrongGroup.commands.moveSceneObjectsToGroup(["primitive"], "g", "model");
    expect(wrongGroup.record).not.toHaveBeenCalled();
  });
  it("moves an object to a group edge without joining the group", () => {
    const h = setup(); h.commands.moveSceneRootEntries([{ kind: "object", id: "primitive" }], { kind: "group", id: "g" }, "before");
    expect(h.roots()?.map(ref => ref.id)).toEqual(["primitive", "g", "model", "locked"]);
    expect(h.groups()[0]?.objectIds).toEqual(["child"]);
    expect(h.transform).not.toHaveBeenCalled(); expect(h.record).toHaveBeenCalledOnce();
  });
  it("moves a whole group after a root object and preserves its members", () => {
    const h = setup(); h.commands.moveSceneRootEntries([{ kind: "group", id: "g" }], { kind: "object", id: "primitive" }, "after");
    expect(h.roots()?.map(ref => ref.id)).toEqual(["model", "locked", "primitive", "g"]);
    expect(h.groups()[0]?.objectIds).toEqual(["child"]); expect(h.record).toHaveBeenCalledOnce();
  });
  it("detaches a member at its group edge in one edit and reorders two groups", () => {
    const detached = setup(); detached.commands.moveSceneRootEntries([{ kind: "object", id: "child" }], { kind: "group", id: "g" }, "before");
    expect(detached.roots()?.slice(0, 2).map(ref => ref.id)).toEqual(["child", "g"]);
    expect(detached.groups()[0]?.objectIds).toEqual([]); expect(detached.record).toHaveBeenCalledOnce();
    const grouped = setup(); grouped.context.selectionSets.push({ id: "second", name: "Second", kind: "group", objectIds: ["primitive"] });
    grouped.commands.moveSceneRootEntries([{ kind: "group", id: "g" }], { kind: "group", id: "second" }, "after");
    expect(grouped.roots()?.slice(0, 2).map(ref => ref.id)).toEqual(["second", "g"]);
    expect(grouped.groups().map(group => group.objectIds)).toEqual([["child"], ["primitive"]]);
  });
  it("rejects locked groups, mixed locked moves and nested root targets atomically", () => {
    const h = setup(); h.context.sceneOrganizationObjects.find(item => item.id === "child")!.locked = true;
    h.commands.moveSceneRootEntries([{ kind: "group", id: "g" }], { kind: "object", id: "primitive" });
    h.commands.moveSceneRootEntries([{ kind: "object", id: "primitive" }], { kind: "group", id: "g" });
    h.commands.moveSceneRootEntries([{ kind: "object", id: "primitive" }, { kind: "object", id: "locked" }]);
    expect(h.roots()).toBeUndefined(); expect(h.record).not.toHaveBeenCalled();
    const nested = setup(); nested.commands.moveSceneRootEntries([{ kind: "group", id: "g" }], { kind: "object", id: "child" });
    expect(nested.record).not.toHaveBeenCalled();
  });
});
