import { describe, expect, it } from "vitest";
import pureFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type ApplicationDocument, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore } from "./applicationStore.js";
import { mergeApplicationSave } from "./applicationSaveMerge.js";
import { createRenameApplicationCommand, createRenameDashboardPageCommand, createUpsertScriptModuleCommand } from "./command.js";

const document = () => migrateSceneSnapshotV1(pureFixture as SceneSnapshot);
function withExternalModel(base: ApplicationDocument) {
  const saved = structuredClone(base);
  saved.metadata.revision++;
  saved.scenes[0]!.models.push({ modelId: "gripper", name: "夹爪", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
  saved.scenes[0]!.thumbnail = "data:image/png;base64,fixture";
  return saved;
}

describe("application save reconciliation", () => {
  it("adopts externally captured models into a frozen store while retaining transient state", () => {
    const store = new ApplicationStore(document());
    const baseline = store.getState().document!;
    store.setSelection([{ kind: "page", id: baseline.pages[0]!.id }]);
    store.setVariable("temperature", 23); store.setFilter("line", "A");
    const saved = withExternalModel(baseline);
    store.acknowledgeSave(saved, baseline);
    expect(store.getState().document).toEqual(saved);
    expect(store.getState()).toMatchObject({ dirty: false, variables: { temperature: 23 }, filters: { line: "A" }, selection: [{ kind: "page", id: baseline.pages[0]!.id }] });
    expect(Object.isFrozen(store.getState().document?.scenes[0]?.models)).toBe(true);
    expect(baseline.scenes[0]!.models).toEqual([]);
  });

  it("keeps concurrent 2D and script edits without discarding the returned model", () => {
    const store = new ApplicationStore(document());
    const baseline = store.getState().document!;
    const saved = withExternalModel(baseline);
    store.dispatch(createRenameDashboardPageCommand(baseline.pages[0]!.id, "请求期间修改页面"));
    store.dispatch(createUpsertScriptModuleCommand({ id: "new-script", name: "新脚本", enabled: true,
      apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", code: "export function onStart() {}",
      lifecycle: ["onStart"], capabilities: ["studio.runtime"], permissions: ["scene.read"] }));
    store.acknowledgeSave(saved, baseline);
    const state = store.getState();
    expect(state.document?.scenes[0]?.models).toEqual(saved.scenes[0]!.models);
    expect(state.document?.pages[0]?.name).toBe("请求期间修改页面");
    expect(state.document?.scripts[0]?.id).toBe("new-script");
    expect(state.dirty).toBe(true);
    expect(store.undo()).toBe(true);
    expect(store.getState().document?.scenes[0]?.models).toEqual(saved.scenes[0]!.models);
  });

  it("rebases both undo and redo snapshots without adding a synthetic history command", () => {
    const store = new ApplicationStore(document());
    store.dispatch(createRenameApplicationCommand("第一次命名"));
    store.dispatch(createRenameApplicationCommand("第二次命名"));
    store.undo();
    const baseline = store.getState().document!;
    const saved = withExternalModel(baseline);
    store.acknowledgeSave(saved, baseline);
    expect(store.getState()).toMatchObject({ dirty: false, canUndo: true, canRedo: true });
    store.redo(); expect(store.getState().document?.metadata.name).toBe("第二次命名");
    expect(store.getState().document?.scenes[0]?.models).toEqual(saved.scenes[0]!.models);
    store.undo(); store.undo();
    expect(store.getState().document?.metadata.name).toBe("纯三维");
    expect(store.getState().document?.scenes[0]?.models).toEqual(saved.scenes[0]!.models);
    expect(store.undo()).toBe(false);
  });

  it("retains local model edits and imports unrelated server models by model identity", () => {
    const baseline = withExternalModel(document());
    const current = structuredClone(baseline), saved = structuredClone(baseline);
    current.scenes[0]!.models[0]!.transform.position.x = 9;
    current.scenes[0]!.name = "正在编辑场景";
    saved.scenes[0]!.models[0]!.opacity = .6;
    saved.scenes[0]!.models.push({ ...structuredClone(saved.scenes[0]!.models[0]!), modelId: "new-model" });
    const merged = mergeApplicationSave(current, baseline, saved);
    expect(merged.scenes[0]!.name).toBe("正在编辑场景");
    expect(merged.scenes[0]!.models[0]).toMatchObject({ opacity: .6, transform: { position: { x: 9 } } });
    expect(merged.scenes[0]!.models.map(model => model.modelId)).toEqual(["gripper", "new-model"]);
  });

  it("does not resurrect locally deleted objects and accepts unchanged server deletions", () => {
    const baseline = withExternalModel(document());
    const current = structuredClone(baseline), saved = structuredClone(baseline);
    current.scenes[0]!.models = [];
    saved.scenes[0]!.models[0]!.name = "服务端名称";
    expect(mergeApplicationSave(current, baseline, saved).scenes[0]!.models).toEqual([]);
    const local = structuredClone(baseline); local.metadata.name = "本地应用名";
    saved.scenes[0]!.models = [];
    expect(mergeApplicationSave(local, baseline, saved).scenes[0]!.models).toEqual([]);
  });

  it("preserves newer local scalar/array conflicts and local collection ordering", () => {
    const baseline = document(); baseline.data.connectionIds = ["A"];
    baseline.pages.push({ ...structuredClone(baseline.pages[0]!), id: "second" });
    const current = structuredClone(baseline), saved = structuredClone(baseline);
    current.data.connectionIds = ["A", "local"]; saved.data.connectionIds = ["A", "remote"];
    current.pages.reverse(); saved.pages[0]!.name = "服务端页名";
    current.metadata.name = "本地名"; saved.metadata.name = "服务端名";
    const merged = mergeApplicationSave(current, baseline, saved);
    expect(merged.data.connectionIds).toEqual(["A", "local"]);
    expect(merged.metadata.name).toBe("本地名");
    expect(merged.pages.map(page => page.id)).toEqual(current.pages.map(page => page.id));
    expect(merged.pages[1]!.name).toBe("服务端页名");
  });

  it("does not erase earlier scene field values when rebasing a history snapshot", () => {
    const baseline = withExternalModel(document());
    const historical = structuredClone(baseline), saved = structuredClone(baseline);
    historical.scenes[0]!.models[0]!.opacity = .25;
    historical.pages[0]!.name = "之前的页面名";
    saved.scenes[0]!.thumbnail = "data:image/png;base64,new-preview";
    saved.scenes[0]!.models.push({ ...structuredClone(saved.scenes[0]!.models[0]!), modelId: "external-second" });
    const rebased = mergeApplicationSave(historical, baseline, saved);
    expect(rebased.scenes[0]!.models[0]!.opacity).toBe(.25);
    expect(rebased.pages[0]!.name).toBe("之前的页面名");
    expect(rebased.scenes[0]!.thumbnail).toBe(saved.scenes[0]!.thumbnail);
    expect(rebased.scenes[0]!.models.map(model => model.modelId)).toEqual(["gripper", "external-second"]);
  });

  it("ignores cross-application/project acknowledgements and older response revisions", () => {
    const store = new ApplicationStore(document());
    const baseline = store.getState().document!;
    const saved = withExternalModel(baseline);
    store.acknowledgeSave({ ...saved, metadata: { ...saved.metadata, id: "other" } }, baseline);
    store.acknowledgeSave({ ...saved, metadata: { ...saved.metadata, projectId: "other" } }, baseline);
    expect(store.getState().document).toBe(baseline);
    store.acknowledgeSave(saved, baseline);
    const accepted = store.getState().document;
    store.acknowledgeSave(baseline, baseline);
    expect(store.getState().document).toBe(accepted);
  });

  it("does not reopen an empty store from a late explicit save baseline", () => {
    const store = new ApplicationStore();
    const baseline = document();
    store.acknowledgeSave(withExternalModel(baseline), baseline);
    expect(store.getState().document).toBeUndefined();
  });
});
