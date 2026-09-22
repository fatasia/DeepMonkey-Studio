import type { SetStateAction } from "react";
import type { SceneSelectionSetState, SceneSnapshot } from "@bim-studio/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSceneOrganizationCommands } from "../controllers/sceneOrganizationCommands";
import type { SceneEditorControllerContext } from "../controllers/sceneEditorControllerContext";
import { SceneAuthoringHistory } from "./sceneAuthoringHistory";
import { runSceneHistoryTransaction } from "./sceneHistoryTransaction";

function harness() {
  let snapshot = { schemaVersion: 1, id: "s", projectId: "p", name: "初始", models: [], primitives: [], measurements: [],
    camera: { position: { x: 1, y: 1, z: 1 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    createdAt: "", updatedAt: "", selectionSets: [{ id: "g", name: "初始组", kind: "group", objectIds: ["a", "b"] }] } as SceneSnapshot;
  const history = new SceneAuthoringHistory(); history.reset(snapshot);
  let timer: ReturnType<typeof setTimeout> | undefined, label = "";
  const pending: Array<() => void> = [];
  const flush = () => { clearTimeout(timer); timer = undefined; history.record(snapshot, label); };
  const record = (next: string) => { clearTimeout(timer); label = next; timer = setTimeout(flush, 220); };
  const commands = createSceneOrganizationCommands({
    locale: "zh-CN", selectionSets: snapshot.selectionSets, sceneOrganizationSelection: new Set(["a", "b"]),
    sceneOrganizationObjects: ["a", "b"].map(id => ({ id, name: id, kind: "primitive", visible: true, locked: false })),
    setSelectionSets: (update: SetStateAction<SceneSelectionSetState[]>) => pending.push(() => {
      snapshot = { ...snapshot, selectionSets: typeof update === "function" ? update(snapshot.selectionSets!) : update };
    }),
    setRevision: vi.fn(), setMessage: vi.fn(), recordSceneEdit: record,
    runSceneEdit: (change: () => void) => runSceneHistoryTransaction(change, flush, action => { action(); pending.splice(0).forEach(commit => commit()); }),
  } as unknown as SceneEditorControllerContext);
  return { commands, history, changeContinuously: (name: string) => { snapshot = { ...snapshot, name }; record("连续变换"); } };
}

afterEach(() => vi.useRealTimers());
describe("scene organization history transaction", () => {
  it("records two rapid discrete actions against committed author state", () => {
    vi.useFakeTimers(); const { commands, history } = harness();
    commands.renameSceneGroup("g", "一"); commands.renameSceneGroup("g", "二");
    expect(history.undo()?.selectionSets?.[0]?.name).toBe("一");
    expect(history.undo()?.selectionSets?.[0]?.name).toBe("初始组");
    expect(history.getState().canUndo).toBe(false);
    expect(history.redo()?.selectionSets?.[0]?.name).toBe("一");
    expect(history.redo()?.selectionSets?.[0]?.name).toBe("二");
    vi.advanceTimersByTime(220); expect(history.undo()?.selectionSets?.[0]?.name).toBe("一");
  });
  it("separates a pending continuous gesture from the next discrete action", () => {
    vi.useFakeTimers(); const { commands, history, changeContinuously } = harness();
    changeContinuously("移动1"); changeContinuously("移动2");
    commands.renameSceneGroup("g", "离散");
    expect(history.undo()).toMatchObject({ name: "移动2", selectionSets: [{ name: "初始组" }] });
    expect(history.undo()).toMatchObject({ name: "初始" }); expect(history.getState().canUndo).toBe(false);
  });
  it("retains continuous debounce and no-op history deduplication", () => {
    vi.useFakeTimers(); const { commands, history, changeContinuously } = harness();
    commands.renameSceneGroup("g", "初始组"); expect(history.getState().canUndo).toBe(false);
    changeContinuously("1"); vi.advanceTimersByTime(100); changeContinuously("2");
    vi.advanceTimersByTime(219); expect(history.getState().canUndo).toBe(false);
    vi.advanceTimersByTime(1); expect(history.undo()?.name).toBe("初始"); expect(history.getState().canUndo).toBe(false);
  });
});
