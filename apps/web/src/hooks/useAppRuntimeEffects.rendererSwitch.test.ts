import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  cursor: 0, refs: [] as Array<{ current: unknown }>,
  dependencies: undefined as unknown[] | undefined,
  cleanup: undefined as (() => void) | undefined,
  pendingEffect: undefined as (() => void | (() => void)) | undefined,
  deep: { activeBackend: "webgl", switchTo: vi.fn(), cancelPendingSwitch: vi.fn() },
  wasm: { activeBackend: "webgl", switchTo: vi.fn(), cancelPendingSwitch: vi.fn() },
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
    // Execute the real backend switching effect; unrelated runtime effects stay inactive.
    if (deps.length !== 6 || typeof deps[1] !== "string" || typeof deps[2] !== "string" || typeof deps[3] !== "boolean") return;
    if (!harness.dependencies || deps.some((value, index) => !Object.is(value, harness.dependencies?.[index]))) {
      harness.dependencies = deps;
      harness.pendingEffect = effect;
    }
  },
}));
vi.mock("./useAppInteractionEffects", () => ({ useAppInteractionEffects: vi.fn() }));
vi.mock("../viewer/StudioDeepWebGpuBridge", () => ({ StudioDeepWebGpuBridge: vi.fn(), b4HlodClusterEnabled: vi.fn() }));
vi.mock("../viewer/StudioDeepWasmBridge", () => ({ StudioDeepWasmBridge: vi.fn() }));
vi.mock("../viewer/deepOutlineSupport", () => ({ deepSupportsObjectOutline: () => harness.outlineSupported }));
import { useAppRuntimeEffects } from "./useAppRuntimeEffects";

type Context = Parameters<typeof useAppRuntimeEffects>[0];
type Result = { status: "switched" | "unchanged" | "failed"; activeBackend: "webgl" | "webgpu" | "wasm"; error?: string };
function deferred() {
  let resolve!: (result: Result) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Result>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

function fixture() {
  const switching: boolean[] = [];
  const state = {
    engine: { getAuthorRendererBackend: () => "webgl" }, rendererBackend: "webgpu", rendererActiveBackend: "webgl", revision: 1,
    rendererOutlineRequired: false,
    route: { view: "studio" }, applicationState: { variables: {} }, rendererPreferenceCommitRef: { current: "webgpu" },
    showError: vi.fn(), setRendererSwitchPhase: vi.fn(), setRendererSwitchMessage: vi.fn(), setMessage: vi.fn(),
    setRendererSwitching: vi.fn((value: boolean) => switching.push(value)),
    setRendererBackend: vi.fn((value: string) => { state.rendererBackend = value; render(); }),
    setRendererActiveBackend: vi.fn((value: string) => { state.rendererActiveBackend = value; render(); }),
  };
  function render() {
    harness.cursor = 0;
    useAppRuntimeEffects(state as unknown as Context);
    if (harness.pendingEffect) {
      const effect = harness.pendingEffect;
      harness.pendingEffect = undefined;
      harness.cleanup?.();
      harness.cleanup = effect() || undefined;
    }
  }
  return { state, switching, render };
}

beforeEach(() => {
  vi.clearAllMocks(); harness.cursor = 0; harness.refs = []; harness.dependencies = undefined;
  harness.cleanup = undefined; harness.pendingEffect = undefined;
  harness.deep.activeBackend = "webgl"; harness.wasm.activeBackend = "webgl"; harness.outlineSupported = true;
  harness.wasm.switchTo.mockResolvedValue({ status: "unchanged", activeBackend: "webgl" });
  vi.stubGlobal("window", { localStorage: { setItem: vi.fn() } });
});
afterEach(() => { harness.cleanup?.(); vi.unstubAllGlobals(); });

describe("real runtime renderer switching effect", () => {
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
    app.state.revision++; app.render(); await flush();
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
    app.state.revision++; app.render(); await flush(); harness.cleanup?.(); harness.cleanup = undefined;
    late.reject(new Error("late")); await flush();
    expect(app.switching).toEqual([true, false, true]);
    expect(app.state.showError).toHaveBeenCalledOnce();
  });

  it("switches to Deep for a scene with object outline now that Deep implements it", async () => {
    const pending = deferred(); harness.deep.switchTo.mockReturnValue(pending.promise);
    const app = fixture();
    app.state.rendererOutlineRequired = true;
    app.render(); await flush();
    expect(harness.deep.switchTo).toHaveBeenCalledWith("webgpu");
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
