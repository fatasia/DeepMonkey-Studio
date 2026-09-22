import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "./useAppState";

const harness = vi.hoisted(() => ({ effects: [] as Array<() => unknown>, dependencies: [] as unknown[][], getProject: vi.fn(), getApplication: vi.fn(), getSceneForBrowse: vi.fn(), listDatasets: vi.fn(), listDataPipelines: vi.fn() }));
vi.mock("react", () => ({ useEffect: (effect: () => unknown, dependencies: unknown[]) => { harness.effects.push(effect); harness.dependencies.push(dependencies); } }));
vi.mock("../api", () => ({ api: { getProject: harness.getProject, getApplication: harness.getApplication, getSceneForBrowse: harness.getSceneForBrowse, listDatasets: harness.listDatasets, listDataPipelines: harness.listDataPipelines } }));
import { useAppSceneSyncEffects } from "./useAppSceneSyncEffects";

afterEach(() => { harness.effects.length = 0; harness.dependencies.length = 0; vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("dashboard history route synchronization", () => {
  it("waits for authentication then restores the route after the user becomes available", async () => {
    vi.stubGlobal("window", new EventTarget());
    const project = { id: "project" };
    const scene = { id: "scene" };
    harness.getSceneForBrowse.mockResolvedValue({ project, scene });
    const state = {
      route: { view: "studio", projectId: "project", sceneId: "scene" },
      engine: { scene: { uuid: "viewer" }, hasRestoredSceneSnapshot: () => false },
      branding: {}, sceneWorkspaceLoadRef: { current: undefined },
      setProject: vi.fn(), setProjects: vi.fn(), showError: vi.fn(),
    } as unknown as AppState;
    const applyScene = vi.fn().mockResolvedValue(undefined);
    const render = () => useAppSceneSyncEffects({ state, navigate: vi.fn(), recoveryDecisionRef: { current: undefined }, setRecoveryDraft: vi.fn(), refreshProject: vi.fn(), applyScene, openSceneDashboard: vi.fn() });
    render();
    harness.effects[5]!();
    expect(harness.getSceneForBrowse).not.toHaveBeenCalled();
    expect(state.sceneWorkspaceLoadRef.current).toBeUndefined();
    state.currentUser = { id: "user" } as AppState["currentUser"];
    harness.effects.length = 0;
    harness.dependencies.length = 0;
    render();
    expect(harness.dependencies[5]).toContain("user");
    const cleanup = harness.effects[5]!() as () => void;
    await vi.waitFor(() => expect(applyScene).toHaveBeenCalledExactlyOnceWith(scene, false, project, false, false, true));
    cleanup();
    expect(state.sceneWorkspaceLoadRef.current).toBeUndefined();
    vi.unstubAllGlobals();
  });
  it("does not restore over an incremental model insertion in the restored scene", () => {
    const engine = { scene: { uuid: "viewer" }, hasRestoredSceneSnapshot: vi.fn(() => true), isSceneSnapshotReady: vi.fn(() => false) };
    const state = {
      route: { view: "studio", projectId: "project", applicationId: "app", sceneId: "scene" },
      activeScene: { id: "scene" }, activeApplication: { metadata: { id: "app" } },
      engine, branding: {}, sceneWorkspaceLoadRef: { current: undefined },
    } as unknown as AppState;
    const applyScene = vi.fn();
    useAppSceneSyncEffects({ state, navigate: vi.fn(), recoveryDecisionRef: { current: undefined }, setRecoveryDraft: vi.fn(), refreshProject: vi.fn(), applyScene, openSceneDashboard: vi.fn() });
    harness.effects[5]!();
    expect(engine.hasRestoredSceneSnapshot).toHaveBeenCalledWith("scene");
    expect(state.sceneWorkspaceLoadRef.current).toBeUndefined();
    expect(applyScene).not.toHaveBeenCalled();
  });
  it.each(["removed", "remaining"])("keeps the local document and history for route %s", (pageId) => {
    const pages = [{ id: "remaining" }];
    const document = { metadata: { id: "app", projectId: "project" }, pages };
    const navigate = vi.fn();
    const openDocument = vi.fn();
    const state = {
      activeApplication: document, route: { view: "dashboard", projectId: "project", applicationId: "app", pageId },
      branding: {}, currentUser: undefined, scenes: [],
      applicationSessionRef: { current: { store: { getState: () => ({ document }) }, openDocument } },
    } as unknown as AppState;
    useAppSceneSyncEffects({ state, navigate, recoveryDecisionRef: { current: undefined }, setRecoveryDraft: vi.fn(), refreshProject: vi.fn(), applyScene: vi.fn(), openSceneDashboard: vi.fn() });
    harness.effects[2]!();
    expect(harness.dependencies[2]).toContain(pages);
    expect(harness.getApplication).not.toHaveBeenCalled();
    expect(harness.getProject).not.toHaveBeenCalled();
    expect(openDocument).not.toHaveBeenCalled();
    if (pageId === "removed") expect(navigate).toHaveBeenCalledWith({ view: "dashboard", projectId: "project", applicationId: "app", pageId: "remaining" }, true);
    else expect(navigate).not.toHaveBeenCalled();
  });
});

describe("document entry recovery", () => {
  it.each(["dashboard", "topology"])("retries the failed %s read after authentication", async view => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    const document = { metadata: { id: "app", projectId: "project" }, pages: [{ id: "page" }], topologies: [{ id: "topology" }] };
    harness.getProject.mockResolvedValue({ id: "project" });
    harness.getApplication.mockRejectedValueOnce(Object.assign(new Error("Bad Gateway"), { status: 502 })).mockResolvedValue(document);
    harness.listDatasets.mockResolvedValue([]);
    harness.listDataPipelines.mockResolvedValue([]);
    const openDocument = vi.fn();
    const state = {
      route: { view, projectId: "project", applicationId: "app", pageId: "page", topologyId: "topology" }, branding: {},
      applicationSessionRef: { current: { store: { getState: () => ({ document: undefined }) }, openDocument } },
      setProject: vi.fn(), setProjects: vi.fn(), setTopologyDataProducts: vi.fn(), showError: vi.fn(),
    } as unknown as AppState;
    const render = () => useAppSceneSyncEffects({ state, navigate: vi.fn(), recoveryDecisionRef: { current: undefined }, setRecoveryDraft: vi.fn(), refreshProject: vi.fn(), applyScene: vi.fn(), openSceneDashboard: vi.fn() });
    const index = view === "dashboard" ? 2 : 3;
    render();
    harness.effects[index]!();
    expect(harness.getApplication).not.toHaveBeenCalled();
    state.currentUser = { id: "user" } as AppState["currentUser"];
    harness.effects.length = 0;
    harness.dependencies.length = 0;
    render();
    expect(harness.dependencies[index]).toContain("user");
    const cleanup = harness.effects[index]!() as () => void;
    await vi.advanceTimersByTimeAsync(1000);
    expect(harness.getApplication).toHaveBeenCalledTimes(2);
    expect(openDocument).toHaveBeenCalledExactlyOnceWith(document);
    cleanup();
  });
  it.each(["dashboard", "topology"])("preserves a local %s document opened while the server response was pending", async view => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    const local = { metadata: { id: "app", projectId: "project" }, pages: [{ id: "page" }], topologies: [{ id: "topology" }] };
    let current: typeof local | undefined;
    let resolve!: (value: typeof local) => void;
    harness.getProject.mockResolvedValue({ id: "project" });
    harness.getApplication.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    harness.listDatasets.mockResolvedValue([]);
    harness.listDataPipelines.mockResolvedValue([]);
    const openDocument = vi.fn();
    const state = {
      currentUser: { id: "user" }, route: { view, projectId: "project", applicationId: "app", pageId: "page", topologyId: "topology" }, branding: {},
      applicationSessionRef: { current: { store: { getState: () => ({ document: current }) }, openDocument } },
      setProject: vi.fn(), setProjects: vi.fn(), setTopologyDataProducts: vi.fn(), showError: vi.fn(),
    } as unknown as AppState;
    useAppSceneSyncEffects({ state, navigate: vi.fn(), recoveryDecisionRef: { current: undefined }, setRecoveryDraft: vi.fn(), refreshProject: vi.fn(), applyScene: vi.fn(), openSceneDashboard: vi.fn() });
    const cleanup = harness.effects[view === "dashboard" ? 2 : 3]!() as () => void;
    current = local;
    resolve(structuredClone(local));
    await vi.advanceTimersByTimeAsync(0);
    expect(openDocument).not.toHaveBeenCalled();
    cleanup();
  });
});
