import type { SetStateAction } from "react";
import { describe, expect, it, vi } from "vitest";
import { createSceneOrganizationCommands } from "./sceneOrganizationCommands";
import type { SceneEditorControllerContext } from "./sceneEditorControllerContext";

describe("场景组织命令", () => {
  it.each(["deleteSceneSelectionSet", "reorderSceneGroup", "updateSceneSelectionSet"] as const)("protects locked group members from %s without creating an undo entry", action => {
    const setSelectionSets = vi.fn();
    const recordSceneEdit = vi.fn();
    const commands = createSceneOrganizationCommands({
      locale: "zh-CN", selectionSets: [{ id: "group", name: "Mixed", kind: "group", objectIds: ["locked", "free"] }],
      sceneOrganizationObjects: ["locked", "free"].map(id => ({ id, name: id, kind: "primitive", visible: true, locked: id === "locked" })),
      sceneOrganizationSelection: new Set(["free"]), setSelectionSets, recordSceneEdit, setMessage: vi.fn(),
    } as unknown as SceneEditorControllerContext);
    commands[action]("group");
    expect(setSelectionSets).not.toHaveBeenCalled();
    expect(recordSceneEdit).not.toHaveBeenCalled();
  });
  it.each([{ additive: true }, { additive: true, range: true }])("preserves folded selections and drops deleted objects for %j", intent => {
    let selection = new Set(["folded", "deleted"]);
    const select = vi.fn();
    const commands = createSceneOrganizationCommands({
      engine: { select }, locale: "zh-CN",
      sceneOrganizationObjects: ["folded", "visible"].map(id => ({ id, name: id, kind: "primitive", visible: true, locked: false })),
      sceneOrganizationSelection: selection, selectionSets: [],
      setSceneOrganizationSelection: (next: SetStateAction<Set<string>>) => {
        selection = typeof next === "function" ? next(selection) : next;
      },
    } as unknown as SceneEditorControllerContext);

    commands.selectSceneOrganizationObject("visible", { ...intent, orderedIds: ["visible"], anchorId: "folded" });

    expect([...selection]).toEqual(["folded", "visible"]);
    expect(select).toHaveBeenCalledWith("visible");
  });

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

  it("keeps the clicked row selected without additive modifiers", () => {
    let selection = new Set(["base"]);
    const select = vi.fn();
    const commands = createSceneOrganizationCommands({
      engine: { select } as unknown as SceneEditorControllerContext["engine"],
      locale: "zh-CN",
      sceneOrganizationObjects: [{ id: "base", name: "base", kind: "primitive", visible: true, locked: false }],
      sceneOrganizationSelection: selection,
      selectionSets: [],
      setSceneOrganizationSelection: (next: SetStateAction<Set<string>>) => { selection = typeof next === "function" ? next(selection) : next; },
    } as unknown as SceneEditorControllerContext);

    commands.selectSceneOrganizationObject("base");

    expect(select).toHaveBeenCalledWith("base");
    expect([...selection]).toEqual(["base"]);
  });

  it("selects a contiguous Shift range and keeps the last clicked object primary", () => {
    let selection = new Set(["arm"]);
    const select = vi.fn();
    const commands = createSceneOrganizationCommands({
      engine: { select } as unknown as SceneEditorControllerContext["engine"],
      locale: "zh-CN",
      sceneOrganizationObjects: ["base", "arm", "joint", "tool"].map((id) => ({ id, name: id, kind: "primitive" as const, visible: true, locked: false })),
      sceneOrganizationSelection: selection,
      selectionSets: [],
      setSceneOrganizationSelection: (next: SetStateAction<Set<string>>) => {
        selection = typeof next === "function" ? next(selection) : next;
      },
    } as unknown as SceneEditorControllerContext);

    commands.selectSceneOrganizationObject("tool", { range: true });

    expect([...selection]).toEqual(["arm", "joint", "tool"]);
    expect(select).toHaveBeenCalledWith("tool");
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

  it("批 2 收编:批量显隐/锁定经命令总线后,engine setter 序列与直调逐项一致,提交链路不变", () => {
    const calls: string[] = [];
    const engine = {
      select: vi.fn(),
      setVisible: (id: string, visible: boolean) => calls.push(`setVisible:${id}:${visible}`),
      setModelLocked: (id: string, locked: boolean) => calls.push(`setModelLocked:${id}:${locked}`),
    };
    let revision = 0;
    const recordSceneEdit = vi.fn();
    const commands = createSceneOrganizationCommands({
      engine: engine as unknown as SceneEditorControllerContext["engine"],
      locale: "zh-CN",
      sceneOrganizationObjects: ["a", "b"].map((id) => ({ id, name: id, kind: "primitive" as const, visible: true, locked: false })),
      sceneOrganizationSelection: new Set<string>(),
      selectionSets: [],
      setMessage: vi.fn(),
      setRevision: (next: SetStateAction<number>) => { revision = typeof next === "function" ? next(revision) : next; },
      recordSceneEdit,
    } as unknown as SceneEditorControllerContext);

    // 直调参照(收编前实现):for (const id of ids) engine.setVisible(id, false)
    for (const id of ["a", "b"]) engine.setVisible(id, false);
    const directVisibleCalls = [...calls];
    calls.length = 0;

    commands.setSceneObjectsVisible(["a", "b"], false);

    expect(calls).toEqual(directVisibleCalls);
    expect(revision).toBe(1);
    expect(recordSceneEdit).toHaveBeenCalledWith("隐藏场景对象");

    calls.length = 0;
    // 直调参照(收编前实现):for (const id of ids) engine.setModelLocked(id, true)
    for (const id of ["a", "b"]) engine.setModelLocked(id, true);
    const directLockCalls = [...calls];
    calls.length = 0;

    commands.setSceneObjectsLocked(["a", "b"], true);

    expect(calls).toEqual(directLockCalls);
    expect(revision).toBe(2);
    expect(recordSceneEdit).toHaveBeenCalledWith("锁定场景对象");
  });
});
