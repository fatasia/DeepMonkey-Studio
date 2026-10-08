import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { fullFixture } from "../controllers/sceneRendererRecoveryFullDomainFixture.testUtils";

const harness = vi.hoisted(() => ({
  cursor: 0, refs: [] as Array<{ current: unknown }>,
  dependencies: undefined as unknown[] | undefined,
  cleanup: undefined as (() => void) | undefined,
  pendingEffect: undefined as (() => void | (() => void)) | undefined,
  bridgeDependencies: undefined as unknown[] | undefined,
  pendingBridgeEffect: undefined as (() => void | (() => void)) | undefined,
  bridgeCleanup: undefined as (() => void) | undefined,
  refreshEnabled: false,
  refreshDependencies: undefined as unknown[] | undefined,
  pendingRefreshEffect: undefined as (() => void | (() => void)) | undefined,
  refreshCleanup: undefined as (() => void) | undefined,
  compilePackage: undefined as ((signal: AbortSignal) => Promise<{ bytes: Uint8Array; canonicalHash?: string }>) | undefined,
  batch: false,
  runtimeFailures: {} as Partial<Record<"webgpu" | "wasm", (error: Error) => void>>,
  deep: { activeBackend: "webgl", switchTo: vi.fn(), cancelPendingSwitch: vi.fn(), dispose: vi.fn() },
  wasm: { activeBackend: "webgl", switchTo: vi.fn(), refresh: vi.fn(), cancelPendingSwitch: vi.fn(), dispose: vi.fn() },
  outlineSupported: true,
}));
vi.mock("react", () => ({
  startTransition: (run: () => void) => run(),
  useState: (value: unknown) => [value, vi.fn()],
  useRef: (value: unknown) => {
    const index = harness.cursor++;
    harness.refs[index] ??= { current: index === 0 ? harness.deep : index === 1 ? harness.wasm : value };
    return harness.refs[index];
  },
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    if (harness.refreshEnabled && deps.length === 3 && typeof deps[1] === "string" && typeof deps[2] === "number") {
      if (!harness.refreshDependencies || deps.some((value, index) => !Object.is(value, harness.refreshDependencies?.[index]))) {
        harness.refreshDependencies = deps; harness.pendingRefreshEffect = effect;
      }
      return;
    }
    if (deps.length === 2 && typeof (deps[0] as { getAuthorRendererBackend?: unknown })?.getAuthorRendererBackend === "function"
      && typeof deps[1] === "object" && deps[1] !== null && "current" in deps[1]) {
      if (!harness.bridgeDependencies || deps.some((value, index) => !Object.is(value, harness.bridgeDependencies?.[index]))) {
        harness.bridgeDependencies = deps; harness.pendingBridgeEffect = effect;
      }
      return;
    }
    // Execute the real backend switching effect; unrelated runtime effects stay inactive.
    if (deps.length !== 4 || typeof deps[1] !== "string" || typeof deps[2] !== "string" || typeof deps[3] !== "boolean") return;
    if (!harness.dependencies || deps.some((value, index) => !Object.is(value, harness.dependencies?.[index]))) {
      harness.dependencies = deps;
      harness.pendingEffect = effect;
    }
  },
}));
vi.mock("./useAppInteractionEffects", () => ({ useAppInteractionEffects: vi.fn() }));
vi.mock("../delivery/compileSceneRenderPacket", () => ({ compileSceneRenderPacket: vi.fn(async () => ({
  packet: { schema: "deep-engine.render-packet", version: 1, geometries: [], materials: [], instances: [] },
})) }));
vi.mock("../viewer/StudioDeepWebGpuBridge", () => ({ StudioDeepWebGpuBridge: vi.fn(function (_engine: unknown, _viewport: unknown, options: { onRuntimeFailure(error: Error): void }) {
  harness.runtimeFailures.webgpu = options.onRuntimeFailure; return harness.deep;
}), b4HlodClusterEnabled: vi.fn() }));
vi.mock("../viewer/StudioDeepWasmBridge", () => ({ StudioDeepWasmBridge: vi.fn(function (_engine: unknown, _viewport: unknown, options: import("../viewer/StudioDeepWasmBridge").StudioDeepWasmBridgeOptions) {
  harness.runtimeFailures.wasm = options.onRuntimeFailure!;
  harness.compilePackage = async signal => {
    const result = await options.compilePackage(signal);
    options.onPackageAccepted?.(result, options.packageKey?.() ?? ""); return result;
  }; return harness.wasm;
}) }));
vi.mock("../viewer/studioWasmRuntimePackage", () => ({ compileStudioWasmRuntimePackage: vi.fn(async () => ({ bytes: new Uint8Array([1]) })), normalizeStudioWasmModel: vi.fn() }));
vi.mock("../viewer/deepOutlineSupport", () => ({ deepSupportsObjectOutline: () => harness.outlineSupported }));
import { useAppRuntimeEffects } from "./useAppRuntimeEffects";
import { compileStudioWasmRuntimePackage } from "../viewer/studioWasmRuntimePackage";

type Context = Parameters<typeof useAppRuntimeEffects>[0];
type Result = { status: "switched" | "unchanged" | "failed"; activeBackend: "webgl" | "webgpu" | "wasm"; error?: string };
function deferred() {
  let resolve!: (result: Result) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Result>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 32; i++) await Promise.resolve(); }

function fixture() {
  const switching: boolean[] = [];
  const state = {
    engine: { getAuthorRendererBackend: () => "webgl" }, rendererBackend: "webgpu", rendererActiveBackend: "webgl", revision: 1,
    rendererOutlineRequired: false,
    activeScene: undefined as SceneSnapshot | undefined,
    project: undefined as ProjectRecord | undefined,
    captureSceneSnapshot: () => state.activeScene,
    viewportRef: { current: {} },
    route: { view: "studio" }, applicationState: { variables: {} }, rendererPreferenceCommitRef: { current: "webgpu" },
    showError: vi.fn(), setRendererSwitchPhase: vi.fn(), setRendererSwitchMessage: vi.fn(), setMessage: vi.fn(),
    setRendererSwitching: vi.fn((value: boolean) => switching.push(value)),
    setRendererBackend: vi.fn((value: string) => { state.rendererBackend = value; render(); }),
    setRendererActiveBackend: vi.fn((value: string) => { state.rendererActiveBackend = value; render(); }),
  };
  function render() {
    if (harness.batch) return;
    harness.cursor = 0;
    useAppRuntimeEffects(state as unknown as Context);
    if (harness.pendingBridgeEffect) {
      const effect = harness.pendingBridgeEffect; harness.pendingBridgeEffect = undefined;
      harness.bridgeCleanup?.(); harness.bridgeCleanup = effect() || undefined;
    }
    if (harness.pendingEffect) {
      const effect = harness.pendingEffect;
      harness.pendingEffect = undefined;
      harness.cleanup?.();
      harness.cleanup = effect() || undefined;
    }
    if (harness.pendingRefreshEffect) {
      const effect = harness.pendingRefreshEffect; harness.pendingRefreshEffect = undefined;
      harness.refreshCleanup?.(); harness.refreshCleanup = effect() || undefined;
    }
  }
  return { state, switching, render, async batch(run: () => Promise<void>) {
    harness.batch = true; try { await run(); } finally { harness.batch = false; render(); }
  } };
}

beforeEach(() => {
  vi.clearAllMocks(); harness.cursor = 0; harness.refs = []; harness.dependencies = undefined;
  harness.cleanup = undefined; harness.pendingEffect = undefined;
  harness.bridgeDependencies = undefined; harness.pendingBridgeEffect = undefined; harness.bridgeCleanup = undefined;
  harness.runtimeFailures = {}; harness.batch = false;
  harness.refreshEnabled = false; harness.refreshDependencies = undefined; harness.pendingRefreshEffect = undefined;
  harness.refreshCleanup = undefined; harness.compilePackage = undefined;
  harness.deep.activeBackend = "webgl"; harness.wasm.activeBackend = "webgl"; harness.outlineSupported = true;
  harness.wasm.switchTo.mockResolvedValue({ status: "unchanged", activeBackend: "webgl" });
  vi.stubGlobal("window", { localStorage: { setItem: vi.fn() } });
});
afterEach(() => { harness.cleanup?.(); harness.bridgeCleanup?.(); harness.refreshCleanup?.(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("real runtime renderer switching effect", () => {
  it.each(["webgpu", "wasm"] as const)("rejects stale %s candidates for real author changes before retiring the current surface", async backend => {
    const source = fullFixture(), base = source.persistence.makeSnapshot()!, project = source.context.project!;
    const edits: Array<(scene: SceneSnapshot) => SceneSnapshot> = [
      scene => ({ ...scene, models: [...scene.models, { ...scene.models[0]!, modelId: "added-model" }] }),
      scene => ({ ...scene, models: scene.models.slice(1) }),
      scene => ({ ...scene, models: scene.models.map((model, index) => index ? model : { ...model, material: { color: "#ff1122", roughness: .8 } }) }),
      scene => ({ ...scene, lighting: { ...scene.lighting!, globalIlluminationIntensity: 3 } }),
      scene => ({ ...scene, id: "different-scene" }),
    ];
    for (const edit of edits) {
      harness.cleanup?.(); harness.bridgeCleanup?.(); harness.refs = []; harness.dependencies = undefined;
      harness.bridgeDependencies = undefined; harness.cleanup = undefined; harness.bridgeCleanup = undefined;
      const app = fixture(), pending = deferred();
      app.state.activeScene = structuredClone(base); app.state.project = project; app.state.rendererBackend = backend;
      const selected = backend === "webgpu" ? harness.deep : harness.wasm;
      selected.switchTo.mockReturnValue(pending.promise);
      app.render(); await flush();
      app.state.activeScene = edit(app.state.activeScene); app.state.revision++; app.render();
      const handoff = selected.switchTo.mock.lastCall![1] as (signal: AbortSignal) => Promise<void>;
      await expect(handoff(new AbortController().signal)).rejects.toThrow("场景在准备期间已变化");
      pending.resolve({ status: "failed", activeBackend: "webgl", error: "场景在准备期间已变化" }); await flush();
      expect(app.state.rendererBackend).toBe("webgl");
      expect(app.state.setRendererSwitchPhase).toHaveBeenLastCalledWith("failed");
    }
  });

  it.each(["webgpu", "wasm"] as const)("permits %s publication after capture time and camera change only", async backend => {
    const source = fullFixture(), app = fixture(), pending = deferred();
    app.state.activeScene = source.persistence.makeSnapshot()!; app.state.project = source.context.project!;
    app.state.rendererBackend = backend;
    const selected = backend === "webgpu" ? harness.deep : harness.wasm;
    selected.switchTo.mockReturnValue(pending.promise); app.render(); await flush();
    app.state.activeScene = { ...app.state.activeScene, updatedAt: "2026-10-07T15:00:00Z",
      camera: { ...app.state.activeScene.camera, position: { x: 22, y: 11, z: 7 } } };
    app.state.revision++; app.render();
    const handoff = selected.switchTo.mock.lastCall![1] as (signal: AbortSignal) => Promise<void>;
    await expect(handoff(new AbortController().signal)).resolves.toBeUndefined();
    selected.activeBackend = backend; pending.resolve({ status: "switched", activeBackend: backend }); await flush();
    expect(app.state.rendererActiveBackend).toBe(backend);
  });

  it("refreshes an active WASM package only for meaningful author content through its real compilation callback", async () => {
    vi.useFakeTimers(); harness.refreshEnabled = true;
    vi.stubGlobal("window", { localStorage: { setItem: vi.fn() }, setTimeout, clearTimeout });
    const source = fullFixture(), app = fixture();
    app.state.activeScene = source.persistence.makeSnapshot()!; app.state.project = source.context.project!;
    app.state.rendererBackend = "wasm";
    harness.wasm.switchTo.mockImplementation(async (backend: string, handoff?: (signal: AbortSignal) => Promise<void>) => {
      const signal = new AbortController().signal; await harness.compilePackage!(signal); await handoff?.(signal);
      harness.wasm.activeBackend = backend; return { status: "switched", activeBackend: backend };
    });
    harness.wasm.refresh.mockImplementation(async () => {
      await harness.compilePackage!(new AbortController().signal);
      return { status: "unchanged", activeBackend: "wasm" };
    });
    app.render(); await flush();
    expect(compileStudioWasmRuntimePackage).toHaveBeenCalledOnce();
    for (let revision = 2; revision < 10; revision++) {
      app.state.activeScene = { ...app.state.activeScene!, updatedAt: `capture-${revision}` };
      app.state.revision = revision; app.render(); await vi.advanceTimersByTimeAsync(500);
    }
    expect(harness.wasm.refresh).not.toHaveBeenCalled();
    app.state.activeScene = { ...app.state.activeScene!, models: app.state.activeScene!.models.slice(1) };
    app.state.revision++; app.render(); await vi.advanceTimersByTimeAsync(350); await flush();
    expect(harness.wasm.refresh).toHaveBeenCalledOnce();
    expect(compileStudioWasmRuntimePackage).toHaveBeenCalledTimes(2);
    app.state.revision++; app.render(); await vi.advanceTimersByTimeAsync(500);
    expect(harness.wasm.refresh).toHaveBeenCalledOnce();
  });
  it.each(["webgpu", "wasm"] as const)("keeps one %s candidate across autosaves, progress rerenders and new notification callbacks", async backend => {
    const pending = deferred(), app = fixture(); app.state.rendererBackend = backend;
    const selected = backend === "webgpu" ? harness.deep : harness.wasm;
    selected.switchTo.mockReturnValue(pending.promise);
    app.render(); await flush();
    const deepCancelled = harness.deep.cancelPendingSwitch.mock.calls.length;
    const wasmCancelled = harness.wasm.cancelPendingSwitch.mock.calls.length;
    for (let revision = 2; revision < 22; revision++) {
      app.state.revision = revision; app.state.showError = vi.fn();
      app.state.rendererOutlineRequired = !app.state.rendererOutlineRequired;
      app.state.setRendererSwitchMessage(`stage-${revision}`);
      app.render(); await flush();
    }
    expect(selected.switchTo).toHaveBeenCalledOnce();
    expect(harness.deep.cancelPendingSwitch).toHaveBeenCalledTimes(deepCancelled);
    expect(harness.wasm.cancelPendingSwitch).toHaveBeenCalledTimes(wasmCancelled);
    expect(harness.deep.dispose).not.toHaveBeenCalled();
    expect(harness.wasm.dispose).not.toHaveBeenCalled();
    selected.activeBackend = backend;
    pending.resolve({ status: "switched", activeBackend: backend }); await flush();
    expect(app.state.rendererActiveBackend).toBe(backend);
    expect(app.switching).toEqual([true, false]);
  });

  it.each(["webgpu", "wasm"] as const)("settles a rejected %s request without retrying on subsequent scene saves", async backend => {
    const pending = deferred(), app = fixture(); app.state.rendererBackend = backend;
    const selected = backend === "webgpu" ? harness.deep : harness.wasm;
    selected.switchTo.mockReturnValue(pending.promise);
    app.render(); await flush();
    pending.reject(new RangeError("WebAssembly.instantiate: Out of memory")); await flush();
    expect(app.state.rendererBackend).toBe("webgl");
    expect(app.state.rendererActiveBackend).toBe("webgl");
    expect(app.state.setRendererSwitchPhase).toHaveBeenLastCalledWith("failed");
    expect(app.state.setRendererSwitchMessage).toHaveBeenLastCalledWith(expect.stringContaining("Out of memory"));
    for (let revision = 2; revision < 22; revision++) { app.state.revision = revision; app.render(); await flush(); }
    expect(selected.switchTo).toHaveBeenCalledOnce();
    expect(app.switching).toEqual([true, false]);
  });

  it.each([["webgpu", "success"], ["webgpu", "rejection"], ["wasm", "success"], ["wasm", "rejection"]] as const)("retains %s runtime failure through batched fallback and a late candidate %s", async (backend, outcome) => {
    const pending = deferred(), app = fixture(); app.state.rendererBackend = backend;
    (backend === "webgpu" ? harness.deep : harness.wasm).switchTo.mockReturnValue(pending.promise);
    app.render(); await flush();
    const failure = new Error("GPU completion rejected");
    await app.batch(async () => {
      harness.runtimeFailures[backend]!(failure);
      if (outcome === "success") pending.resolve({ status: "switched", activeBackend: backend });
      else pending.reject(new Error("stale candidate failure"));
      await flush(); // The promise settles before React commits the batched fallback.
    });
    expect(app.state.rendererBackend).toBe("webgl");
    expect(app.state.rendererActiveBackend).toBe("webgl");
    expect(app.state.setRendererSwitchPhase).toHaveBeenLastCalledWith("failed");
    expect(app.state.setRendererSwitchMessage).toHaveBeenLastCalledWith(expect.stringContaining(failure.message));
    expect(app.switching).toEqual([true, false]);
    expect(window.localStorage.setItem).not.toHaveBeenCalledWith("bim-studio.renderer-backend", backend);
    expect(app.state.showError).not.toHaveBeenCalled();
  });
  it("prepares WASM before retiring Deep and retains Deep on failed preparation", async () => {
    const app = fixture();
    app.state.rendererBackend = "wasm";
    app.state.rendererActiveBackend = "webgpu";
    harness.deep.activeBackend = "webgpu";
    const pending = deferred();
    harness.wasm.switchTo.mockReturnValue(pending.promise);
    app.render(); await flush();
    expect(harness.deep.switchTo).not.toHaveBeenCalled();
    expect(harness.wasm.switchTo).toHaveBeenCalledWith("wasm", expect.any(Function));
    pending.resolve({ status: "failed", activeBackend: "webgl", error: "candidate failed" });
    await flush();
    expect(app.state.rendererBackend).toBe("webgpu");
    expect(app.state.rendererActiveBackend).toBe("webgpu");
    expect(harness.deep.switchTo).not.toHaveBeenCalled();
  });

  it("retires WASM only when the prepared WebGPU candidate invokes its handoff", async () => {
    const app = fixture();
    app.state.rendererActiveBackend = "wasm";
    harness.wasm.activeBackend = "wasm";
    const pending = deferred();
    harness.deep.switchTo.mockReturnValue(pending.promise);
    app.render(); await flush();
    expect(harness.wasm.switchTo).not.toHaveBeenCalled();
    const handoff = harness.deep.switchTo.mock.calls[0]![1] as (signal: AbortSignal) => Promise<void>;
    await handoff(new AbortController().signal);
    expect(harness.wasm.switchTo).toHaveBeenCalledExactlyOnceWith("webgl");
  });
  it.each(["switched", "unchanged"] as const)("clears loading before %s backend commits invalidate the effect", async status => {
    const pending = deferred(); harness.deep.switchTo.mockReturnValue(pending.promise);
    const app = fixture(); app.render(); await flush();
    expect(app.switching).toEqual([true]);
    harness.deep.activeBackend = "webgpu"; pending.resolve({ status, activeBackend: "webgpu" }); await flush();
    expect(app.state.rendererActiveBackend).toBe("webgpu");
    expect(app.switching).toEqual([true, false]);
    expect(app.state.setRendererSwitchPhase).toHaveBeenLastCalledWith("idle");
    expect(window.localStorage.setItem).toHaveBeenCalledWith("bim-studio.renderer-backend", "webgpu");
  });

  it("clears loading before a failed candidate settles both backend dependencies to WebGL", async () => {
    const pending = deferred(); harness.deep.switchTo.mockReturnValue(pending.promise);
    const app = fixture(); app.render(); await flush();
    pending.resolve({ status: "failed", activeBackend: "webgl", error: "candidate rejected" }); await flush();
    expect(app.state.rendererBackend).toBe("webgl");
    expect(app.state.rendererActiveBackend).toBe("webgl");
    expect(app.switching).toEqual([true, false]);
    expect(app.state.setRendererSwitchPhase).toHaveBeenLastCalledWith("failed");
  });

  it("keeps a replacement candidate loading when the cancelled old result arrives", async () => {
    const old = deferred(), replacement = deferred();
    harness.deep.switchTo.mockReturnValueOnce(old.promise).mockReturnValueOnce(replacement.promise);
    const app = fixture(); app.render(); await flush();
    app.state.engine = { getAuthorRendererBackend: () => "webgl" }; app.render(); await flush();
    expect(app.switching).toEqual([true, true]);
    old.resolve({ status: "switched", activeBackend: "webgpu" }); await flush();
    expect(app.switching).toEqual([true, true]);
    expect(app.state.setRendererActiveBackend).not.toHaveBeenCalled();
    expect(window.localStorage.setItem).not.toHaveBeenCalled();
    harness.deep.activeBackend = "webgpu"; replacement.resolve({ status: "switched", activeBackend: "webgpu" }); await flush();
    expect(app.switching).toEqual([true, true, false]);
  });

  it("clears the owned request when preference recovery returns to the actual active surface", async () => {
    const pending = deferred(); harness.deep.switchTo.mockReturnValue(pending.promise);
    const app = fixture(); app.render(); await flush();
    app.state.rendererBackend = "webgl"; app.render();
    expect(app.switching).toEqual([true, false]);
    expect(app.state.setRendererSwitchPhase).toHaveBeenLastCalledWith("idle");
    pending.resolve({ status: "switched", activeBackend: "webgpu" }); await flush();
    expect(app.switching).toEqual([true, false]);
    expect(app.state.setRendererActiveBackend).not.toHaveBeenCalled();
  });

  it("reconciles matching React labels against the real bridge before clearing loading", async () => {
    const old = deferred(), retire = deferred();
    harness.deep.switchTo.mockReturnValueOnce(old.promise).mockReturnValueOnce(retire.promise);
    const app = fixture(); app.render(); await flush();
    harness.deep.activeBackend = "webgpu";
    app.state.rendererBackend = "webgl"; app.render(); await flush();
    expect(app.switching).toEqual([true, true]);
    expect(harness.deep.switchTo).toHaveBeenLastCalledWith("webgl");
    old.resolve({ status: "switched", activeBackend: "webgpu" }); await flush();
    expect(app.switching).toEqual([true, true]);
    harness.deep.activeBackend = "webgl";
    retire.resolve({ status: "switched", activeBackend: "webgl" }); await flush();
    expect(app.switching).toEqual([true, true, false]);
  });

  it("reports a current rejection and clears loading while ignoring a rejection after unmount", async () => {
    const pending = deferred(); harness.deep.switchTo.mockReturnValue(pending.promise);
    const app = fixture(); app.render(); await flush();
    const reason = new Error("switch rejected"); pending.reject(reason); await flush();
    expect(app.state.showError).toHaveBeenCalledExactlyOnceWith(reason);
    expect(app.switching).toEqual([true, false]);
    const late = deferred(); harness.deep.switchTo.mockReturnValue(late.promise);
    app.state.rendererBackend = "webgpu"; app.render(); await flush(); harness.cleanup?.(); harness.cleanup = undefined;
    late.reject(new Error("late")); await flush();
    expect(app.switching).toEqual([true, false, true]);
    expect(app.state.showError).toHaveBeenCalledOnce();
  });

  it("switches to Deep for a scene with object outline now that Deep implements it", async () => {
    const pending = deferred(); harness.deep.switchTo.mockReturnValue(pending.promise);
    const app = fixture();
    app.state.rendererOutlineRequired = true;
    app.render(); await flush();
    expect(harness.deep.switchTo).toHaveBeenCalledWith("webgpu", expect.any(Function));
    expect(app.state.setRendererBackend).not.toHaveBeenCalled();
    expect(app.state.setRendererSwitchPhase).not.toHaveBeenCalledWith("failed");
    harness.deep.activeBackend = "webgpu"; pending.resolve({ status: "switched", activeBackend: "webgpu" }); await flush();
    expect(app.state.rendererActiveBackend).toBe("webgpu");
    expect(app.switching).toEqual([true, false]);
  });

  it("keeps WebGL with an actionable reason only when Deep lacks the object outline capability (fail-closed)", () => {
    const app = fixture();
    harness.outlineSupported = false;
    app.state.rendererOutlineRequired = true;
    app.render();
    expect(app.state.setRendererBackend).toHaveBeenCalledWith("webgl");
    expect(app.state.setRendererActiveBackend).toHaveBeenCalledWith("webgl");
    expect(app.state.setRendererSwitchPhase).toHaveBeenCalledWith("failed");
    expect(app.state.setRendererSwitchMessage).toHaveBeenCalledWith(expect.stringContaining("描边"));
    expect(harness.deep.switchTo).not.toHaveBeenCalled();
    expect(app.switching).toEqual([]);
  });
});
