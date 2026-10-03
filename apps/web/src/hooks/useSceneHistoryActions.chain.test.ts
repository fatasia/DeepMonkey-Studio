import { afterEach, describe, expect, it, vi } from "vitest";
import { deletionFixture } from "../studio/editorPrimitiveDeletion.testUtils";
import { createScenePersistenceController } from "../controllers/scenePersistenceController";
import { useSceneHistoryState } from "./useSceneHistoryState";
import { useSceneHistoryActions } from "./useSceneHistoryActions";

vi.mock("react", () => ({ useRef: (current: unknown) => ({ current }), useState: (value: unknown) => [value, vi.fn()], useEffect: vi.fn() }));
vi.mock("react-dom", () => ({ flushSync: (change: () => void) => change() }));

const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).reverse().forEach(dispose => dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** Reuses the existing real Viewer primitive/snapshot/persistence fixture; no renderer or second host. */
function chainFixture() {
  vi.useFakeTimers();
  vi.stubGlobal("window", { setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay), clearTimeout });
  const f = deletionFixture();
  disposals.push(f.cleanup);
  const context = f.context;
  const update = (field: string) => (value: unknown) => {
    Reflect.set(context, field, typeof value === "function" ? value(Reflect.get(context, field)) : value);
  };
  for (const [setter, field] of [
    ["setActiveScene", "activeScene"], ["setSceneName", "sceneName"], ["setRevision", "revision"],
    ["setSelectionSets", "selectionSets"], ["setRootLayerOrder", "rootLayerOrder"],
    ["setSceneInteractions", "sceneInteractions"], ["setSceneDataBindings", "sceneDataBindings"],
    ["setSceneAssetBindings", "sceneAssetBindings"], ["setSceneDashboard", "sceneDashboard"],
    ["setEngineeringAnalysis", "engineeringAnalysis"], ["setCameraViews", "cameraViews"],
    ["setDefaultCameraViewId", "defaultCameraViewId"], ["setSceneCoordinates", "sceneCoordinates"],
  ]) Reflect.set(context, setter!, update(field!));
  context.revision = 7;
  context.activeScene = f.capture();
  context.getActiveScene = () => context.activeScene;
  const history = useSceneHistoryState({ activeScene: context.activeScene, routeView: "studio", sceneBehaviorActive: false, animationPlaying: false });
  const persistence = createScenePersistenceController(context);
  const capture = () => persistence.makeSnapshot()!;
  history.sceneSnapshotFactoryRef.current = capture;
  history.sceneHistoryRef.current.reset(capture());
  const applyScene = vi.fn(persistence.applyScene);
  const showError = vi.fn();
  Reflect.set(context, "showError", showError);
  const actions = () => useSceneHistoryActions({ state: context as unknown as Parameters<typeof useSceneHistoryActions>[0]["state"], history, applyScene });
  const edit = (label: string, change: () => void) => {
    history.runSceneHistoryEdit(change);
    history.sceneHistoryRecordRef.current(label);
    vi.advanceTimersByTime(220);
  };
  return { ...f, context, history, capture, actions, edit, applyScene, showError };
}

describe("H-C7-P4 C2 real history → applyScene chain", () => {
  it("reverts the second consecutive undo rather than consuming a restoration-only phantom entry", async () => {
    const f = chainFixture();
    const transform = (x: number) => f.engine.setModelTransform("victim", { position: [x, 0, 0] });
    f.edit("移动一", () => transform(2));
    f.edit("移动二", () => transform(4));
    await f.actions().undoSceneEdit();
    expect(f.engine.getModelTransform("victim")!.position.x).toBe(2);
    const restored = f.capture();
    await f.actions().undoSceneEdit();
    expect(f.engine.getModelTransform("victim")!.position.x).toBe(0);
    expect(f.showError).not.toHaveBeenCalled();
    expect(f.history.sceneHistoryRef.current.getState().canUndo).toBe(false);
  });

  it("round-trips ten distinct edits through all ten undo and redo steps with normalized material readback", async () => {
    const f = chainFixture();
    const inspect = () => {
      const scene = f.capture();
      return {
        name: scene.name, groups: scene.selectionSets,
        objects: scene.primitives.map(p => ({ id: p.modelId, name: p.name, position: p.transform.position,
          rotation: p.transform.rotation, scale: p.transform.scale, roughness: p.material?.roughness,
          metalness: p.material?.metalness, color: p.material?.color,
          renderedColor: f.mesh(p.modelId).material.color.getHexString() })).sort((a, b) => a.id.localeCompare(b.id)),
      };
    };
    const target = () => f.models.get("victim")!.object;
    const steps: Array<[string, () => void]> = [
      ["位置 X", () => f.engine.setModelTransform("victim", { position: [2, 1, 0] })],
      ["位置 Y", () => f.engine.setModelTransform("victim", { position: [2, 3, 0] })],
      ["旋转", () => f.engine.setModelTransform("victim", { rotation: [0, 0, Math.PI / 4] })],
      ["缩放", () => f.engine.setModelTransform("victim", { scale: [2, 1, 0.5] })],
      ["粗糙度", () => Reflect.get(f.engine, "applyMaterialState").call(f.engine, target(), { roughness: 0.25 })],
      ["颜色分级", () => Reflect.get(f.engine, "applyMaterialState").call(f.engine, target(), { brightness: 0.35, contrast: -0.3 })],
      ["重命名对象", () => f.engine.rename("victim", "检修对象")],
      ["创建编组", () => { f.context.selectionSets = [{ id: "group", name: "检修组", objectIds: ["victim", "keep"] }]; }],
      ["重命名场景", () => { f.context.sceneName = "检修场景"; }],
      ["移动旁观对象", () => f.engine.setModelTransform("keep", { position: [-3, 1, 0] })],
    ];
    const states = [inspect()];
    for (const [label, change] of steps) { f.edit(label, change); states.push(inspect()); }
    const startRevision = f.context.revision;
    for (let i = steps.length - 1; i >= 0; i--) {
      await f.actions().undoSceneEdit();
      expect(inspect()).toEqual(states[i]);
    }
    expect(f.history.sceneHistoryRef.current.getState()).toMatchObject({ canUndo: false, canRedo: true });
    for (let i = 1; i <= steps.length; i++) {
      await f.actions().redoSceneEdit();
      expect(inspect()).toEqual(states[i]);
    }
    expect(f.context.revision).toBe(startRevision + 20);
    expect(f.history.sceneHistoryRef.current.getState()).toMatchObject({ canUndo: true, canRedo: false });
    expect(f.showError).not.toHaveBeenCalled();
    expect(f.applyScene).toHaveBeenCalledTimes(20);
  });

  it("absorbs late restoration notifications without consuming redo, but still records a subsequent user edit", async () => {
    const f = chainFixture();
    f.edit("移动一", () => f.engine.setModelTransform("victim", { position: [2, 0, 0] }));
    f.edit("移动二", () => f.engine.setModelTransform("victim", { position: [4, 0, 0] }));
    await f.actions().undoSceneEdit();
    const version = f.history.sceneHistoryRef.current.revision;
    f.history.sceneHistoryRecordRef.current("迟到的引擎恢复通知");
    vi.advanceTimersByTime(500);
    expect(f.history.sceneHistoryRef.current.revision).toBe(version);
    expect(f.history.sceneHistoryRef.current.getState().canRedo).toBe(true);
    f.edit("新的作者编辑", () => f.engine.setModelTransform("victim", { position: [6, 0, 0] }));
    expect(f.history.sceneHistoryRef.current.getState().canRedo).toBe(false);
    await f.actions().undoSceneEdit();
    expect(f.engine.getModelTransform("victim")!.position.x).toBe(2);
  });

  it("refuses repeated actions while restore is pending and compensates a strict load failure before retry", async () => {
    const f = chainFixture();
    f.edit("移动", () => f.engine.setModelTransform("victim", { position: [2, 0, 0] }));
    let reject!: (reason: Error) => void;
    f.applyScene.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const action = f.actions();
    const pending = action.undoSceneEdit();
    await action.undoSceneEdit(); await action.redoSceneEdit();
    expect(f.applyScene).toHaveBeenCalledTimes(1);
    expect(f.applyScene.mock.calls[0]?.slice(3)).toEqual([false, false, false, true]);
    reject(new Error("模型加载失败")); await pending;
    expect(f.history.sceneHistoryRef.current.getState()).toMatchObject({ canUndo: true, canRedo: false });
    expect(f.engine.getModelTransform("victim")!.position.x).toBe(2);
    expect(f.history.sceneHistoryApplyingRef.current).toBe(false);
    await f.actions().undoSceneEdit();
    expect(f.engine.getModelTransform("victim")!.position.x).toBe(0);
  });

  it("commits a pending user gesture before redo rather than discarding a new branch", async () => {
    const f = chainFixture();
    f.edit("移动", () => f.engine.setModelTransform("victim", { position: [2, 0, 0] }));
    await f.actions().undoSceneEdit();
    f.engine.setModelTransform("victim", { position: [9, 0, 0] });
    f.history.sceneHistoryRecordRef.current("尚未防抖落栈的作者手势");
    await f.actions().redoSceneEdit();
    expect(f.engine.getModelTransform("victim")!.position.x).toBe(9);
    expect(f.history.sceneHistoryRef.current.getState().canRedo).toBe(false);
    expect(f.applyScene).toHaveBeenCalledTimes(1);
  });

  it("rejects a stale restore result after a newer authored revision without compensating the newer stack", async () => {
    const f = chainFixture();
    f.edit("移动", () => f.engine.setModelTransform("victim", { position: [2, 0, 0] }));
    let release!: () => void;
    f.applyScene.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(); }));
    const pending = f.actions().undoSceneEdit();
    f.engine.setModelTransform("victim", { position: [99, 0, 0] });
    f.history.sceneHistoryRef.current.record(f.capture(), "并行作者更新");
    const version = f.history.sceneHistoryRef.current.revision;
    release(); await pending;
    expect(f.history.sceneHistoryRef.current.revision).toBe(version);
    expect(f.history.sceneHistoryRef.current.getState().undoLabel).toBe("并行作者更新");
    expect(f.engine.getModelTransform("victim")!.position.x).toBe(99);
    expect(f.showError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("版本") }));
  });
});
