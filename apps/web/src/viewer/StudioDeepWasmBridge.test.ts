import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDeepWasmBridge, type DeepWasmRuntimeModule } from "./StudioDeepWasmBridge";
import type { StudioWasmCompiledPackage } from "./studioWasmCompilationClient";

describe("StudioDeepWasmBridge", () => {
  const owned: StudioDeepWasmBridge[] = [];
  let createdCanvases: ReturnType<typeof canvas>[];

  beforeEach(() => {
    createdCanvases = [];
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { gpu: {} });
    vi.stubGlobal("document", { createElement: () => {
      const value = canvas();
      createdCanvases.push(value);
      return value;
    } });
  });

  afterEach(() => {
    owned.splice(0).forEach((bridge) => bridge.dispose());
    vi.unstubAllGlobals();
  });

  it("publishes only after the full runtime reports ready and keeps author input", async () => {
    const runtime = fakeRuntime();
    const { bridge, author, presentation, frame } = fixture(runtime.module);
    const result = await bridge.switchTo("wasm");

    expect(result).toEqual({ status: "switched", activeBackend: "wasm" });
    expect(runtime.setPackage).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]));
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(author.style.opacity).toBe("0");
    expect(author.style.pointerEvents).toBe("auto");
    expect(createdCanvases[0]?.dataset.rendererBackend).toBe("deep-wasm");
    expect(presentation).toHaveBeenLastCalledWith("wasm");

    frame();
    expect(runtime.camera).toHaveBeenCalledWith(7, 2, 3, 4, 0, 0, 0, expect.any(Number), 0.1, 900);
  });

  it("prewarms a hidden session without taking author input, then switches without rebuilding", async () => {
    const runtime = fakeRuntime();
    runtime.module.set_scene_viewer_paused = vi.fn();
    const { bridge, author, presentation } = fixture(runtime.module);
    expect((await bridge.prewarm(new AbortController().signal)).status).toBe("switched");
    expect(bridge.activeBackend).toBe("webgl"); expect(presentation).not.toHaveBeenCalled();
    expect(author.style.opacity).toBe("1"); expect(createdCanvases[0]?.style.opacity).toBe("0");
    expect(runtime.module.set_scene_viewer_paused).toHaveBeenLastCalledWith(7, true);
    expect((await bridge.switchTo("wasm")).status).toBe("switched");
    expect(runtime.start).toHaveBeenCalledOnce(); expect(runtime.update).not.toHaveBeenCalled();
    expect(runtime.module.set_scene_viewer_paused).toHaveBeenLastCalledWith(7, false);
    await bridge.switchTo("webgl");
    expect(runtime.module.set_scene_viewer_paused).toHaveBeenLastCalledWith(7, true);
  });

  it("reuses the live session for scene revisions and restores WebGL on failure", async () => {
    const runtime = fakeRuntime();
    const { bridge, author, presentation, compilePackage } = fixture(runtime.module);
    await bridge.switchTo("wasm");
    compilePackage.mockResolvedValue({ bytes: new Uint8Array([1, 2, 4]) });
    expect((await bridge.refresh()).status).toBe("switched");
    expect(runtime.update).toHaveBeenCalledWith(7, new Uint8Array([1, 2, 4]));
    expect(author.style.opacity).toBe("0");
    expect(createdCanvases[0]?.style.opacity).toBe("1");

    runtime.failure = "GPU initialization rejected";
    const result = await bridge.refresh();
    expect(result.status).toBe("failed");
    expect(author.style.opacity).toBe("1");
    expect(presentation).toHaveBeenLastCalledWith("webgl");
  });

  it("stops a newly started runtime when readiness fails", async () => {
    const runtime = fakeRuntime();
    runtime.failure = "WASM renderer startup failed";
    const { bridge } = fixture(runtime.module);

    const result = await bridge.switchTo("wasm");

    expect(result).toEqual({ status: "failed", activeBackend: "webgl", error: "WASM renderer startup failed" });
    expect(runtime.stop).toHaveBeenCalledWith(7);
    expect(createdCanvases[0]?.remove).toHaveBeenCalledOnce();
  });

  it("reuses an identical package after a WebGL round trip without native rebuild", async () => {
    const runtime = fakeRuntime();
    const { bridge, compilePackage } = fixture(runtime.module);
    await bridge.switchTo("wasm");
    await bridge.switchTo("webgl");
    const retirement = vi.fn(async () => {
      expect(runtime.start).toHaveBeenCalledOnce();
      expect(runtime.update).not.toHaveBeenCalled();
    });
    expect((await bridge.switchTo("wasm", retirement)).status).toBe("switched");
    expect(retirement).toHaveBeenCalledOnce();
    expect(compilePackage).toHaveBeenCalledTimes(2);
    expect((await bridge.refresh()).status).toBe("unchanged");
    expect(runtime.update).not.toHaveBeenCalled();
  });

  it("keeps the previous presentation when retirement rejects and cleans up the candidate", async () => {
    const runtime = fakeRuntime();
    const { bridge, presentation } = fixture(runtime.module);
    const result = await bridge.switchTo("wasm", async () => {
      expect(runtime.start).toHaveBeenCalledOnce();
      expect(presentation).not.toHaveBeenCalled();
      throw new Error("retirement rejected");
    });
    expect(result).toMatchObject({ status: "failed", error: "retirement rejected" });
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(createdCanvases[0]?.remove).toHaveBeenCalledOnce();
    expect(presentation).not.toHaveBeenCalled();
  });

  it("cancels before retiring the current renderer and removes the candidate canvas", async () => {
    const runtime = fakeRuntime();
    const { bridge } = fixture(runtime.module);
    const retirement = vi.fn(async () => bridge.cancelPendingSwitch());
    expect((await bridge.switchTo("wasm", retirement)).status).toBe("cancelled");
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(createdCanvases[0]?.remove).toHaveBeenCalledOnce();
  });

  it("reads only a matching committed physics pose from the active WASM session", async () => {
    const runtime = fakeRuntime();
    const { bridge } = fixture(runtime.module);
    await expect(bridge.physicsPose("projectile-instance")).rejects.toThrow(/not active/);
    await bridge.switchTo("wasm");
    await expect(bridge.physicsPose("projectile-instance")).resolves.toEqual({
      instanceId: "projectile-instance", fixedStep: 1, translation: [-0.06, 0, 0],
    });
    expect(runtime.pose).toHaveBeenCalledWith(7, "projectile-instance");
    await expect(bridge.physicsPose("other-instance")).rejects.toThrow(/invalid/);
  });

  it("prepares cooperatively, consumes the owned candidate once and skips unchanged packages", async () => {
    const runtime = fakeRuntime();
    runtime.module.prepare_scene_package = vi.fn(async () => 41);
    runtime.module.discard_prepared_scene_package = vi.fn();
    runtime.module.start_prepared_scene_viewer = vi.fn(() => runtime.start());
    runtime.module.update_prepared_scene_viewer = vi.fn(() => runtime.update());
    const { bridge, compilePackage } = fixture(runtime.module);
    expect((await bridge.switchTo("wasm")).status).toBe("switched");
    expect(runtime.setPackage).not.toHaveBeenCalled();
    expect(runtime.module.prepare_scene_package).toHaveBeenCalledWith(new Uint8Array([1,2,3]), undefined, expect.any(AbortSignal));
    expect(runtime.module.start_prepared_scene_viewer).toHaveBeenCalledWith(41, expect.any(Object));
    await bridge.switchTo("webgl");await bridge.switchTo("wasm");
    expect(runtime.module.prepare_scene_package).toHaveBeenCalledOnce();
    compilePackage.mockResolvedValue({bytes:new Uint8Array([1,2,4])});
    expect((await bridge.refresh()).status).toBe("switched");
    expect(runtime.module.update_prepared_scene_viewer).toHaveBeenCalledWith(7,41);
    expect(runtime.update).toHaveBeenCalledOnce();
    expect(runtime.module.discard_prepared_scene_package).not.toHaveBeenCalled();
  });

  it("discards a cancelled preparation without publishing or stealing another candidate", async () => {
    const runtime = fakeRuntime();
    runtime.module.prepare_scene_package = vi.fn(async () => { bridge.cancelPendingSwitch(); return 42; });
    runtime.module.discard_prepared_scene_package = vi.fn();
    runtime.module.start_prepared_scene_viewer = vi.fn();
    runtime.module.update_prepared_scene_viewer = vi.fn();
    const { bridge, author } = fixture(runtime.module);
    expect((await bridge.switchTo("wasm")).status).toBe("cancelled");
    expect(runtime.module.discard_prepared_scene_package).toHaveBeenCalledWith(42);
    expect(runtime.module.start_prepared_scene_viewer).not.toHaveBeenCalled();
    expect(author.style.opacity).toBe("1");
  });

  it("uses the expected hash when updating a changed parked legacy runtime", async () => {
    const runtime = fakeRuntime();
    runtime.module.update_scene_viewer_with_expected_hash = vi.fn(() => runtime.update());
    const { bridge, compilePackage } = fixture(runtime.module);
    await bridge.switchTo("wasm");await bridge.switchTo("webgl");
    const hash = "a".repeat(64);
    compilePackage.mockResolvedValue({bytes:new Uint8Array([1,2,4]),canonicalHash:hash});
    expect((await bridge.switchTo("wasm")).status).toBe("switched");
    expect(runtime.module.update_scene_viewer_with_expected_hash).toHaveBeenCalledWith(7,new Uint8Array([1,2,4]),hash);
  });

  it("uses a native scene receipt without retaining or recompiling its transport", async () => {
    const runtime = fakeRuntime(); let key = "scene-1";
    const accepted = vi.fn();
    const { bridge, compilePackage } = fixture(runtime.module, { packageKey: () => key, onPackageAccepted: accepted });
    await bridge.prewarm(new AbortController().signal);
    await bridge.switchTo("wasm");
    await bridge.switchTo("webgl"); await bridge.switchTo("wasm");
    expect((await bridge.refresh()).status).toBe("unchanged");
    expect(compilePackage).toHaveBeenCalledOnce(); expect(accepted).toHaveBeenCalledOnce();
    key = "scene-2"; compilePackage.mockResolvedValue({ bytes: new Uint8Array([1, 2, 4]) });
    expect((await bridge.refresh()).status).toBe("switched");
    expect(compilePackage).toHaveBeenCalledTimes(2); expect(runtime.update).toHaveBeenCalledOnce();
    expect(accepted).toHaveBeenLastCalledWith(expect.any(Object), "scene-2");
  });

  it("does not revive a cancelled foreground switch that was joining background preparation", async () => {
    let finish!: (value: StudioWasmCompiledPackage) => void;
    const runtime = fakeRuntime();
    const { bridge } = fixture(runtime.module, { compilePackage: () => new Promise(resolve => { finish = resolve; }) });
    const background = bridge.prewarm(new AbortController().signal);
    await Promise.resolve(); await Promise.resolve();
    const foreground = bridge.switchTo("wasm"); bridge.cancelPendingSwitch();
    finish({ bytes: new Uint8Array([1]) });
    expect((await background).status).toBe("cancelled");
    expect((await foreground).status).toBe("cancelled");
    expect(runtime.start).not.toHaveBeenCalled(); expect(bridge.activeBackend).toBe("webgl");
  });

  it("retires a scene receipt when a native update starts, even if the update is then cancelled", async () => {
    const runtime = fakeRuntime(); let key = "old";
    const { bridge, compilePackage } = fixture(runtime.module, { packageKey: () => key });
    await bridge.switchTo("wasm"); await bridge.switchTo("webgl");
    key = "new"; compilePackage.mockResolvedValue({ bytes: new Uint8Array([4]) });
    runtime.update.mockImplementationOnce(() => { bridge.cancelPendingSwitch(); });
    expect((await bridge.switchTo("wasm")).status).toBe("cancelled");
    key = "old"; compilePackage.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]) });
    expect((await bridge.switchTo("wasm")).status).toBe("switched");
    expect(compilePackage).toHaveBeenCalledTimes(3); expect(runtime.update).toHaveBeenCalledTimes(2);
  });

  function fixture(module: DeepWasmRuntimeModule, options: Partial<import("./StudioDeepWasmBridge").StudioDeepWasmBridgeOptions> = {}) {
    const author = canvas();
    const appended: ReturnType<typeof canvas>[] = [];
    const container = { append: (value: ReturnType<typeof canvas>) => appended.push(value) };
    let callback: () => void = () => undefined;
    const presentation = vi.fn();
    const compilePackage = vi.fn(async (): Promise<StudioWasmCompiledPackage> => ({ bytes: new Uint8Array([1, 2, 3]) }));
    const viewer = {
      renderer: { domElement: author },
      getCameraState: () => ({ position: { x: 2, y: 3, z: 4 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }),
      getCameraProjectionState: () => ({ verticalFovDegrees: 60, near: 0.1, far: 900 }),
      setPresentationRendererBackend: presentation,
      subscribePresentationFrames: (next: () => void) => { callback = next; return () => { callback = () => undefined; }; },
    };
    const bridge = new StudioDeepWasmBridge(viewer as never, container as never, {
      loadModule: async () => module,
      compilePackage,
      preparationTimeoutMs: 100,
      ...options,
    });
    owned.push(bridge);
    return { bridge, author, presentation, compilePackage, frame: () => callback(), appended };
  }
});

function canvas() {
  return {
    style: { position: "relative", inset: "", width: "640px", height: "480px",
      visibility: "visible", opacity: "1", zIndex: "2", pointerEvents: "auto" },
    dataset: {} as Record<string, string>,
    setAttribute: vi.fn(),
    remove: vi.fn(),
  };
}

function fakeRuntime() {
  let generation = 0;
  const state = { failure: undefined as string | undefined };
  const setPackage = vi.fn();
  const start = vi.fn(() => { generation++; return 7; });
  const update = vi.fn(() => { if (!state.failure) generation++; });
  const camera = vi.fn();
  const stop = vi.fn();
  const pose = vi.fn(async () => JSON.stringify({ instanceId: "projectile-instance", fixedStep: 1, translation: [-0.06, 0, 0] }));
  const module: DeepWasmRuntimeModule = {
    default: vi.fn(async () => undefined),
    set_scene_package: setPackage,
    start_scene_viewer: start,
    stop_scene_viewer: stop,
    update_scene_viewer: update,
    set_viewer_camera: camera,
    viewer_ready_generation: () => generation,
    viewer_failure_message: () => state.failure,
    viewer_physics_pose: pose,
  };
  return {
    module, setPackage, start, stop, update, camera, pose,
    set failure(value: string | undefined) { state.failure = value; },
  };
}
