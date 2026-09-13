import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "./useAppState";

const harness = vi.hoisted(() => ({ effects: [] as Array<() => unknown>, dependencies: [] as unknown[][], getProject: vi.fn(), getApplication: vi.fn() }));
vi.mock("react", () => ({ useEffect: (effect: () => unknown, dependencies: unknown[]) => { harness.effects.push(effect); harness.dependencies.push(dependencies); } }));
vi.mock("../api", () => ({ api: { getProject: harness.getProject, getApplication: harness.getApplication } }));
import { useAppSceneSyncEffects } from "./useAppSceneSyncEffects";

afterEach(() => { harness.effects.length = 0; harness.dependencies.length = 0; vi.clearAllMocks(); });
describe("dashboard history route synchronization", () => {
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
