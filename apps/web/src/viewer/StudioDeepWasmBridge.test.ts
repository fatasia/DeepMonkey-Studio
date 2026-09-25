import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDeepWasmBridge, type DeepWasmRuntimeModule } from "./StudioDeepWasmBridge";

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

  it("reuses the live session for scene revisions and restores WebGL on failure", async () => {
    const runtime = fakeRuntime();
    const { bridge, author, presentation } = fixture(runtime.module);
    await bridge.switchTo("wasm");
    expect((await bridge.refresh()).status).toBe("switched");
    expect(runtime.update).toHaveBeenCalledWith(7, new Uint8Array([1, 2, 3]));
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

  function fixture(module: DeepWasmRuntimeModule) {
    const author = canvas();
    const appended: ReturnType<typeof canvas>[] = [];
    const container = { append: (value: ReturnType<typeof canvas>) => appended.push(value) };
    let callback: () => void = () => undefined;
    const presentation = vi.fn();
    const viewer = {
      renderer: { domElement: author },
      getCameraState: () => ({ position: { x: 2, y: 3, z: 4 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }),
      getCameraProjectionState: () => ({ verticalFovDegrees: 60, near: 0.1, far: 900 }),
      setPresentationRendererBackend: presentation,
      subscribePresentationFrames: (next: () => void) => { callback = next; return () => { callback = () => undefined; }; },
    };
    const bridge = new StudioDeepWasmBridge(viewer as never, container as never, {
      loadModule: async () => module,
      compilePackage: async () => new Uint8Array([1, 2, 3]),
      preparationTimeoutMs: 100,
    });
    owned.push(bridge);
    return { bridge, author, presentation, frame: () => callback(), appended };
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
  const module: DeepWasmRuntimeModule = {
    default: vi.fn(async () => undefined),
    set_scene_package: setPackage,
    start_scene_viewer: start,
    stop_scene_viewer: stop,
    update_scene_viewer: update,
    set_viewer_camera: camera,
    viewer_ready_generation: () => generation,
    viewer_failure_message: () => state.failure,
  };
  return {
    module, setPackage, start, stop, update, camera,
    set failure(value: string | undefined) { state.failure = value; },
  };
}
