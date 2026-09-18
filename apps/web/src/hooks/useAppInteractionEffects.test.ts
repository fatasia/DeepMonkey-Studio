import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationDocument, SceneInteractionActionState, SceneSnapshot } from "@bim-studio/contracts";
import type { ApplicationInteractionEffect } from "@bim-studio/studio-core";

const harness = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void)>,
  transition: vi.fn(),
  publishData: vi.fn(),
}));
vi.mock("react", () => ({ useEffect: (effect: () => (() => void)) => harness.effects.push(effect) }));
vi.mock("../sceneTransitionOverlay", () => ({ runSceneNavigationTransition: harness.transition }));
vi.mock("../sceneDataBridge", () => ({ publishLocalSceneData: harness.publishData }));

import { publishApplicationInteractionEffects } from "../studio/applicationInteractionHost";
import { useAppInteractionEffects } from "./useAppInteractionEffects";

type Options = Parameters<typeof useAppInteractionEffects>[0];
let target: EventTarget & { open: ReturnType<typeof vi.fn>; location: { assign: ReturnType<typeof vi.fn> } };
let cleanups: Array<() => void>;

beforeEach(() => {
  target = Object.assign(new EventTarget(), { open: vi.fn(), location: { assign: vi.fn() } });
  vi.stubGlobal("window", target);
  cleanups = [];
  harness.transition.mockImplementation(async (_transition, navigate: () => void) => navigate());
});
afterEach(() => {
  cleanups.forEach(cleanup => cleanup());
  harness.effects.length = 0;
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function mount(overrides: Partial<Options> = {}) {
  const options: Options = {
    activeApplication: undefined, cameraViews: [], engine: undefined,
    route: { view: "studio", projectId: "project", applicationId: "app", sceneId: "current" },
    scenes: [{ id: "next" }] as SceneSnapshot[],
    navigate: vi.fn(), showError: vi.fn(), setMessage: vi.fn(), ...overrides,
  };
  useAppInteractionEffects(options);
  const cleanup = harness.effects.at(-1)!();
  cleanups.push(cleanup);
  return { ...options, cleanup };
}

function emit(action: Partial<SceneInteractionActionState>, source?: ApplicationInteractionEffect["source"]) {
  publishApplicationInteractionEffects([{
    flowId: "flow", timestamp: "2026-09-15T00:00:00.000Z",
    source: source ?? { kind: "widget", id: "widget" },
    action: { id: "action", enabled: true, ...action } as SceneInteractionActionState,
  }]);
}

describe("application interaction effect lifecycle", () => {
  it("receives both event buses and removes both subscriptions on cleanup", () => {
    const app = mount();
    emit({ type: "message", message: " modern " });
    target.dispatchEvent(new CustomEvent("bim-studio:interaction-action", { detail: { type: "message", message: "legacy" } }));
    expect(app.setMessage).toHaveBeenNthCalledWith(1, "modern");
    expect(app.setMessage).toHaveBeenNthCalledWith(2, "legacy");
    app.cleanup();
    emit({ type: "message" });
    target.dispatchEvent(new CustomEvent("bim-studio:interaction-action", { detail: { type: "message" } }));
    expect(app.setMessage).toHaveBeenCalledTimes(2);
  });

  it("does not duplicate handlers after cleanup and remount", () => {
    const old = mount();
    old.cleanup();
    const current = mount();
    emit({ type: "message", message: " " });
    expect(old.setMessage).not.toHaveBeenCalled();
    expect(current.setMessage).toHaveBeenCalledExactlyOnceWith("事件已触发");
  });

  it("preserves editor project context when navigating to an existing scene", () => {
    const app = mount();
    emit({ type: "navigateScene", sceneId: "next" });
    expect(app.navigate).toHaveBeenCalledExactlyOnceWith({ ...app.route, sceneId: "next" });
  });

  it("uses the active application as the scene authority", () => {
    const app = mount({ activeApplication: { scenes: [] } as unknown as ApplicationDocument });
    emit({ type: "navigateScene", sceneId: "next" });
    expect(app.showError).toHaveBeenCalledOnce();
    expect(app.navigate).not.toHaveBeenCalled();
    expect(harness.transition).not.toHaveBeenCalled();
  });

  it("rejects missing scenes outside an application", () => {
    const app = mount();
    emit({ type: "navigateScene", sceneId: "missing", newTab: true });
    expect(app.showError).toHaveBeenCalledOnce();
    expect(target.open).not.toHaveBeenCalled();
  });

  it("reports asynchronous transition failures", async () => {
    const error = new Error("transition failed");
    harness.transition.mockRejectedValueOnce(error);
    const app = mount();
    emit({ type: "navigateScene", sceneId: "next" });
    await Promise.resolve();
    expect(app.showError).toHaveBeenCalledExactlyOnceWith(error);
    expect(app.navigate).not.toHaveBeenCalled();
  });

  it("navigates only to pages owned by the application", () => {
    const app = mount({ activeApplication: {
      metadata: { id: "app", projectId: "project" }, pages: [{ id: "page" }], scenes: [],
    } as unknown as ApplicationDocument });
    emit({ type: "dashboard", dashboardPageId: "page" });
    expect(app.navigate).toHaveBeenCalledWith(expect.objectContaining({ view: "dashboard", applicationId: "app", projectId: "project", pageId: "page" }));
    emit({ type: "dashboard", dashboardPageId: "missing" });
    expect(app.navigate).toHaveBeenCalledOnce();
    expect(app.showError).toHaveBeenCalledOnce();
  });

  it("keeps Unity widget identity and falsy payloads", () => {
    mount();
    const listener = vi.fn();
    target.addEventListener("bim-studio:unity-action", listener);
    emit({ type: "unityAction", unityAction: " start ", unityObjectId: " motor ", value: false });
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0].detail).toEqual({ widgetId: "widget", action: "start", objectId: "motor", value: false });
  });

  it("rejects legacy Unity actions without widget identity", () => {
    const app = mount();
    const listener = vi.fn();
    target.addEventListener("bim-studio:unity-action", listener);
    target.dispatchEvent(new CustomEvent("bim-studio:interaction-action", { detail: { type: "unityAction", unityAction: "start" } }));
    expect(app.showError).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes data with scene identity and preserves zero values", () => {
    mount();
    emit({ type: "setData", dataKey: " speed ", value: 0 });
    expect(harness.publishData).toHaveBeenCalledExactlyOnceWith({ source: "interaction", sceneId: "current", key: "speed", value: 0, timestamp: expect.any(String) });
  });

  it.each(["javascript:alert(1)", "data:text/html,test", ""])("rejects invalid URL %s", url => {
    const app = mount();
    emit({ type: "openUrl", url });
    expect(app.showError).toHaveBeenCalledOnce();
    expect(target.open).not.toHaveBeenCalled();
    expect(target.location.assign).not.toHaveBeenCalled();
  });

  it("opens URLs with isolated new tabs and honors same-tab navigation", () => {
    mount();
    emit({ type: "openUrl", url: " https://example.com/path " });
    expect(target.open).toHaveBeenCalledExactlyOnceWith("https://example.com/path", "_blank", "noopener,noreferrer");
    emit({ type: "openUrl", url: "/docs", newTab: false });
    expect(target.location.assign).toHaveBeenCalledExactlyOnceWith("/docs");
  });
});
