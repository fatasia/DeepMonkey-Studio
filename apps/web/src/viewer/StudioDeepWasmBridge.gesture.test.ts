import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudioDeepWasmBridge, type DeepWasmRuntimeModule, type StudioDeepWasmAuthorHost } from "./StudioDeepWasmBridge";

// 视口手势接管合同:宿主接受 → Deep 画布持有输入+每帧姿态写回;宿主拒绝/缺缝 → 优雅降级保持旧输入路径;回退 WebGL → 恢复。
describe("StudioDeepWasmBridge viewport gesture takeover", () => {
  const owned: StudioDeepWasmBridge[] = [];
  let createdCanvases: ReturnType<typeof canvas>[];

  beforeEach(() => {
    createdCanvases = [];
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { gpu: {} });
    vi.stubGlobal("performance", { now: performance.now.bind(performance), mark: vi.fn() });
    const realNow = performance.now;
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

  function host(overrides: Partial<StudioDeepWasmAuthorHost> = {}) {
    let frameListener: (() => void) = () => undefined;
    const subscribePresentationFrames = vi.fn((next: () => void) => {
      frameListener = next;
      return () => { frameListener = () => undefined; };
    });
    const hostObject = {
      renderer: { domElement: canvas() as unknown as HTMLCanvasElement },
      getCameraState: () => ({ position: { x: 7, y: 2, z: 3 }, target: { x: 4, y: 0, z: 0 } }),
      getCameraProjectionState: () => ({ verticalFovDegrees: 50, near: 0.1, far: 900 }),
      setPresentationRendererBackend: vi.fn(),
      subscribePresentationFrames,
      enableViewportGestureTakeover: vi.fn(() => true),
      disableViewportGestureTakeover: vi.fn(),
      isViewportGestureSuppressed: vi.fn(() => false),
      applyViewportCameraPose: vi.fn(),
      ...overrides,
    } as StudioDeepWasmAuthorHost & Record<string, ReturnType<typeof vi.fn>>;
    return { hostObject, frame: () => frameListener() };
  }

  it("activates takeover when the host accepts and applies poses per author frame", async () => {
    const runtime = fakeRuntime();
    const author = canvas() as unknown as HTMLCanvasElement;
    const { hostObject: hostStub, frame } = host({ renderer: { domElement: author } });
    const bridge = new StudioDeepWasmBridge(hostStub, container(), {
      loadModule: async () => runtime.module,
      compilePackage: async () => new Uint8Array([1, 2, 3]),
      preparationTimeoutMs: 100,
    });
    owned.push(bridge);

    const result = await bridge.switchTo("wasm");
    expect(result.status).toBe("switched");
    expect(hostStub.enableViewportGestureTakeover).toHaveBeenCalledOnce();
    expect(createdCanvases[0]?.style.pointerEvents).toBe("auto");

    // 作者帧:控制器 tick 后姿态写回宿主,再经 ε 去重走 set_viewer_camera。
    frame();
    expect(hostStub.applyViewportCameraPose).toHaveBeenCalledTimes(1);
    expect(runtime.camera).toHaveBeenCalled();

    await bridge.switchTo("webgl");
    expect(hostStub.disableViewportGestureTakeover).toHaveBeenCalledOnce();
    expect(createdCanvases[0]?.style.pointerEvents).toBe("none");
  });

  it("degrades gracefully when the host declines the takeover", async () => {
    const runtime = fakeRuntime();
    const author = canvas() as unknown as HTMLCanvasElement;
    const { hostObject: hostStub, frame } = host({
      renderer: { domElement: author },
      enableViewportGestureTakeover: vi.fn(() => false),
      disableViewportGestureTakeover: vi.fn(),
    });
    const bridge = new StudioDeepWasmBridge(hostStub, container(), {
      loadModule: async () => runtime.module,
      compilePackage: async () => new Uint8Array([1, 2, 3]),
      preparationTimeoutMs: 100,
    });
    owned.push(bridge);

    const result = await bridge.switchTo("wasm");
    expect(result.status).toBe("switched");
    expect(createdCanvases[0]?.style.pointerEvents).toBe("none");
    expect(createdCanvases[0]?.style.opacity).toBe("1");
    frame();
    expect(hostStub.applyViewportCameraPose).not.toHaveBeenCalled();

    await bridge.switchTo("webgl");
    expect(hostStub.disableViewportGestureTakeover).not.toHaveBeenCalled();
  });

  it("stops the takeover on dispose", async () => {
    const runtime = fakeRuntime();
    const { hostObject: hostStub } = host();
    const bridge = new StudioDeepWasmBridge(hostStub, container(), {
      loadModule: async () => runtime.module,
      compilePackage: async () => new Uint8Array([1, 2, 3]),
      preparationTimeoutMs: 100,
    });
    owned.splice(0);
    await bridge.switchTo("wasm");
    bridge.dispose();
    expect(hostStub.disableViewportGestureTakeover).toHaveBeenCalledOnce();
  });
});

function canvas() {
  return { style: { position: "", inset: "", width: "", height: "", opacity: "1", zIndex: "", pointerEvents: "auto" },
    dataset: {}, clientWidth: 640, clientHeight: 480, setAttribute: vi.fn(), remove: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), hasPointerCapture: vi.fn(() => false) };
}

function container() {
  return { clientWidth: 640, clientHeight: 480, append: vi.fn() } as unknown as HTMLElement;
}

function fakeRuntime() {
  let generation = 0;
  const state = { failure: undefined as string | undefined };
  const runtime = {
    setPackage: vi.fn(),
    start: vi.fn(() => { generation++; return 7; }),
    stop: vi.fn(),
    update: vi.fn(() => { if (!state.failure) generation++; }),
    failure: undefined as string | undefined,
    camera: vi.fn(),
    module: undefined as unknown as DeepWasmRuntimeModule,
  };
  runtime.module = {
    default: async () => undefined,
    set_scene_package: runtime.setPackage,
    start_scene_viewer: runtime.start as unknown as DeepWasmRuntimeModule["start_scene_viewer"],
    stop_scene_viewer: runtime.stop as unknown as DeepWasmRuntimeModule["stop_scene_viewer"],
    update_scene_viewer: runtime.update as unknown as DeepWasmRuntimeModule["update_scene_viewer"],
    set_viewer_camera: runtime.camera as unknown as DeepWasmRuntimeModule["set_viewer_camera"],
    viewer_ready_generation: () => (state.failure ? -1 : generation),
    viewer_failure_message: () => state.failure,
  };
  return runtime;
}
