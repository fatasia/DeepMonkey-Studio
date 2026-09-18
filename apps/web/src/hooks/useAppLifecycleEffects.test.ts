import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppState } from "./useAppState";

const harness = vi.hoisted(() => ({
  cursor: 0, dependencies: [] as unknown[][], effects: [] as Array<() => void>,
  cleanups: [] as Array<(() => void) | undefined>,
  getBranding: vi.fn(), listRevitInstallations: vi.fn(), me: vi.fn(), getAuthToken: vi.fn(), setAuthToken: vi.fn(),
  resolvePublishedRenderer: vi.fn(), sceneViewerDeliveryRendererMode: vi.fn(),
}));
vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void), dependencies: unknown[]) => {
    const index = harness.cursor++;
    const previous = harness.dependencies[index];
    if (!previous || previous.some((value, slot) => !Object.is(value, dependencies[slot]))) {
      harness.dependencies[index] = dependencies;
      harness.effects.push(() => { harness.cleanups[index]?.(); harness.cleanups[index] = effect() || undefined; });
    }
  },
}));
vi.mock("../api", () => ({ api: harness, getAuthToken: harness.getAuthToken, setAuthToken: harness.setAuthToken }));
vi.mock("../adapters/desktopLocalApi", () => ({ localDesktopUser: vi.fn() }));
vi.mock("../adapters/runtimeHost", () => ({ isDesktopRuntime: () => false, currentDesktopRuntimeMode: () => undefined }));
vi.mock("../appDefaults", () => ({ RENDERER_BACKEND_STORAGE_KEY: "bim-studio.renderer-backend", REVIT_VERSION_STORAGE_KEY: "bim-studio.revit-version" }));
vi.mock("../i18n", () => ({ storeLocale: vi.fn() }));
vi.mock("../branding/documentBranding", () => ({ applyDocumentBranding: vi.fn() }));
vi.mock("../rendererCapabilities", () => ({ resolvePublishedRenderer: harness.resolvePublishedRenderer, rendererRequirementsForScene: () => ({}) }));
vi.mock("../delivery/sceneViewerDelivery", () => ({
  isSceneViewerDeliveryRuntime: () => false, sceneViewerDeliveryUser: () => undefined,
  sceneViewerDeliveryRendererMode: harness.sceneViewerDeliveryRendererMode,
}));
import { useAppLifecycleEffects } from "./useAppLifecycleEffects";

function unmount() { harness.cleanups.splice(0).forEach(cleanup => cleanup?.()); }
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); harness.cursor = 0; harness.dependencies = []; harness.effects = []; harness.cleanups = [];
  harness.getBranding.mockResolvedValue({ defaultLocale: "zh-CN" });
  harness.listRevitInstallations.mockResolvedValue({ installations: [] });
  harness.resolvePublishedRenderer.mockResolvedValue({ backend: "webgl" });
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    setTimeout, clearTimeout, localStorage: { getItem: vi.fn(() => null), setItem: vi.fn() },
  }));
});
afterEach(() => { unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(patch: Record<string, unknown> = {}) {
  const unsubscribe = vi.fn();
  const state = {
    activeApplication: { metadata: { id: "application-a" } }, activeScene: { id: "scene-a", publicationMode: "auto" },
    applicationRevision: 0, applicationState: { dirty: false }, applicationSessionRef: { current: { store: { subscribe: vi.fn(() => unsubscribe), setSelection: vi.fn() } } },
    autoSaveEnabled: true, branding: {}, busy: false, engine: {}, lastAutoSavedSceneRevisionRef: { current: -1 },
    locale: "zh-CN", rendererBackend: "webgl", rendererSwitching: false, rendererSwitchPhase: "idle", revision: 10,
    route: { view: "studio" }, rvtRevitVersion: "auto",
    setApplicationRevision: vi.fn(), setAuthReady: vi.fn(), setBranding: vi.fn(), setCurrentUser: vi.fn(),
    setLocale: vi.fn(), setRevitRuntime: vi.fn(), setRvtRevitVersion: vi.fn(), ...patch,
  } as unknown as AppState;
  const saveScene = vi.fn(); const saveActiveApplication = vi.fn(); const changeRendererBackend = vi.fn();
  const render = (next: Record<string, unknown> = {}) => {
    Object.assign(state, next); harness.cursor = 0;
    useAppLifecycleEffects({ state, saveScene, saveActiveApplication, changeRendererBackend });
    harness.effects.splice(0).forEach(effect => effect());
  };
  return { state, render, saveScene, saveActiveApplication, changeRendererBackend, unsubscribe };
}

describe("application lifecycle autosave", () => {
  it("debounces application edits and cancels the pending save when disabled", async () => {
    const app = fixture({ applicationState: { dirty: true } }); app.render();
    await vi.advanceTimersByTimeAsync(1_000); app.render({ applicationRevision: 1 });
    await vi.advanceTimersByTimeAsync(1_000); expect(app.saveActiveApplication).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200); expect(app.saveActiveApplication).toHaveBeenCalledExactlyOnceWith(true);
    app.render({ applicationRevision: 2 }); app.render({ autoSaveEnabled: false });
    await vi.advanceTimersByTimeAsync(2_000); expect(app.saveActiveApplication).toHaveBeenCalledTimes(1);
  });

  it("does not save an opened scene and discards the old timer when switching scenes", async () => {
    const app = fixture(); app.render(); await vi.advanceTimersByTimeAsync(1_500);
    expect(app.saveScene).not.toHaveBeenCalled();
    app.render({ revision: 11 }); await vi.advanceTimersByTimeAsync(1_000);
    app.render({ activeScene: { id: "scene-b" }, revision: 12 });
    await vi.advanceTimersByTimeAsync(1_500); expect(app.saveScene).not.toHaveBeenCalled();
    app.render({ revision: 13 }); await vi.advanceTimersByTimeAsync(1_500);
    expect(app.saveScene).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("cancels saves on busy state, route departure and unmount", async () => {
    const app = fixture({ applicationState: { dirty: true } }); app.render(); app.render({ revision: 11 });
    app.render({ busy: true }); await vi.advanceTimersByTimeAsync(2_000);
    expect(app.saveScene).not.toHaveBeenCalled(); expect(app.saveActiveApplication).not.toHaveBeenCalled();
    app.render({ busy: false, route: { view: "manager" } });
    unmount(); await vi.advanceTimersByTimeAsync(2_000);
    expect(app.saveScene).not.toHaveBeenCalled(); expect(app.saveActiveApplication).not.toHaveBeenCalled();
    expect(app.unsubscribe).toHaveBeenCalledOnce();
  });
});

describe("published renderer lifecycle", () => {
  it.each(["preparing", "recovering", "failed"])("does not restart automatic switching in %s phase", async rendererSwitchPhase => {
    const app = fixture({ route: { view: "published" }, rendererSwitchPhase }); app.render();
    expect(harness.resolvePublishedRenderer).not.toHaveBeenCalled();
    app.render({ route: { view: "studio" }, rendererBackend: "webgpu" });
    await Promise.resolve(); expect(app.changeRendererBackend).not.toHaveBeenCalled();
  });

  it("suppresses automatic switching while a renderer transaction is active", () => {
    const app = fixture({ route: { view: "published" }, rendererSwitching: true }); app.render();
    app.render({ route: { view: "studio" }, rendererBackend: "webgpu" });
    expect(harness.resolvePublishedRenderer).not.toHaveBeenCalled(); expect(app.changeRendererBackend).not.toHaveBeenCalled();
  });

  it("ignores a late published decision after navigation and restores the author preference", async () => {
    const pending = deferred<{ backend: string }>(); harness.resolvePublishedRenderer.mockReturnValue(pending.promise);
    const app = fixture({ route: { view: "published" }, rendererBackend: "webgpu" }); app.render();
    app.render({ route: { view: "studio" } });
    expect(app.changeRendererBackend).toHaveBeenCalledExactlyOnceWith("webgl", {
      persistPreference: false, message: "已恢复用户渲染偏好：WebGL",
    });
    pending.resolve({ backend: "webgl" }); await Promise.resolve();
    expect(app.changeRendererBackend).toHaveBeenCalledTimes(1);
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
  });

  it("uses delivery mode and reports fallback without overwriting the saved preference", async () => {
    harness.sceneViewerDeliveryRendererMode.mockReturnValue("webgpu");
    harness.resolvePublishedRenderer.mockResolvedValue({ backend: "webgl", reason: "webgpu-unavailable" });
    const app = fixture({ route: { view: "published" }, rendererBackend: "webgpu" }); app.render(); await Promise.resolve();
    expect(harness.resolvePublishedRenderer).toHaveBeenCalledExactlyOnceWith("webgpu", {});
    expect(app.changeRendererBackend).toHaveBeenCalledExactlyOnceWith("webgl", {
      persistPreference: false, message: "当前设备无法使用 WebGPU，发布页已自动使用 WebGL",
    });
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
  });

  it("cancels a pending published decision on unmount", async () => {
    const pending = deferred<{ backend: string }>(); harness.resolvePublishedRenderer.mockReturnValue(pending.promise);
    const app = fixture({ route: { view: "published" } }); app.render(); unmount();
    pending.resolve({ backend: "webgpu" }); await Promise.resolve(); expect(app.changeRendererBackend).not.toHaveBeenCalled();
  });
});

describe("asynchronous lifecycle cleanup", () => {
  it("does not restore an invalidated user when the old session request resolves late", async () => {
    const user = deferred<unknown>(); harness.getAuthToken.mockReturnValue("session"); harness.me.mockReturnValue(user.promise);
    harness.setAuthToken.mockImplementation(() => harness.getAuthToken.mockReturnValue(undefined));
    const app = fixture(); app.render(); window.dispatchEvent(new Event("bim-studio-auth-required"));
    expect(app.state.setCurrentUser).toHaveBeenCalledExactlyOnceWith(undefined);
    user.resolve({ id: "invalidated-user" }); await Promise.resolve();
    expect(app.state.setCurrentUser).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("cancels the scheduled session retry when authentication is invalidated", async () => {
    harness.getAuthToken.mockReturnValue("session"); harness.me.mockRejectedValue(new Error("offline"));
    harness.setAuthToken.mockImplementation(() => harness.getAuthToken.mockReturnValue(undefined));
    const app = fixture(); app.render(); await vi.advanceTimersByTimeAsync(0);
    expect(harness.me).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event("bim-studio-auth-required")); await vi.advanceTimersByTimeAsync(6_000);
    expect(harness.me).toHaveBeenCalledTimes(1);
    expect(app.state.setCurrentUser).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("discards branding, user and Revit results after unmount", async () => {
    const branding = deferred<unknown>(); const user = deferred<unknown>(); const revit = deferred<unknown>();
    harness.getBranding.mockReturnValue(branding.promise); harness.me.mockReturnValue(user.promise);
    harness.getAuthToken.mockReturnValue("session"); harness.listRevitInstallations.mockReturnValue(revit.promise);
    const app = fixture({ currentUser: { id: "user" }, rvtRevitVersion: "2024" }); app.render(); unmount();
    branding.resolve({ defaultLocale: "en" }); user.resolve({ id: "restored" }); revit.resolve({ installations: [] });
    await Promise.resolve();
    expect(app.state.setBranding).not.toHaveBeenCalled(); expect(app.state.setLocale).not.toHaveBeenCalled();
    expect(app.state.setCurrentUser).not.toHaveBeenCalled(); expect(app.state.setRevitRuntime).not.toHaveBeenCalled();
    expect(app.state.setRvtRevitVersion).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("bim-studio-auth-required")); expect(harness.setAuthToken).not.toHaveBeenCalled();
  });

  it("bounds unavailable session retries without deleting the token", async () => {
    harness.getAuthToken.mockReturnValue("session"); harness.me.mockRejectedValue(new Error("offline"));
    const app = fixture(); app.render(); await vi.advanceTimersByTimeAsync(4_000);
    expect(harness.me).toHaveBeenCalledTimes(3); expect(app.state.setAuthReady).toHaveBeenCalledExactlyOnceWith(true);
    expect(harness.setAuthToken).not.toHaveBeenCalled(); expect(app.state.setCurrentUser).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000); expect(harness.me).toHaveBeenCalledTimes(3);
  });

  it("removes scheduled session retries on unmount", async () => {
    harness.getAuthToken.mockReturnValue("session"); harness.me.mockRejectedValue(new Error("offline"));
    const app = fixture(); app.render(); await vi.advanceTimersByTimeAsync(0); unmount();
    await vi.advanceTimersByTimeAsync(6_000); expect(harness.me).toHaveBeenCalledTimes(1);
    expect(app.state.setAuthReady).not.toHaveBeenCalled();
  });
});
