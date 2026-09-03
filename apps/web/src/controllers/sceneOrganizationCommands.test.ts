import type { SetStateAction } from "react";
import { describe, expect, it, vi } from "vitest";
import { createSceneOrganizationCommands } from "./sceneOrganizationCommands";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

describe("场景组织命令", () => {
  it("keeps the scene tree and property inspector on the same single selection", () => {
    const select = vi.fn();
    let selection = new Set<string>();
    const commands = createSceneOrganizationCommands({
      engine: { select } as unknown as SceneEditorControllerContext["engine"],
      locale: "zh-CN",
      sceneOrganizationObjects: ["base", "arm"].map((id) => ({ id, name: id, kind: "primitive" as const, visible: true, locked: false })),
      sceneOrganizationSelection: selection,
      selectionSets: [],
      setSceneOrganizationSelection: (next: SetStateAction<Set<string>>) => {
        selection = typeof next === "function" ? next(selection) : next;
      },
    } as unknown as SceneEditorControllerContext);

    commands.replaceSceneOrganizationSelection(["base"]);

    expect([...selection]).toEqual(["base"]);
    expect(select).toHaveBeenCalledWith("base");
  });

  it("preserves Ctrl multi-selection after ViewerEngine reports the new primary object", () => {
    let selection = new Set(["base"]);
    const select = vi.fn((id: string | undefined) => {
      // Mirrors the synchronous viewport selection callback registered by the app.
      selection = new Set(id ? [id] : []);
    });
    const commands = createSceneOrganizationCommands({
      engine: { select } as unknown as SceneEditorControllerContext["engine"],
      locale: "zh-CN",
      sceneOrganizationObjects: ["base", "arm"].map((id) => ({ id, name: id, kind: "primitive" as const, visible: true, locked: false })),
      sceneOrganizationSelection: selection,
      selectionSets: [],
      setSceneOrganizationSelection: (next: SetStateAction<Set<string>>) => {
        selection = typeof next === "function" ? next(selection) : next;
      },
    } as unknown as SceneEditorControllerContext);

    commands.toggleSceneOrganizationObject("arm");

    expect(select).toHaveBeenCalledWith("arm");
    expect([...selection]).toEqual(["base", "arm"]);
  });

  it("locks every object and advances the revision only once", () => {
    const setModelLocked = vi.fn();
    let revision = 4;
    const commands = createSceneOrganizationCommands({
      engine: { setModelLocked } as unknown as SceneEditorControllerContext["engine"],
      locale: "zh-CN",
      sceneOrganizationObjects: [],
      sceneOrganizationSelection: new Set(),
      selectionSets: [],
      lastDeletedSelectionSet: undefined,
      setMessage: vi.fn(),
      setRevision: (next: SetStateAction<number>) => {
        revision = typeof next === "function" ? next(revision) : next;
      },
      setSceneOrganizationSelection: vi.fn(),
      setSelectionSets: vi.fn(),
      setLastDeletedSelectionSet: vi.fn(),
      recordSceneEdit: vi.fn(),
    } as unknown as SceneEditorControllerContext);

    commands.setSceneObjectsLocked(["line-a", "line-b"], true);

    expect(setModelLocked.mock.calls).toEqual([
      ["line-a", true],
      ["line-b", true],
    ]);
    expect(revision).toBe(5);
  });

  it("creates a group transaction, removes duplicated membership and records history", () => {
    let revision = 0;
    let sets = [{ id: "group-old", name: "旧组", kind: "group" as const, objectIds: ["a", "b"] }];
    const recordSceneEdit = vi.fn();
    const commands = createSceneOrganizationCommands({
      locale: "zh-CN",
      sceneOrganizationObjects: ["a", "b", "c"].map((id) => ({ id, name: id, kind: "primitive" as const, visible: true, locked: false })),
      sceneOrganizationSelection: new Set(["b", "c"]),
      selectionSets: sets,
      setMessage: vi.fn(),
      setRevision: (next: SetStateAction<number>) => { revision = typeof next === "function" ? next(revision) : next; },
      setSelectionSets: (next: SetStateAction<typeof sets>) => { sets = typeof next === "function" ? next(sets) : next; },
      recordSceneEdit,
    } as unknown as SceneEditorControllerContext);

    commands.createSceneGroup("");

    expect(sets[0]?.objectIds).toEqual(["a"]);
    expect(sets[1]).toMatchObject({ kind: "group", objectIds: ["b", "c"] });
    expect(revision).toBe(1);
    expect(recordSceneEdit).toHaveBeenCalledWith(expect.stringContaining("创建编组"));
  });

  it("moves objects between groups in the requested order and records persistence", () => {
    let revision = 7;
    let sets = [
      { id: "group-a", name: "A", kind: "group" as const, objectIds: ["a", "b"] },
      { id: "group-b", name: "B", kind: "group" as const, objectIds: ["c", "d"] },
    ];
    const recordSceneEdit = vi.fn();
    const commands = createSceneOrganizationCommands({
      locale: "zh-CN",
      sceneOrganizationObjects: ["a", "b", "c", "d"].map((id) => ({ id, name: id, kind: "primitive" as const, visible: true, locked: false })),
      sceneOrganizationSelection: new Set(["b"]),
      selectionSets: sets,
      setMessage: vi.fn(),
      setRevision: (next: SetStateAction<number>) => { revision = typeof next === "function" ? next(revision) : next; },
      setSelectionSets: (next: SetStateAction<typeof sets>) => { sets = typeof next === "function" ? next(sets) : next; },
      recordSceneEdit,
    } as unknown as SceneEditorControllerContext);

    commands.moveSceneObjectsToGroup(["b"], "group-b", "d");

    expect(sets.map((set) => set.objectIds)).toEqual([["a"], ["c", "b", "d"]]);
    expect(revision).toBe(8);
    expect(recordSceneEdit).toHaveBeenCalledWith("移动对象到编组");
  });
});
