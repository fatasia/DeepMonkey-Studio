import { beforeEach, describe, expect, it, vi } from "vitest";
import { migrateSceneSnapshotV1, type ApplicationDocument, type SceneSnapshot } from "@bim-studio/contracts";
import { createRenameApplicationCommand, createRenameDashboardPageCommand } from "@bim-studio/studio-core";
import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { ApplicationSession } from "../studio/applicationSession";
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
