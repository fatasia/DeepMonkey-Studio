import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppViewBindings } from "./appViewBindings";
import { AppWorkspaceTopbar } from "./AppWorkspaceTopbar";

const actions = vi.hoisted(() => ({ leave: undefined as (() => void) | undefined }));
vi.mock("../components/WorkspaceModeSwitch", () => ({ WorkspaceModeSwitch: (props: { onSelect2D: () => void }) => { actions.leave = props.onSelect2D; return null; } }));
vi.mock("../components/SceneWorkspaceMoreMenu", () => ({ SceneWorkspaceMoreMenu: () => null }));

function setup() {
  const saveScene = vi.fn().mockResolvedValue({ id: "scene" });
  const saveActiveApplication = vi.fn().mockResolvedValue({ metadata: { id: "application" } });
  const returnFromSceneEditor = vi.fn(), commitSceneName = vi.fn().mockResolvedValue(true);
  const showError = vi.fn(), setError = vi.fn();
  const bindings = {
    state: { route: { view: "studio", applicationId: "application", sceneId: "scene" }, locale: "zh-CN", sceneName: "车间",
      activeApplication: { metadata: { id: "application" } }, activeScene: { id: "scene", name: "车间" },
      branding: {}, projects: [], setSceneBehaviorOpen: vi.fn(), pendingBehaviorDraftRef: { current: undefined }, showError, setError },
    scenePersistence: { saveScene, commitSceneName }, applicationRuntime: { saveActiveApplication, returnFromSceneEditor, upsertBehaviorScript: vi.fn() },
    actions: {}, sceneHistory: {},
  } as unknown as AppViewBindings;
  const render = () => renderToStaticMarkup(<AppWorkspaceTopbar bindings={bindings} />);
  render();
  return { bindings, saveScene, saveActiveApplication, returnFromSceneEditor, commitSceneName, showError, setError, render, leave: () => actions.leave!() };
}

describe("3D workspace exit save contract", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses the canonical workspace transaction once before returning to 2D", async () => {
    const fixture = setup(); fixture.leave(); fixture.leave();
    expect(fixture.returnFromSceneEditor).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(fixture.saveScene).toHaveBeenCalledOnce();
    expect(fixture.saveActiveApplication).not.toHaveBeenCalled();
    expect(fixture.commitSceneName).not.toHaveBeenCalled();
    expect(fixture.returnFromSceneEditor).toHaveBeenCalledOnce();
  });

  it("keeps the current editor on save failure and allows an explicit retry", async () => {
    const fixture = setup(); fixture.saveScene.mockResolvedValueOnce(undefined);
    fixture.leave(); await vi.runAllTimersAsync();
    expect(fixture.returnFromSceneEditor).not.toHaveBeenCalled();
    fixture.leave(); await vi.runAllTimersAsync();
    expect(fixture.saveScene).toHaveBeenCalledTimes(2); expect(fixture.returnFromSceneEditor).toHaveBeenCalledOnce();
  });

  it("does not save or leave an empty scene name", async () => {
    const fixture = setup(); fixture.bindings.state.sceneName = "  ";
    fixture.leave(); await vi.runAllTimersAsync();
    expect(fixture.commitSceneName).toHaveBeenCalledOnce(); expect(fixture.saveScene).not.toHaveBeenCalled();
    expect(fixture.returnFromSceneEditor).not.toHaveBeenCalled();
  });

  it("does not navigate after a delayed save if the user already left this route", async () => {
    const fixture = setup(); let complete!: (result: { id: string }) => void;
    fixture.saveScene.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    fixture.leave(); await vi.advanceTimersByTimeAsync(0);
    fixture.bindings.state.route = { view: "manager" };
    complete({ id: "scene" }); await vi.runAllTimersAsync();
    expect(fixture.returnFromSceneEditor).not.toHaveBeenCalled();
  });

  it("surfaces an unexpected save rejection and unlocks navigation retry", async () => {
    const fixture = setup(); const error = new Error("fixture failure");
    fixture.saveScene.mockRejectedValueOnce(error);
    fixture.leave(); await vi.runAllTimersAsync();
    expect(fixture.showError).toHaveBeenCalledWith(error); expect(fixture.returnFromSceneEditor).not.toHaveBeenCalled();
    fixture.leave(); await vi.runAllTimersAsync(); expect(fixture.returnFromSceneEditor).toHaveBeenCalledOnce();
  });
});
