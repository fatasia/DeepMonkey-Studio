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
});
