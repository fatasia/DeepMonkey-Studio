import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarizeScenePublicationCompatibility, type SceneSnapshot } from "@bim-studio/contracts";
import type { ScenePersistenceControllerContext } from "./scenePersistenceControllerContext";
import { createScenePublicationActions } from "./scenePublicationActions";
import { createSceneArtifactRecord } from "./scenePublicationArtifactRecord";
import type { SceneArtifactRunResult } from "./scenePublicationArtifactRunner";

const apiMocks = vi.hoisted(() => ({ saveScene: vi.fn(), publishScene: vi.fn(), createNativeSceneCandidate: vi.fn() }));
const exportPackage = vi.hoisted(() => vi.fn());
const candidateMock = apiMocks.createNativeSceneCandidate;
const browserPrepare = vi.hoisted(() => vi.fn());

vi.mock("../api", () => ({ api: apiMocks }));
vi.mock("../delivery/sceneClientPackage", () => ({ prepareSceneClientPackage: browserPrepare,
  getPreparedSceneClientDependencies: vi.fn() }));

const scene: SceneSnapshot = {
  schemaVersion: 1,
  id: "scene-1",
  projectId: "project-1",
  name: "装配线",
  camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
  models: [],
  primitives: [{ modelId: "box", kind: "box", name: "方块", visible: true, opacity: 1, color: "#ffffff",
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } }],
  measurements: [],
  dataBindings: [],
  interactions: [],
  createdAt: "2026-08-31T00:00:00.000Z",
  updatedAt: "2026-08-31T00:00:00.000Z",
};

function readyCandidate(candidateId = "server-candidate") {
  const capability = "deep.scene.runtime.v1", source = "a".repeat(64), graph = "b".repeat(64), artifact = "c".repeat(64);
  const report = summarizeScenePublicationCompatibility({ target: "deep-native", sceneId: scene.id,
    contentFingerprint: source, compileGraphHash: graph, targetArtifactHash: artifact, fixtureId: "test-scene", platform: "windows-x64",
    profile: { version: "test-v1", capabilities: [capability] },
    items: [{sceneId:scene.id,objectId:scene.id,path:"$",capability,status:"supported",reason:"test",remediation:"test",evidenceIds:["proof"]}],
    evidence: [{id:"proof",capability,target:"deep-native",sourceSemanticHash:source,compileGraphHash:graph,targetArtifactHash:artifact,
      fixtureId:"test-scene",platform:"windows-x64",scope:"native-window"}],
  });
  return {status:"ready" as const,candidateId,expiresAt:"2099-01-01T00:00:00Z",report};
}

describe("scene publication actions", () => {
  beforeEach(() => vi.resetAllMocks());

  function setup() {
    candidateMock.mockResolvedValue(readyCandidate());
    const published = { ...scene, publishedAt: "2026-09-15T08:00:00.000Z" };
    apiMocks.saveScene.mockResolvedValue(scene);
    apiMocks.publishScene.mockResolvedValue({ projectId: scene.projectId, sceneId: scene.id, version: 1, publishedAt: published.publishedAt, snapshot: published });
    const context = {
      project: { id: scene.projectId, models: [] }, activeScene: scene, scenes: [scene],
      getActiveScene: vi.fn<() => SceneSnapshot | undefined>().mockReturnValue(scene),
      buildPublicationArtifact: vi.fn<ScenePersistenceControllerContext["buildPublicationArtifact"]>(async (publication, options) => ({
        record: { ...createSceneArtifactRecord(publication, options), status: "ready" },
        result: await exportPackage({ projectId: publication.snapshot.projectId, scene: publication.snapshot, ...options }),
      })),
      sceneApplyVersionRef: { current: 1 },
      route: { view: "studio", sceneId: scene.id }, locale: "zh-CN",
      studioPublishMode: "webgl", studioPublishPerformance: "standard",
      enablePublishedCloudScene: vi.fn(), navigate: vi.fn(),
      sortScenesByTime: (items: SceneSnapshot[]) => items,
      showError: vi.fn(), setActiveScene: vi.fn(), setMessage: vi.fn(),
      setSceneName: vi.fn(), setScenes: vi.fn(), setStudioPublishOpen: vi.fn(),
    };
    const saveCurrentScene = vi.fn().mockResolvedValue(scene);
    const actions = createScenePublicationActions(context as unknown as ScenePersistenceControllerContext, saveCurrentScene);
    return { actions, context, published, saveCurrentScene };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
  }

  it.each(["blocked", "ready"])("refuses an unsupported object even when candidate status is %s", async status => {
    const { actions, context } = setup();
    const candidate = readyCandidate();
    candidate.report = { ...candidate.report, items: [{ ...candidate.report.items[0]!, objectId: "unknown-object", path: "environment.future",
      capability: "unknown.future", status: "blocked", reason: "未知能力未进入运行包", remediation: "删除未知配置后重新检查", evidenceIds: [] }] };
    candidateMock.mockResolvedValue({ ...candidate, status });
    await expect(actions.publishScene(scene, "webgl", "standard", true, "deep-native")).rejects.toThrow("unknown-object");
    expect(apiMocks.publishScene).not.toHaveBeenCalled(); expect(browserPrepare).not.toHaveBeenCalled();
    expect(context.buildPublicationArtifact).not.toHaveBeenCalled(); expect(context.showError).toHaveBeenCalledOnce();
    expect(context.showError.mock.calls[0]![0].message).toBe("发布检查未通过");
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
  });

  it.each(["503 verifier unavailable", "409 candidate changed"])("propagates candidate failure %s once without publishing", async message => {
    const { actions, context } = setup(); const error = new Error(message);
    candidateMock.mockRejectedValue(error);
    await expect(actions.publishActiveScene("webgl", "standard", true, "deep-native")).rejects.toBe(error);
    expect(context.showError).toHaveBeenCalledExactlyOnceWith(error);
    expect(apiMocks.publishScene).not.toHaveBeenCalled(); expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
  });

  it.each(["missing-id", "wrong-scene", "wrong-target", "blocked-ready-report"])("rejects mismatched server candidate %s", async kind => {
    const { actions, context } = setup(); const candidate = readyCandidate();
    if (kind === "missing-id") candidate.candidateId = "";
    if (kind === "wrong-scene") candidate.report = { ...candidate.report, sceneId: "another-scene" };
    if (kind === "wrong-target") candidate.report = { ...candidate.report, target: "three-webview" };
    candidateMock.mockResolvedValue(kind === "blocked-ready-report" ? { ...candidate, status: "blocked" } : candidate);
    await expect(actions.publishScene(scene, "webgl", "standard", true, "deep-native")).rejects.toThrow();
    expect(apiMocks.publishScene).not.toHaveBeenCalled(); expect(context.showError).toHaveBeenCalledOnce();
  });

  it.each(["identity", "generation"])("does not surface late prepare rejection in a changed %s", async change => {
    const { actions, context } = setup(), preparation = deferred<object>();
    candidateMock.mockReturnValueOnce(preparation.promise);
    const running = actions.publishActiveScene("webgl", "standard", true, "deep-native");
    await vi.waitFor(() => expect(candidateMock).toHaveBeenCalledOnce());
    if (change === "identity") context.getActiveScene.mockReturnValue({ ...scene, id: "new-scene" });
    else context.sceneApplyVersionRef.current++;
    preparation.reject(new Error("old Native preparation failed")); await running;
    expect(context.showError).not.toHaveBeenCalled(); expect(context.setMessage).not.toHaveBeenCalled();
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled(); expect(apiMocks.publishScene).not.toHaveBeenCalled();
  });

  it.each(["identity", "generation"])("does not surface late cloud activation in a changed %s", async change => {
    const { actions, context, published } = setup(), cloud = deferred<{ viewerUrl: string }>();
    context.enablePublishedCloudScene.mockReturnValueOnce(cloud.promise);
    const running = actions.publishActiveScene("cloud", "standard", true, "none");
    await vi.waitFor(() => expect(context.enablePublishedCloudScene).toHaveBeenCalledOnce());
    if (change === "identity") context.getActiveScene.mockReturnValue({ ...scene, id: "new-scene" });
    else context.sceneApplyVersionRef.current++;
    context.setActiveScene.mockClear(); context.setMessage.mockClear();
    cloud.resolve({ viewerUrl: "/old-cloud" }); await running;
    expect(context.setMessage).not.toHaveBeenCalled(); expect(context.showError).not.toHaveBeenCalled();
    expect(context.setActiveScene).not.toHaveBeenCalled(); expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
    expect(context.setScenes).toHaveBeenCalledOnce();
    const update = context.setScenes.mock.calls[0]![0] as (items: SceneSnapshot[]) => SceneSnapshot[];
    expect(update([scene])).toEqual([published]);
  });

  it.each(["ready", "failed", "cancelled", "rejected"] as const)("isolates late artifact %s results after scene departure", async status => {
    const { actions, context, published } = setup(), artifact = deferred<SceneArtifactRunResult>();
    context.buildPublicationArtifact.mockReturnValueOnce(artifact.promise);
    const running = actions.publishActiveScene("webgl", "standard", true, "three-webview");
    await vi.waitFor(() => expect(context.buildPublicationArtifact).toHaveBeenCalledOnce());
    context.getActiveScene.mockReturnValue({ ...scene, id: "new-scene" }); context.sceneApplyVersionRef.current++;
    context.setActiveScene.mockClear(); context.setMessage.mockClear();
    const [publication, options] = context.buildPublicationArtifact.mock.calls[0]!;
    if (status === "rejected") artifact.reject(new Error("old artifact storage failed"));
    else artifact.resolve({ record: { ...createSceneArtifactRecord(publication, options), status, error: "old task message" },
      ...(status === "ready" ? { result: { fileName: "old.zip", target: "three-webview", assetCount: 0, applicationCount: 0, connectionCount: 0 } as const } : {}) });
    await running;
    expect(context.setMessage).not.toHaveBeenCalled(); expect(context.showError).not.toHaveBeenCalled();
    expect(context.setActiveScene).not.toHaveBeenCalled(); expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
    expect(context.setScenes).toHaveBeenCalledOnce();
    const update = context.setScenes.mock.calls[0]![0] as (items: SceneSnapshot[]) => SceneSnapshot[];
    expect(update([scene])).toEqual([published]);
  });

  it.each(["blocked", "confirmation-required"])("does not publish or enable cloud after Native preparation rejects %s", async (status) => {
    const { actions, context } = setup();
    const failure = new Error(`camera: ${status}; 请选择 Three WebView`);
    candidateMock.mockRejectedValue(failure);
    await expect(actions.publishActiveScene("cloud", "standard", true, "deep-native")).rejects.toBe(failure);
    expect(candidateMock).toHaveBeenCalledWith(scene.projectId, scene.id, scene);
    expect(apiMocks.saveScene).toHaveBeenCalledOnce();
    expect(apiMocks.publishScene).not.toHaveBeenCalled();
    expect(context.enablePublishedCloudScene).not.toHaveBeenCalled();
    expect(context.buildPublicationArtifact).not.toHaveBeenCalled();
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
    expect(context.showError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("publishes the server candidate ID for the saved scene without a browser prepared handle", async () => {
    const { actions, context, published } = setup();
    const configured = { ...scene, name: "保存后版本" };
    apiMocks.saveScene.mockResolvedValue(configured);
    const candidate = readyCandidate("server-candidate");
    candidateMock.mockResolvedValue(candidate);
    exportPackage.mockResolvedValue({ fileName: "scene.zip" });
    expect(await actions.publishScene(scene, "webgpu-preferred", "standard", false, "deep-native")).toBe(true);
    expect(candidateMock).toHaveBeenCalledExactlyOnceWith(scene.projectId, scene.id, configured);
    expect(browserPrepare).not.toHaveBeenCalled();
    expect(apiMocks.publishScene).toHaveBeenCalledWith(scene.projectId, scene.id, configured,
      { clientTarget: "deep-native", nativeCandidateId: "server-candidate" });
    expect(context.buildPublicationArtifact).toHaveBeenCalledWith(expect.objectContaining({ snapshot: published }),
      { target: "deep-native", renderer: "webgpu-preferred", toolbarVisible: false });
  });

  it.each(["switch", "reopen"])("stops a delayed preparation after scene %s", async (change) => {
    const { actions, context } = setup();
    let finish!: (value: object) => void;
    candidateMock.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = actions.publishActiveScene("webgl", "standard", true, "deep-native");
    await vi.waitFor(() => expect(candidateMock).toHaveBeenCalledOnce());
    if (change === "switch") context.getActiveScene.mockReturnValue({ ...scene, id: "another" });
    else context.sceneApplyVersionRef.current++;
    finish(readyCandidate());
    await pending;
    expect(apiMocks.publishScene).not.toHaveBeenCalled();
    expect(context.buildPublicationArtifact).not.toHaveBeenCalled();
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
  });

  it("allows a manager request whose active scene remains absent", async () => {
    const { actions, context } = setup();
    context.getActiveScene.mockReturnValue(undefined);
    exportPackage.mockResolvedValue({ fileName: "scene.zip" });
    expect(await actions.publishScene(scene, "webgl", "standard", true, "deep-native")).toBe(true);
    expect(context.buildPublicationArtifact).toHaveBeenCalledOnce();
  });

  it("does not deliver a late successful publication after the scene was reopened", async () => {
    const { actions, context, published } = setup();
    let finish!: (value: object) => void;
    apiMocks.publishScene.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = actions.publishActiveScene("cloud", "standard", true, "deep-native");
    await vi.waitFor(() => expect(apiMocks.publishScene).toHaveBeenCalledOnce());
    context.sceneApplyVersionRef.current++;
    finish({ projectId: scene.projectId, sceneId: scene.id, version: 1, publishedAt: published.publishedAt, snapshot: published });
    await pending;
    expect(context.setScenes).toHaveBeenCalledOnce();
    expect(context.setActiveScene).not.toHaveBeenCalled();
    expect(context.enablePublishedCloudScene).not.toHaveBeenCalled();
    expect(context.buildPublicationArtifact).not.toHaveBeenCalled();
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
  });

  it("does not build when atomic publication conflicts after successful preparation", async () => {
    const { actions, context } = setup();
    apiMocks.publishScene.mockRejectedValue(new Error("snapshot-conflict"));
    await expect(actions.publishScene(scene, "webgl", "standard", true, "deep-native")).rejects.toThrow("snapshot-conflict");
    expect(candidateMock).toHaveBeenCalledOnce();
    expect(context.buildPublicationArtifact).not.toHaveBeenCalled();
    expect(context.showError).toHaveBeenCalledWith(expect.objectContaining({ message: "snapshot-conflict" }));
  });

  it("keeps Three delivery on the existing two-argument path without Native preparation", async () => {
    const { actions, context } = setup();
    exportPackage.mockResolvedValue({ fileName: "scene.zip" });
    expect(await actions.publishScene(scene, "webgl", "standard", true, "three-webview")).toBe(true);
    expect(candidateMock).not.toHaveBeenCalled();
    expect(context.buildPublicationArtifact.mock.calls[0]).toHaveLength(2);
  });

  it("keeps the dialog open and preserves the published snapshot when packaging fails", async () => {
    const { actions, context, published } = setup();
    const failure = new Error("asset download failed: 503");
    exportPackage.mockRejectedValue(failure);

    await expect(actions.publishActiveScene("webgpu-preferred", "fast", false, "deep-native")).rejects.toBe(failure);

    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
    expect(context.setActiveScene).toHaveBeenCalledWith(published);
    expect(context.setScenes).toHaveBeenCalledOnce();
    expect(context.showError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(context.setMessage).toHaveBeenLastCalledWith("场景“装配线”已发布 · 客户端包生成失败");
    expect(exportPackage).toHaveBeenCalledWith({ projectId: scene.projectId, scene: published, target: "deep-native", renderer: "webgpu-preferred", toolbarVisible: false });
    expect(apiMocks.publishScene).toHaveBeenCalledOnce();
  });

  it("returns failure to the scene manager when packaging fails", async () => {
    const { actions, context } = setup();
    exportPackage.mockRejectedValue(new Error("invalid package"));
    await expect(actions.publishScene(scene, "webgl", "standard", true, "deep-native")).rejects.toThrow("invalid package");
    expect(context.showError).toHaveBeenCalledOnce();
  });

  it.each(["failed", "cancelled"] as const)("preserves the publication and dialog when artifact state is %s", async (status) => {
    const { actions, context } = setup();
    context.buildPublicationArtifact.mockImplementationOnce(async (publication, options) => ({
      record: { ...createSceneArtifactRecord(publication, options), status, error: "历史资源不可用" },
    }));
    const operation = actions.publishActiveScene("webgl", "standard", true, "three-webview");
    if (status === "cancelled") await expect(operation).resolves.toBeUndefined();
    else await expect(operation).rejects.toThrow("历史资源不可用");
    expect(apiMocks.saveScene).toHaveBeenCalledOnce();
    expect(apiMocks.publishScene).toHaveBeenCalledOnce();
    expect(context.buildPublicationArtifact).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }), { target: "three-webview", renderer: "webgl", toolbarVisible: true });
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
    expect(context.setMessage).toHaveBeenLastCalledWith(expect.stringContaining(status === "cancelled" ? "已取消" : "生成失败"));
    if (status === "cancelled") expect(context.showError).not.toHaveBeenCalled();
    else expect(context.showError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "历史资源不可用" }));
  });

  it("closes only after the requested package is ready", async () => {
    const { actions, context } = setup();
    let finish!: (value: { fileName: string }) => void;
    exportPackage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = actions.publishActiveScene("webgl", "standard", true, "deep-native");
    await vi.waitFor(() => expect(exportPackage).toHaveBeenCalledOnce());
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
    finish({ fileName: "scene.bimscene.zip" });
    await pending;
    expect(context.setStudioPublishOpen).toHaveBeenCalledWith(false);
    expect(context.setMessage).toHaveBeenLastCalledWith(expect.stringContaining("scene.bimscene.zip"));
  });

  it.each(["save", "publish"])("does not export after %s fails", async (stage) => {
    const { actions, context } = setup();
    const failure = new Error("request failed");
    (stage === "save" ? apiMocks.saveScene : apiMocks.publishScene).mockRejectedValue(failure);
    await expect(actions.publishActiveScene("webgl", "standard", true, "deep-native")).rejects.toBe(failure);
    expect(exportPackage).not.toHaveBeenCalled();
    expect(context.setActiveScene).not.toHaveBeenCalled();
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
    expect(context.showError).toHaveBeenCalledExactlyOnceWith(failure);
    if (stage === "save") expect(candidateMock).not.toHaveBeenCalled();
  });

  it("does not publish when saving the active draft is cancelled", async () => {
    const { actions, saveCurrentScene, context } = setup();
    saveCurrentScene.mockResolvedValue(undefined);
    await actions.publishActiveScene();
    expect(apiMocks.publishScene).not.toHaveBeenCalled();
    expect(exportPackage).not.toHaveBeenCalled();
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
  });

  function navigation(targetSceneId: string): NonNullable<SceneSnapshot["interactions"]> {
    return [{ id: "nav", name: "场景跳转", enabled: true, trigger: "click", target: { kind: "object", modelId: "box" }, code: "",
      actions: [{ id: "go", type: "navigateScene", enabled: true, sceneId: targetSceneId }] }];
  }

  it("audits the saved response and blocks broken references before any publication side effect", async () => {
    const { actions, context } = setup();
    apiMocks.saveScene.mockResolvedValue({ ...scene, interactions: navigation("deleted") });
    await expect(actions.publishActiveScene("cloud", "standard", true, "deep-native")).rejects.toThrow("跳转场景不存在");
    expect(apiMocks.saveScene).toHaveBeenCalledOnce();
    expect(apiMocks.publishScene).not.toHaveBeenCalled();
    expect(context.enablePublishedCloudScene).not.toHaveBeenCalled();
    expect(exportPackage).not.toHaveBeenCalled();
    expect(context.setActiveScene).not.toHaveBeenCalled();
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
    expect(context.showError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("跳转场景不存在") }));
  });

  it("uses other scenes only as navigation references and ignores their broken drafts", async () => {
    const { actions, context } = setup();
    context.scenes.push({ ...scene, id: "destination", interactions: navigation("missing") });
    apiMocks.saveScene.mockResolvedValue({ ...scene, interactions: navigation("destination") });
    expect(await actions.publishScene(scene)).toBe(true);
    expect(apiMocks.publishScene).toHaveBeenCalledOnce();
    expect(context.showError).not.toHaveBeenCalled();
  });

  it("accepts a repaired saved response instead of auditing the stale input draft", async () => {
    const { actions } = setup();
    expect(await actions.publishScene({ ...scene, interactions: navigation("deleted") })).toBe(true);
    expect(apiMocks.publishScene).toHaveBeenCalledOnce();
  });

  it("blocks duplicate author object IDs before publication", async () => {
    const { actions, context } = setup();
    const primitive = { modelId: "same", name: "方块", kind: "box" as const, visible: true, opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } };
    apiMocks.saveScene.mockResolvedValue({ ...scene, primitives: [primitive, primitive] });
    await expect(actions.publishScene(scene)).rejects.toThrow("重复");
    expect(apiMocks.publishScene).not.toHaveBeenCalled();
    expect(context.showError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("重复") }));
  });

  it("rejects cross-project input before saving and mismatched saved identities before publishing", async () => {
    const { actions } = setup();
    await expect(actions.publishScene({ ...scene, projectId: "other" })).rejects.toThrow("不属于当前项目");
    expect(apiMocks.saveScene).not.toHaveBeenCalled();
    for (const change of [{ id: "other" }, { projectId: "other" }]) {
      apiMocks.saveScene.mockResolvedValue({ ...scene, ...change });
      await expect(actions.publishScene(scene)).rejects.toThrow("保存结果与待发布场景不一致");
    }
    expect(apiMocks.publishScene).not.toHaveBeenCalled();
  });

  it("does not publish a scene whose save completes after the user switches away", async () => {
    const { actions, context, saveCurrentScene } = setup();
    let saved!: (value: SceneSnapshot) => void;
    saveCurrentScene.mockReturnValue(new Promise((resolve) => { saved = resolve; }));
    const pending = actions.publishActiveScene();
    context.getActiveScene.mockReturnValue({ ...scene, id: "next" });
    context.sceneApplyVersionRef.current++;
    saved(scene);
    await pending;
    expect(apiMocks.saveScene).not.toHaveBeenCalled();
    expect(apiMocks.publishScene).not.toHaveBeenCalled();
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
  });

  it.each(["different-scene", "same-id-reopened", "different-project", "unloaded"])("does not overwrite the current editor on a late publication: %s", async (change) => {
    const { actions, context, published } = setup();
    let finish!: (value: { snapshot: SceneSnapshot }) => void;
    apiMocks.publishScene.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = actions.publishActiveScene();
    await vi.waitFor(() => expect(apiMocks.publishScene).toHaveBeenCalledOnce());
    context.getActiveScene.mockReturnValue(change === "unloaded" ? undefined : { ...scene,
      ...(change === "different-scene" ? { id: "next" } : {}),
      ...(change === "different-project" ? { projectId: "next-project" } : {}) });
    if (change === "same-id-reopened") context.sceneApplyVersionRef.current++;
    finish({ snapshot: published });
    await pending;
    expect(context.setActiveScene).not.toHaveBeenCalled();
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
    expect(context.setScenes).toHaveBeenCalledOnce();
  });

  it("does not close a newly opened scene dialog when packaging finishes late", async () => {
    const { actions, context } = setup();
    let finish!: (value: { fileName: string }) => void;
    exportPackage.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const pending = actions.publishActiveScene("webgl", "standard", true, "three-webview");
    await vi.waitFor(() => expect(exportPackage).toHaveBeenCalledOnce());
    context.sceneApplyVersionRef.current++;
    finish({ fileName: "scene.zip" });
    await pending;
    expect(context.setStudioPublishOpen).not.toHaveBeenCalled();
  });

  it("saves publication settings before publishing and closes only after success", async () => {
    const setMessage = vi.fn();
    const setStudioPublishOpen = vi.fn();
    const setScenes = vi.fn();
    const setActiveScene = vi.fn();
    const saveCurrentScene = vi.fn().mockResolvedValue(scene);
    const configured = { ...scene, publicationMode: "webgpu-preferred" as const, publicationPerformance: "fast" as const, publicationToolbarVisible: false };
    const published = { ...configured, publishedAt: "2026-08-31T08:00:00.000Z" };
    apiMocks.saveScene.mockResolvedValue(configured);
    apiMocks.publishScene.mockResolvedValue({ snapshot: published });
    const actions = createScenePublicationActions(
      {
        project: { id: "project-1", models: [] },
        scenes: [scene],
        activeScene: scene,
        getActiveScene: () => scene,
        sceneApplyVersionRef: { current: 1 },
        route: { view: "studio", sceneId: scene.id },
        locale: "zh-CN",
        studioPublishMode: "webgl",
        studioPublishPerformance: "standard",
        enablePublishedCloudScene: vi.fn(),
        navigate: vi.fn(),
        sortScenesByTime: (items: SceneSnapshot[]) => items,
        showError: vi.fn(),
        setActiveScene,
        setMessage,
        setSceneName: vi.fn(),
        setScenes,
        setStudioPublishOpen,
      } as unknown as ScenePersistenceControllerContext,
      saveCurrentScene,
    );

    await actions.publishActiveScene("webgpu-preferred", "fast", false);

    expect(saveCurrentScene).toHaveBeenCalledOnce();
    expect(apiMocks.saveScene).toHaveBeenCalledWith(expect.objectContaining({ publicationMode: "webgpu-preferred", publicationPerformance: "fast", publicationToolbarVisible: false }));
    expect(apiMocks.publishScene).toHaveBeenCalledWith("project-1", scene.id, configured);
    expect(setActiveScene).toHaveBeenCalledWith(published);
    expect(setScenes).toHaveBeenCalledOnce();
    expect(setStudioPublishOpen).toHaveBeenCalledWith(false);
    expect(setMessage).toHaveBeenCalledWith(expect.stringContaining("WebGPU"));
  });
});
