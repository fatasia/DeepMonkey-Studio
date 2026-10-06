import { describe, expect, it } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { SceneAuthoringHistory } from "./sceneAuthoringHistory";

function scene(): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name: "产线",
    camera: { position: { x: 6, y: 5, z: 6 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [],
    primitives: [],
    measurements: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z"
  };
}

describe("SceneAuthoringHistory", () => {
  it("accepts normalized restore readback without an entry or redo loss, preserving each original step", () => {
    const history = new SceneAuthoringHistory();
    const baseline = scene(); history.reset(baseline);
    const first = { ...baseline, name: "A" }, second = { ...baseline, name: "B" };
    history.record(first, "A"); history.record(second, "B");
    expect(history.undo()).toEqual(first);
    const readback = { ...first, dashboard: { side: "right" as const, width: 410, widgets: [] } };
    const state = history.getState(), revision = history.revision;
    history.acceptRestoredScene(readback, revision);
    expect(history.getState()).toEqual(state);
    expect(history.record(readback, "恢复通知")).toBe(false);
    readback.name = "污染读回对象";
    expect(history.undo()).toEqual(baseline);
    expect(history.redo()).toEqual(first);
    expect(history.redo()).toEqual(second);
  });

  it("rejects restoring over a newer revision or a different scene without moving the stack", () => {
    const history = new SceneAuthoringHistory();
    const baseline = scene(); history.reset(baseline);
    history.record({ ...baseline, name: "A" }, "A");
    const restored = history.undo()!, oldRevision = history.revision;
    history.record({ ...baseline, name: "较新作者版本" }, "新编辑");
    const state = history.getState(), revision = history.revision;
    expect(() => history.acceptRestoredScene(restored, oldRevision)).toThrow("版本");
    expect(() => history.acceptRestoredScene({ ...restored, id: "other" }, revision)).toThrow("所属场景");
    expect(history.getState()).toEqual(state);
    expect(history.revision).toBe(revision);
    expect(history.undo()?.name).toBe(baseline.name);
  });
  it("undoes root order and group membership together, then restores the saved order on redo", () => {
    const history = new SceneAuthoringHistory();
    const baseline = { ...scene(), selectionSets: [{ id: "g", kind: "group" as const, name: "Group", objectIds: ["child"] }] };
    const moved = { ...baseline, selectionSets: [{ ...baseline.selectionSets[0]!, objectIds: [] }],
      rootLayerOrder: [{ kind: "object" as const, id: "child" }, { kind: "group" as const, id: "g" }] };
    history.reset(baseline);
    expect(history.record(moved, "移出编组并排序")).toBe(true);
    expect(history.undo()).toEqual(baseline);
    expect(history.redo()).toEqual(moved);
    expect(baseline).not.toHaveProperty("rootLayerOrder");
  });
  it("keeps draft undo and redo while adopting the first saved identity", () => {
    const history = new SceneAuthoringHistory();
    const baseline = scene(); history.reset(baseline);
    history.record({ ...baseline, id: "temporary-2", name: "A" }, "A");
    history.record({ ...baseline, id: "temporary-3", name: "B" }, "B");
    history.undo();
    const state = history.getState();
    const saved = { ...baseline, id: "persisted", createdAt: "2026-09-09T00:00:00Z" };
    history.adoptSceneIdentity(saved);
    expect(history.getState()).toEqual(state);
    expect(history.redo()).toMatchObject({ id: "persisted", name: "B", createdAt: saved.createdAt });
    expect(history.undo()).toMatchObject({ id: "persisted", name: "A" });
    expect(history.undo()).toMatchObject({ id: "persisted", name: baseline.name });
  });

  it("ignores temporary draft identity changes and does not carry history into another project", () => {
    const history = new SceneAuthoringHistory(); const baseline = scene(); history.reset(baseline);
    expect(history.record({ ...baseline, id: "fresh-draft", createdAt: "later" }, "采样")).toBe(false);
    history.record({ ...baseline, name: "A" }, "A");
    history.adoptSceneIdentity({ ...baseline, projectId: "other-project", id: "other" });
    expect(history.getState().canUndo).toBe(false);
  });
  it("undoes and redoes one authored scene change", () => {
    const history = new SceneAuthoringHistory();
    const baseline = scene();
    history.reset(baseline);
    history.record({ ...baseline, name: "装配产线" }, "重命名场景");

    expect(history.getState()).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "重命名场景" });
    expect(history.undo()?.name).toBe("产线");
    expect(history.redo()?.name).toBe("装配产线");
  });

  it("ignores timestamps and selection-only changes", () => {
    const history = new SceneAuthoringHistory();
    const baseline = scene();
    history.reset(baseline);

    expect(history.record({ ...baseline, updatedAt: "2026-08-29T00:01:00.000Z", selectedModelId: "model-1" }, "选择对象")).toBe(false);
    expect(history.getState().canUndo).toBe(false);
  });

  it("clears redo after branching and keeps the configured limit", () => {
    const history = new SceneAuthoringHistory(2);
    const baseline = scene();
    history.reset(baseline);
    history.record({ ...baseline, name: "A" }, "A");
    history.record({ ...baseline, name: "B" }, "B");
    history.record({ ...baseline, name: "C" }, "C");
    expect(history.undo()?.name).toBe("B");
    history.record({ ...baseline, name: "D" }, "D");
    expect(history.getState().canRedo).toBe(false);
    expect(history.undo()?.name).toBe("B");
    expect(history.undo()?.name).toBe("A");
    expect(history.undo()).toBeUndefined();
  });

  it("does not let a generated save thumbnail consume undo or clear redo", () => {
    const history = new SceneAuthoringHistory();
    const baseline = { ...scene(), thumbnail: "before" };
    history.reset(baseline);
    const replaced = { ...baseline, models: [{ modelId: "instance", assetModelId: "replacement" }] } as SceneSnapshot;
    history.record(replaced, "替换素材");
    history.record({ ...replaced, models: [] }, "移除实例");
    expect(history.record({ ...replaced, models: [], thumbnail: "generated-on-save" }, "编辑三维场景")).toBe(false);
    expect(history.undo()?.models[0]).toMatchObject({ modelId: "instance", assetModelId: "replacement" });
    expect(history.record({ ...replaced, thumbnail: "regenerated" }, "编辑三维场景")).toBe(false);
    expect(history.getState().canRedo).toBe(true);
    expect(history.redo()?.models).toHaveLength(0);
  });

  it("absorbs restore-tail convergence into current without an entry or redo loss", () => {
    // 门10 undo/redo 竞态回归：恢复完成后迟到的引擎收敛若经 record 落栈，会以
    // "编辑三维场景"清空重做栈，令紧随的 redo 变静默空操作。absorb 必须只对齐 current。
    const history = new SceneAuthoringHistory();
    const baseline = scene(); history.reset(baseline);
    const deleted = { ...baseline, primitives: [{ modelId: "device-2", kind: "box" as const, name: "设备 002" }] } as unknown as SceneSnapshot;
    history.record(deleted, "删除基础元素");
    expect(history.undo()).toEqual(baseline);
    const state = history.getState();
    // 恢复后引擎收敛:测量等作者域出现迟到差异。
    const converged = { ...baseline, measurements: [{ id: "m1" }] } as unknown as SceneSnapshot;
    expect(history.absorb(converged)).toBe(true);
    expect(history.getState()).toEqual(state);
    // 收敛后的同源快照不再产生条目;用户重做仍然有效。
    expect(history.record(converged, "编辑三维场景")).toBe(false);
    expect(history.redo()).toEqual(deleted);
    // 指纹一致时 absorb 是空操作。
    expect(history.absorb(deleted)).toBe(false);
  });
});
