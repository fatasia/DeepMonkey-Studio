import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type ApplicationDocument, type SceneSnapshot } from "@bim-studio/contracts";
import { createRenameApplicationCommand, createRenameDashboardPageCommand } from "@bim-studio/studio-core";
import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { ApplicationSession } from "../studio/applicationSession";
import { createScenePlayModeController } from "../hooks/useScenePlayMode";
import { ViewerSnapshotReadiness } from "../viewer/viewerSnapshotReadiness";
import { createPlaySessionRestore } from "./playSessionRestore";
import { createScenePersistenceController } from "./scenePersistenceController";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";

const mocks = vi.hoisted(() => ({ snapshot: vi.fn(), saveWorkspace: vi.fn(), saveScene: vi.fn(), writeRecovery: vi.fn(), deleteRecovery: vi.fn() }));
vi.mock("../api", () => ({ api: { saveApplicationWorkspace: mocks.saveWorkspace, saveScene: mocks.saveScene } }));
vi.mock("./sceneSnapshotFactory", () => ({ makeSceneSnapshot: mocks.snapshot }));
vi.mock("../studio/sceneThumbnailCapture", () => ({ captureSceneThumbnail: () => "data:image/jpeg;base64,fixture" }));
vi.mock("../studio/workspaceRecoveryStore", async original => ({ ...await original<object>(), writeWorkspaceRecoveryDraft: mocks.writeRecovery, deleteWorkspaceRecoveryDraft: mocks.deleteRecovery }));

function fixture() {
  const source = structuredClone(pureFixture) as SceneSnapshot;
  const application = migrateSceneSnapshotV1(source);
  const session = new ApplicationSession(); session.openDocument(application);
  const snapshot = structuredClone(source);
  snapshot.models.push({ modelId: "gripper", name: "夹爪", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } });
  mocks.snapshot.mockReturnValue(snapshot);
  mocks.saveWorkspace.mockImplementation(async (document: ApplicationDocument, scene: SceneSnapshot) => ({ application: { ...structuredClone(document), metadata: { ...document.metadata, revision: document.metadata.revision + 1 } }, scene: structuredClone(scene) }));
  const context = {
    engine: { isSceneSnapshotReady: vi.fn(() => true), bindSavedSceneSnapshot: vi.fn() },
    activeScene: source, activeApplication: application, project: { id: source.projectId },
    route: { view: "studio", projectId: source.projectId, sceneId: source.id, applicationId: application.metadata.id }, locale: "zh-CN",
    applicationSessionRef: { current: session }, revision: 3, sceneApplyVersionRef: { current: 1 },
    lastAutoSavedSceneRevisionRef: { current: 0 }, getActiveScene: () => source,
    setActiveScene: vi.fn(), setSceneName: vi.fn(), setScenes: vi.fn(), setMessage: vi.fn(), setBusy: vi.fn(), setAutoSaveEnabled: vi.fn(),
    showError: vi.fn(), sortScenesByTime: (items: SceneSnapshot[]) => items,
  } as unknown as ScenePersistenceControllerContext;
  return { session, application, snapshot, context, controller: createScenePersistenceController(context) };
}

beforeEach(() => { vi.clearAllMocks(); mocks.writeRecovery.mockResolvedValue(true); mocks.deleteRecovery.mockResolvedValue(undefined); });

function newSceneFixture() {
  const f = fixture();
  let active: SceneSnapshot | undefined;
  f.context.activeScene = undefined;
  f.context.activeApplication = undefined;
  f.context.route = { view: "studio", projectId: f.snapshot.projectId, sceneId: "new", modelId: "selected-asset" };
  f.context.getActiveScene = () => active;
  f.context.setActiveScene = vi.fn(update => { active = typeof update === "function" ? update(active) : update; });
  f.context.navigate = vi.fn();
  f.context.onFirstSceneSave = vi.fn();
  mocks.saveScene.mockImplementation(async scene => structuredClone(scene));
  return { ...f, controller: createScenePersistenceController(f.context), active: () => active, setActive: (scene: SceneSnapshot) => { active = scene; } };
}

describe("Play exits through the production scene persistence path", () => {
  function playFixture() {
    const f = fixture();
    const readiness = new ViewerSnapshotReadiness();
    readiness.begin(f.snapshot.id); readiness.complete(1);
    const scene = structuredClone(f.snapshot);
    const live = { x: 0 };
    const engine = {
      scene: { uuid: "viewer-1" },
      getAuthorRendererBackend: () => "webgl",
      isSceneSnapshotReady: (id: string) => readiness.ready(id, false, false),
      hasRestoredSceneSnapshot: (id: string) => readiness.ready(id, false, false),
      beginSceneSnapshotRestore: (id: string) => readiness.begin(id),
      completeSceneSnapshotRestore: (generation: number) => readiness.complete(generation),
      getPhysicsState: () => ({ enabled: false, playing: false, gravity: { x: 0, y: -9.81, z: 0 } }),
      setPhysicsState: vi.fn(), playSceneAnimation: vi.fn(), pauseSceneAnimation: vi.fn(), seekSceneAnimation: vi.fn(),
      getReadOnly: () => false, setReadOnly: vi.fn(), setFastRuntime: vi.fn(), clearSceneModels: vi.fn(),
      setInteractionScripts: vi.fn(), listModels: () => [{ id: "gripper", kind: "model" }],
      applyModelState: (_id: string, model: SceneSnapshot["models"][number]) => { live.x = model.transform.position.x; },
      rename: vi.fn(), clearMeasurements: vi.fn(), addMeasurementVisual: vi.fn(), addAnnotation: vi.fn(),
      listAnnotations: () => [], setCameraConstraints: vi.fn(), setNavigationSettings: vi.fn(), applyCamera: vi.fn(),
      setWeather: vi.fn(), setGlobalLighting: vi.fn(), setSceneEnvironment: vi.fn(), applyFloorStates: vi.fn(),
      setPostProcessing: vi.fn(), setSceneAnimation: vi.fn(), clearSceneModelsAndPrimitives: vi.fn(),
      setClipping: vi.fn(), select: vi.fn(), selectAnnotation: vi.fn(), selectLayer: vi.fn(),
      controlAnimation: vi.fn(),
      requestRender: vi.fn(),
    };
    const context = {
      ...f.context, engine, project: { id: scene.projectId, models: [{ id: "gripper", status: "ready", manifest: {} }] },
      activeScene: scene, setRevision: vi.fn(), isModelLoadSuperseded: (reason: unknown) => reason instanceof Error && reason.name === "ModelLoadSupersededError", primitiveColors: { current: new Map() },
      configuredDefaultEnvironment: {}, webGpuSceneReplacementCountRef: { current: 0 }, lastAutoSavedSceneRevisionRef: { current: 0 }, sceneInteractions: [], sceneDataBindings: [], sceneAssetBindings: [],
      selected: undefined, selectedLayerId: undefined, sceneName: scene.name, sceneDashboard: {},
      setActiveScene: vi.fn(), loadModel: vi.fn(async () => ({ id: "gripper" })),
    } as unknown as ScenePersistenceControllerContext;
    for (const name of [
      "setSceneInteractions", "setSceneDataBindings", "setSceneAssetBindings", "setSceneDataBindingRuntime", "setSelected", "setMeasurements",
      "setAnnotations", "setSelectedAnnotationId", "setSelectedLightId", "setSelectedSpace", "setSceneOrganizationSelection", "setSelectionSets",
      "setLastDeletedSelectionSet", "setCameraConstraints", "setNavigationSettings", "setCameraViews", "setDefaultCameraViewId", "setWeather",
      "setLighting", "setSceneEnvironment", "setSceneCoordinates", "setSceneAnimation", "setPostProcessing", "setPhysics", "setSceneDashboard",
      "setEngineeringAnalysis", "setAnimationTime", "setAnimationPlaying", "setClippingState", "setNavigationMode", "setAvatarVisible",
      "setViewerLoadState",
    ]) (context as unknown as Record<string, unknown>)[name] = vi.fn();
    const persistence = createScenePersistenceController(context);
    const errors: unknown[] = [];
    const play = createScenePlayModeController(() => ({
      engine,
      capture: () => structuredClone(scene), flush: () => undefined,
      applyScene: async (snapshot) => {
        await persistence.applyScene(snapshot, false, context.project, false, false, false, true);
        if (!engine.hasRestoredSceneSnapshot(snapshot.id)) throw new Error("场景恢复尚未完成");
      },
      readAnimationPlayhead: () => 0,
      reportError: (reason) => { errors.push(reason); },
    }), () => undefined);
    return { f, readiness, scene, live, engine, context, persistence, play, errors };
  }

  it("settles active only after the real apply completes the matching restore generation", async () => {
    const f = playFixture();
    expect(f.play.enterPlay()).toEqual({ ok: true });
    f.live.x = 1;
    const result = await f.play.exitPlay();
    expect(f.errors).toEqual([]);
    expect(result).toEqual({ ok: true });
    expect(f.live.x).toBe(0);
    expect(f.engine.hasRestoredSceneSnapshot(f.scene.id)).toBe(true);
    expect(f.play.active).toBe(false);
    expect(f.errors).toEqual([]);
  });

  it("rejects a competing restore generation before applying models, retains the Play snapshot, and succeeds on retry", async () => {
    const f = playFixture();
    expect(f.play.enterPlay()).toEqual({ ok: true });
    f.live.x = 1;
    let compete = true;
    vi.mocked(f.context.loadModel).mockImplementation(async () => {
      if (compete) {
        compete = false;
        // Route reentry invalidates both applyVersion and the engine restore generation.
        f.context.sceneApplyVersionRef.current += 1;
        f.engine.beginSceneSnapshotRestore(f.scene.id);
        f.engine.completeSceneSnapshotRestore(3);
      }
      return { id: "gripper" } as never;
    });
    expect(await f.play.exitPlay()).toEqual({ ok: false, reason: "restore-failed" });
    expect(f.play.active).toBe(true);
    expect(f.live.x).toBe(1);
    expect(f.errors).toHaveLength(1);
    expect(f.context.setActiveScene).not.toHaveBeenCalled();
    expect(await f.play.exitPlay()).toEqual({ ok: true });
    expect(f.play.active).toBe(false);
    expect(f.live.x).toBe(0);
  });

  it("propagates a swallowed model-load error from production apply instead of treating the Promise as success", async () => {
    const f = playFixture();
    expect(f.play.enterPlay()).toEqual({ ok: true });
    f.live.x = 1;
    vi.mocked(f.context.loadModel).mockResolvedValueOnce(undefined);
    // Silent loadModel reports its own error; the actual apply must reject because the model is absent.
    vi.spyOn(f.engine, "listModels").mockReturnValueOnce([]);
    expect(await f.play.exitPlay()).toEqual({ ok: false, reason: "restore-failed" });
    expect(f.play.active).toBe(true);
    expect(f.errors).toHaveLength(1);
  });

  describe("C25 增量域重载：退出 Play 走缓存直通恢复（真实 persistence 路径）", () => {
    function incrementalFixture() {
      const f = playFixture();
      // 进入前快照补测量域：增量分支必须保留引擎内测量（跳过 clear+重建），仅重放 React 事实。
      f.scene.measurements = [{ id: "m1", start: { x: 0, y: 0, z: 0 }, end: { x: 1, y: 0, z: 0 } } as never];
      return f;
    }

    it("增量分支：不 clearSceneModels、不重建测量，逐实例状态与恢复代际照常落位", async () => {
      const f = incrementalFixture();
      expect(f.play.enterPlay()).toEqual({ ok: true });
      f.live.x = 1;
      await f.persistence.applyScene(structuredClone(f.scene), false, f.context.project, false, false, false, true, true);
      expect(f.engine.clearSceneModels).not.toHaveBeenCalled();
      expect(f.context.loadModel).toHaveBeenCalledOnce(); // 实例缓存直通（未销毁故 loadManifest 命中路径）
      expect(f.live.x).toBe(0); // applyModelState 重放进入前位姿
      expect(f.engine.controlAnimation).toHaveBeenCalledWith("gripper", { action: "seek", time: 0 }); // mixer 对齐全量重载语义
      expect(f.engine.clearMeasurements).not.toHaveBeenCalled();
      expect(f.engine.addMeasurementVisual).not.toHaveBeenCalled();
      expect(f.context.setMeasurements).toHaveBeenCalledWith(f.scene.measurements);
      expect(f.engine.hasRestoredSceneSnapshot(f.scene.id)).toBe(true);
      expect(f.context.setActiveScene).toHaveBeenCalled();
      expect(f.engine.requestRender).toHaveBeenCalled();
    });

    it("全量分支（同一签名缺省尾参）行为逐位不变：clearSceneModels 照常执行", async () => {
      const f = incrementalFixture();
      await f.persistence.applyScene(structuredClone(f.scene), false, f.context.project, false, false, false, true);
      expect(f.engine.clearSceneModels).toHaveBeenCalledOnce();
      expect(f.engine.clearMeasurements).toHaveBeenCalledOnce();
      expect(f.engine.controlAnimation).not.toHaveBeenCalled();
    });

    it("端到端：enterPlay → 改位姿 → exitPlay 走增量（经生产调度器），快照零重建", async () => {
      const f = incrementalFixture();
      const restore = createPlaySessionRestore(() => ({
        engine: () => f.engine as unknown as { getAuthorRendererBackend(): string; hasRestoredSceneSnapshot(id: string): boolean },
        project: () => f.context.project,
        captureLive: () => structuredClone(f.scene),
        applyFull: async (snapshot: SceneSnapshot) => {
          await f.persistence.applyScene(snapshot, false, f.context.project, false, false, false, true);
          if (!f.engine.hasRestoredSceneSnapshot(snapshot.id)) throw new Error("场景恢复尚未完成");
        },
        applyIncremental: async (snapshot: SceneSnapshot) => {
          await f.persistence.applyScene(snapshot, false, f.context.project, false, false, false, true, true);
        },
      }));
      expect(f.play.enterPlay()).toEqual({ ok: true });
      f.live.x = 1;
      const outcome = await restore.restore(structuredClone(f.scene));
      expect(outcome.path).toBe("incremental");
      expect(f.engine.clearSceneModels).not.toHaveBeenCalled();
      expect(f.live.x).toBe(0);
      expect(f.engine.hasRestoredSceneSnapshot(f.scene.id)).toBe(true);
    });
  });
});

describe("canonical scene workspace save", () => {
  it("does not capture or persist a rebuilding or partially loaded engine", async () => {
    const f = fixture(); vi.mocked(f.context.engine!.isSceneSnapshotReady).mockReturnValue(false);
    expect(f.controller.makeSnapshot()).toBeUndefined();
    expect(await f.controller.saveScene()).toBeUndefined();
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.writeRecovery).not.toHaveBeenCalled();
    expect(mocks.saveWorkspace).not.toHaveBeenCalled();
    expect(f.context.showError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("尚未完整载入") }));
  });

  it("cancels before the network write if a model load or scene rebind starts during recovery persistence", async () => {
    const f = fixture();
    mocks.writeRecovery.mockImplementation(async () => { vi.mocked(f.context.engine!.isSceneSnapshotReady).mockReturnValue(false); });
    expect(await f.controller.saveScene()).toBeUndefined();
    expect(mocks.saveWorkspace).not.toHaveBeenCalled();
    expect(mocks.deleteRecovery).not.toHaveBeenCalled();
    expect(f.context.showError).toHaveBeenCalledOnce();
  });

  it("does not acknowledge a late response into a replaced or disposed engine", async () => {
    const f = fixture(); const baseline = f.session.getDocument();
    mocks.saveWorkspace.mockImplementation(async (application, scene) => {
      vi.mocked(f.context.engine!.isSceneSnapshotReady).mockReturnValue(false);
      return { application, scene };
    });
    await f.controller.saveScene();
    expect(f.session.getDocument()).toBe(baseline);
    expect(f.context.setActiveScene).not.toHaveBeenCalled();
    expect(f.context.engine!.bindSavedSceneSnapshot).not.toHaveBeenCalled();
    expect(mocks.deleteRecovery).not.toHaveBeenCalled();
  });

  it("persists a ready scene after the user intentionally removes every model", async () => {
    const f = fixture(); f.snapshot.models = []; f.snapshot.primitives = [];
    const saved = await f.controller.saveScene();
    expect(saved?.models).toEqual([]);
    expect(mocks.saveWorkspace).toHaveBeenCalledOnce();
    expect(f.context.showError).not.toHaveBeenCalled();
  });
  it("activates the first saved draft and replaces the new route without reopening the application", async () => {
    const f = newSceneFixture(); const document = f.session.getDocument();
    const saved = await f.controller.saveScene();
    expect(f.active()).toEqual(saved);
    expect(f.context.onFirstSceneSave).toHaveBeenCalledWith(saved);
    expect(f.context.navigate).toHaveBeenCalledWith({ ...f.context.route, sceneId: f.snapshot.id }, true);
    expect(f.session.getDocument()).toBe(document);
    expect(f.context.setSceneName).toHaveBeenCalledWith(f.snapshot.name);
    expect(mocks.deleteRecovery).toHaveBeenCalledWith(f.snapshot.projectId, undefined, f.snapshot.id);
    expect(mocks.saveWorkspace).not.toHaveBeenCalled();
  });

  it("keeps a failed first save in its current draft with recovery and history intact", async () => {
    const f = newSceneFixture(); mocks.saveScene.mockRejectedValue(new Error("write failed"));
    expect(await f.controller.saveScene()).toBeUndefined();
    expect(f.active()).toBeUndefined();
    expect(f.context.onFirstSceneSave).not.toHaveBeenCalled();
    expect(f.context.navigate).not.toHaveBeenCalled();
    expect(mocks.deleteRecovery).not.toHaveBeenCalled();
    expect(f.context.showError).toHaveBeenCalledOnce();
  });

  it("does not activate a late first-save response after another scene takes ownership", async () => {
    const f = newSceneFixture(); let release!: () => void;
    mocks.saveScene.mockImplementation(scene => new Promise(resolve => { release = () => resolve(scene); }));
    const saving = f.controller.saveScene(); await vi.waitFor(() => expect(mocks.saveScene).toHaveBeenCalledOnce());
    const other = { ...f.snapshot, id: "other" }; f.setActive(other);
    release(); await saving;
    expect(f.active()).toBe(other);
    expect(f.context.onFirstSceneSave).not.toHaveBeenCalled();
    expect(f.context.navigate).not.toHaveBeenCalled();
    expect(f.context.setSceneName).not.toHaveBeenCalled();
  });
  it("sends the latest store document and merges the captured model and thumbnail into the same frozen session", async () => {
    const f = fixture();
    f.session.store.dispatch(createRenameApplicationCommand("闭包之后的应用名"));
    const baseline = f.session.getDocument()!;
    await f.controller.saveScene();
    expect(mocks.saveWorkspace).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ name: "闭包之后的应用名" }) }), f.snapshot);
    expect(f.session.getDocument()?.scenes[0]?.models).toEqual(f.snapshot.models);
    expect(f.session.getDocument()?.scenes[0]?.thumbnail).toBe("data:image/jpeg;base64,fixture");
    expect(baseline.scenes[0]?.models).toEqual([]);
    expect(f.session.store.getState().dirty).toBe(false);
    expect(mocks.saveScene).not.toHaveBeenCalled(); expect(f.context.showError).not.toHaveBeenCalled();
  });

  it("preserves in-flight page edits and their undo without losing the externally saved model", async () => {
    const f = fixture();
    let release!: () => void;
    mocks.saveWorkspace.mockImplementation((document: ApplicationDocument, scene: SceneSnapshot) => new Promise(resolve => { release = () => resolve({ application: { ...structuredClone(document), metadata: { ...document.metadata, revision: document.metadata.revision + 1 } }, scene }); }));
    const saving = f.controller.saveScene(); await vi.waitFor(() => expect(mocks.saveWorkspace).toHaveBeenCalledOnce());
    f.session.store.dispatch(createRenameDashboardPageCommand(f.application.pages[0]!.id, "等待期间修改页面"));
    release(); await saving;
    expect(f.session.getDocument()?.pages[0]?.name).toBe("等待期间修改页面");
    expect(f.session.getDocument()?.scenes[0]?.models).toEqual(f.snapshot.models);
    expect(f.session.store.getState().dirty).toBe(true);
    f.session.store.undo();
    expect(f.session.getDocument()?.pages[0]?.name).toBe(f.application.pages[0]!.name);
    expect(f.session.getDocument()?.scenes[0]?.models).toEqual(f.snapshot.models);
  });

  it("retains the recovery copy and original session when the write fails", async () => {
    const f = fixture(), baseline = f.session.getDocument();
    mocks.saveWorkspace.mockRejectedValue(new Error("storage unavailable"));
    expect(await f.controller.saveScene()).toBeUndefined();
    expect(f.session.getDocument()).toBe(baseline); expect(mocks.deleteRecovery).not.toHaveBeenCalled();
    expect(f.context.showError).toHaveBeenCalledOnce(); expect(f.context.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("does not relabel or replace another workspace after a late successful save", async () => {
    const f = fixture();
    let release!: () => void;
    mocks.saveWorkspace.mockImplementation((application: ApplicationDocument, scene: SceneSnapshot) => new Promise(resolve => { release = () => resolve({ application, scene }); }));
    const saving = f.controller.saveScene(); await vi.waitFor(() => expect(mocks.saveWorkspace).toHaveBeenCalledOnce());
    const other = structuredClone(f.application); other.metadata.id = "other"; other.metadata.projectId = "other-project";
    f.session.openDocument(other); f.context.sceneApplyVersionRef.current++;
    release(); await saving;
    expect(f.session.getDocument()).toEqual(other);
    expect(f.context.setSceneName).not.toHaveBeenCalled(); expect(f.context.setScenes).not.toHaveBeenCalled();
    expect(f.context.lastAutoSavedSceneRevisionRef.current).toBe(0);
  });
});
