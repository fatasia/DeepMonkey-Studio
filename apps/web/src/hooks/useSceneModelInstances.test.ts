import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { AppViewBindings } from "../views/appViewBindings";
import { SceneAuthoringHistory } from "../studio/sceneAuthoringHistory";
import type { SceneEditHistoryFlush, SceneEditTransaction } from "./useSceneHistoryState";
import { createSceneEditTransaction } from "./useSceneHistoryState";

vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }), useState: (value: unknown) => [value, vi.fn()], useEffect: vi.fn() }));
vi.mock("../viewer/captureSceneModelState", () => ({ captureSceneModelState: () => ({ locked: true }) }));
import { useSceneModelInstances } from "./useSceneModelInstances";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  vi.useFakeTimers();
  const models = [{ id: "instance", assetModelId: "original", name: "夹爪", kind: "model", x: 0 }];
  const assets = ["original", "replacement"].map(id => ({ id, status: "ready", manifest: { modelId: id } })) as ModelRecord[];
  const history = new SceneAuthoringHistory();
  const snapshot = () => ({ id: "scene", projectId: "project", models: models.map(item => ({ modelId: item.id, assetModelId: item.assetModelId, x: item.x })) }) as unknown as SceneSnapshot;
  history.reset(snapshot());
  let pending: ReturnType<typeof setTimeout> | undefined;
  const flush = vi.fn((label = "连续编辑") => { clearTimeout(pending); history.record(snapshot(), label); }) as unknown as SceneEditHistoryFlush;
  // T27：夹具复用生产事务工厂，保证 begin/commit/rollback 语义与 hook 一致。
  const transactionOpen: { current: SceneEditTransaction | undefined } = { current: undefined };
  flush.beginTransaction = (label: string) => createSceneEditTransaction(transactionOpen, {
    flush: () => flush(),
    capture: () => snapshot(),
    record: (next, txLabel) => { history.record(next, txLabel); },
  }, label);
  const engine = {
    listModels: () => models,
    isModelLocked: () => false,
    select: vi.fn(),
    removeModel: vi.fn((id: string) => { const at = models.findIndex(item => item.id === id); if (at >= 0) models.splice(at, 1); }),
    replaceModelManifest: vi.fn(async (id: string, manifest: { modelId: string }) => { models.find(item => item.id === id)!.assetModelId = manifest.modelId; }),
    loadManifest: vi.fn(async (manifest: { modelId: string }, id: string) => { const loaded = { id, assetModelId: manifest.modelId, name: "loaded", kind: "model", x: 0 }; models.push(loaded); return loaded; }),
    applyModelState: vi.fn(),
    rename: vi.fn((id: string, name: string) => { models.find(item => item.id === id)!.name = name; }),
  };
  const recordSceneEdit = vi.fn((label: string) => { clearTimeout(pending); pending = setTimeout(() => flush(label), 220); });
  const applyScene = vi.fn(async () => undefined);
  const showError = vi.fn();
  const bindings = {
    state: { route: { view: "studio" }, project: { id: "project", models: assets }, activeScene: { id: "scene" }, engine,
      setBusy: vi.fn(), setSceneOrganizationSelection: vi.fn(), setRevision: vi.fn(), setMessage: vi.fn(), showError },
    sceneHistory: { flush }, sceneEditor: { recordSceneEdit },
    scenePersistence: { applyScene },
  } as unknown as AppViewBindings;
  return { models, assets, history, engine, flush, recordSceneEdit, bindings, actions: useSceneModelInstances(bindings), applyScene, showError };
}

describe("model instance command history", () => {
  it("keeps replacement and immediate removal separately undoable without waiting for debounce", async () => {
    const h = fixture();
    await h.actions.replace("instance", h.assets[1]!);
    h.actions.remove("instance");
    expect(h.models).toHaveLength(0);
    expect(h.history.undo()?.models[0]).toMatchObject({ modelId: "instance", assetModelId: "replacement" });
    expect(h.history.undo()?.models[0]).toMatchObject({ modelId: "instance", assetModelId: "original" });
    expect(h.history.redo()?.models[0]?.assetModelId).toBe("replacement");
    expect(h.history.redo()?.models).toHaveLength(0);
    vi.runAllTimers();
    expect(h.recordSceneEdit).not.toHaveBeenCalled();
  });

  it("flushes a pending transform before replacing and preserves that separate undo boundary", async () => {
    const h = fixture();
    h.models[0]!.x = 0.14;
    h.recordSceneEdit("平移");
    await h.actions.replace("instance", h.assets[1]!);
    expect(h.history.undo()?.models[0]).toMatchObject({ assetModelId: "original", x: 0.14 });
    expect(h.history.undo()?.models[0]).toMatchObject({ assetModelId: "original", x: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records independent duplicate creation before an immediate remove", async () => {
    const h = fixture();
    await h.actions.duplicate("instance");
    const copy = h.models.find(item => item.id !== "instance")!;
    expect(copy).toMatchObject({ name: "夹爪 副本", assetModelId: "original" });
    expect(h.engine.applyModelState).toHaveBeenCalledWith(copy.id, { locked: false });
    h.actions.remove(copy.id);
    expect(h.history.undo()?.models).toHaveLength(2);
    expect(h.history.undo()?.models).toHaveLength(1);
  });

  it("does not add a failed replacement to history and allows a successful retry", async () => {
    const h = fixture();
    h.engine.replaceModelManifest.mockRejectedValueOnce(new Error("503"));
    await h.actions.replace("instance", h.assets[1]!);
    expect(h.history.getState().canUndo).toBe(false);
    await h.actions.replace("instance", h.assets[1]!);
    expect(h.history.undo()?.models[0]?.assetModelId).toBe("original");
    expect(h.history.undo()).toBeUndefined();
  });

  it("passes live scene ownership to the replacement commit gate", async () => {
    const h = fixture();
    h.engine.replaceModelManifest.mockImplementationOnce(async (_id, _manifest, canCommit?: () => boolean) => {
      expect(canCommit?.()).toBe(true);
      h.bindings.state.activeScene = { id: "other" } as typeof h.bindings.state.activeScene;
      expect(canCommit?.()).toBe(false);
    });
    await h.actions.replace("instance", h.assets[1]!);
    expect(h.models[0]!.assetModelId).toBe("original");
    expect(h.history.getState().canUndo).toBe(false);
  });

  it("ignores locked or missing instances and duplicate pending commands", async () => {
    const h = fixture();
    vi.spyOn(h.engine, "isModelLocked").mockReturnValueOnce(true);
    h.actions.remove("instance"); h.actions.remove("missing");
    expect(h.flush).not.toHaveBeenCalled();
    let finish!: () => void;
    h.engine.replaceModelManifest.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = h.actions.replace("instance", h.assets[1]!);
    await h.actions.replace("instance", h.assets[1]!);
    h.actions.remove("instance");
    expect(h.engine.replaceModelManifest).toHaveBeenCalledOnce();
    expect(h.engine.removeModel).not.toHaveBeenCalled();
    finish(); await first;
    expect(h.bindings.state.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("commits a replacement as one transaction entry with stable instance identity", async () => {
    const h = fixture();
    await h.actions.replace("instance", h.assets[1]!);
    expect(h.history.getState().undoLabel).toBe("已替换素材，原有绑定与配置保留，可撤销");
    const restored = h.history.undo();
    expect(restored?.models).toHaveLength(1);
    expect(restored?.models[0]).toMatchObject({ modelId: "instance", assetModelId: "original" });
    expect(h.applyScene).not.toHaveBeenCalled();
    expect(h.showError).not.toHaveBeenCalled();
  });

  it("rolls a failed replacement back to the pre-transaction snapshot and closes the window", async () => {
    const h = fixture();
    h.engine.replaceModelManifest.mockRejectedValueOnce(new Error("几何桥解析失败"));
    await h.actions.replace("instance", h.assets[1]!);
    expect(h.applyScene).toHaveBeenCalledWith(
      expect.objectContaining({ models: [expect.objectContaining({ modelId: "instance", assetModelId: "original" })] }),
      false, expect.objectContaining({ id: "project" }), false,
    );
    expect(h.history.getState().canUndo).toBe(false);
    expect(h.showError).not.toHaveBeenCalled();
    await h.actions.replace("instance", h.assets[1]!);
    expect(h.history.undo()?.models[0]).toMatchObject({ modelId: "instance", assetModelId: "original" });
    expect(h.history.redo()?.models[0]).toMatchObject({ modelId: "instance", assetModelId: "replacement" });
  });

  it("commits an instance removal as a single undo unit", () => {
    const h = fixture();
    h.actions.remove("instance");
    expect(h.models).toHaveLength(0);
    expect(h.history.getState().undoLabel).toBe("移除场景实例（保留素材）");
    expect(h.history.undo()?.models[0]).toMatchObject({ modelId: "instance" });
  });
});
