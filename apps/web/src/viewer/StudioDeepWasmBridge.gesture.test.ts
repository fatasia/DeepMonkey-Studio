import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import assert from "node:assert/strict";
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
    // 输入会话转发路径需要 PointerEvent/MouseEvent 构造器(jsdom 未引入的最小桩)。
    class FakeDomEvent {
      type: string;
      constructor(type: string, init: Record<string, unknown> = {}) {
        this.type = type;
        Object.assign(this, init);
      }
    }
    vi.stubGlobal("PointerEvent", FakeDomEvent);
    vi.stubGlobal("MouseEvent", FakeDomEvent);
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
      getCameraState: () => ({ position: { x: 7, y: 2, z: 3 }, target: { x: 4, y: 0, z: 0 }, mode: "orbit" as const }),
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

  it("activates takeover when the host accepts; settled poses are not rewritten per author frame", async () => {
    const runtime = fakeRuntime();
    const author = canvas() as unknown as HTMLCanvasElement;
    const { hostObject: hostStub, frame } = host({ renderer: { domElement: author } });
    const bridge = new StudioDeepWasmBridge(hostStub, container(), {
      loadModule: async () => runtime.module,
      compilePackage: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
      preparationTimeoutMs: 100,
    });
    owned.push(bridge);

    const result = await bridge.switchTo("wasm");
    expect(result.status).toBe("switched");
    expect(hostStub.enableViewportGestureTakeover).toHaveBeenCalledOnce();
    expect(createdCanvases[0]?.style.pointerEvents).toBe("auto");

    // 作者帧:控制器姿态已与宿主一致且无收敛需求——不再每帧把接管时刻姿态刷回
    // 宿主(旧的无条件写回会覆盖 fitAll/标准视角,相机被冻结在切换时刻)。
    frame();
    expect(hostStub.applyViewportCameraPose).not.toHaveBeenCalled();
    expect(runtime.camera).toHaveBeenCalled(); // 相机 FFI 仍经 ε 去重正常同步

    await bridge.switchTo("webgl");
    expect(hostStub.disableViewportGestureTakeover).toHaveBeenCalledOnce();
    expect(createdCanvases[0]?.style.pointerEvents).toBe("none");
  });

  it("follows programmatic host camera changes instead of freezing the takeover pose", async () => {
    const runtime = fakeRuntime();
    const author = canvas() as unknown as HTMLCanvasElement;
    let cameraState = { position: { x: 7, y: 2, z: 3 }, target: { x: 4, y: 0, z: 0 }, mode: "orbit" as const };
    const { hostObject: hostStub, frame } = host({
      renderer: { domElement: author },
      getCameraState: () => cameraState,
    });
    const bridge = new StudioDeepWasmBridge(hostStub, container(), {
      loadModule: async () => runtime.module,
      compilePackage: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
      preparationTimeoutMs: 100,
    });
    owned.push(bridge);
    await bridge.switchTo("wasm");

    // 模拟"适应整个场景"/魔方位姿:宿主程序性改写相机(顶位姿)。
    cameraState = { position: { x: 0, y: 20, z: 0.001 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" as const };
    frame();
    // 控制器重设为宿主姿态,禁止把接管时刻的旧球坐标刷回(冻结回归)。
    expect(hostStub.applyViewportCameraPose).not.toHaveBeenCalled();
    const call = runtime.camera.mock.calls.at(-1) as unknown[] | undefined;
    assert.ok(call, "set_viewer_camera should receive the new host pose");
    expect(call[1]).toBeCloseTo(0, 6); // positionX
    expect(call[2]).toBeCloseTo(20, 6); // positionY

    // 已就位后继续作者帧:无收敛、无漂移,保持不写回。
    frame();
    expect(hostStub.applyViewportCameraPose).not.toHaveBeenCalled();
  });

  it("still applies converging gesture poses while the host camera matches the controller", async () => {
    const runtime = fakeRuntime();
    const author = canvas() as unknown as HTMLCanvasElement;
    const { hostObject: hostStub, frame } = host({ renderer: { domElement: author } });
    const bridge = new StudioDeepWasmBridge(hostStub, container(), {
      loadModule: async () => runtime.module,
      compilePackage: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
      preparationTimeoutMs: 100,
    });
    owned.push(bridge);
    await bridge.switchTo("wasm");

    // Deep 画布由桥经 document.createElement 创建;从其 addEventListener 调用记录取回绑定的事件。
    const deepCanvas = createdCanvases.at(-1)!;
    const addMock = deepCanvas.addEventListener as unknown as ReturnType<typeof vi.fn>;
    const registered = new Map<string, EventListener>(
      addMock.mock.calls.map(call => [call[0] as string, call[1] as EventListener]));
    assert.ok(registered.get("pointerdown"), "input session should bind pointerdown on the deep canvas");

    // 指针轨道手势:down+move 驱动控制器目标,作者帧把收敛中的姿态写回宿主。
    const down = { pointerId: 1, button: 0, buttons: 1, clientX: 100, clientY: 100, shiftKey: false,
      pointerType: "mouse", isPrimary: true, pressure: 0.5, preventDefault: () => undefined } as unknown as PointerEvent;
    registered.get("pointerdown")!(down);
    const move = { ...down, clientX: 160, clientY: 100 } as unknown as PointerEvent;
    registered.get("pointermove")!(move);
    frame();
    expect(hostStub.applyViewportCameraPose).toHaveBeenCalled();

    await bridge.switchTo("webgl");
  });

  it.each([0, 2])("coalesces button %s samples into one native update, including immediate pan", async button => {
    const runtime = fakeRuntime();
    let state = { position: { x: 7, y: 2, z: 3 }, target: { x: 4, y: 0, z: 0 }, mode: "orbit" as const };
    const continuous = vi.fn(); let now = 0;
    vi.stubGlobal("performance", { now: () => now, mark: vi.fn() });
    const { hostObject: hostStub, frame } = host({ setContinuousRender: continuous,
      getCameraState: () => state, applyViewportCameraPose: pose => {
        state = { ...state, position: { x: pose.eye[0], y: pose.eye[1], z: pose.eye[2] },
          target: { x: pose.target[0], y: pose.target[1], z: pose.target[2] } };
      } });
    const bridge = new StudioDeepWasmBridge(hostStub, container(), { loadModule: async () => runtime.module,
      compilePackage: async () => ({ bytes: new Uint8Array([1]) }), preparationTimeoutMs: 100 });
    owned.push(bridge); await bridge.switchTo("wasm"); runtime.camera.mockClear();
    const listeners = new Map<string, EventListener>(vi.mocked(createdCanvases[0]!.addEventListener).mock.calls.map(call => [call[0], call[1]]));
    const down = { pointerId: 1, button, buttons: button === 2 ? 2 : 1, clientX: 100, clientY: 100, shiftKey: false,
      pointerType: "mouse", preventDefault: () => undefined } as unknown as PointerEvent;
    listeners.get("pointerdown")!(down);
    for (let x = 101; x < 130; x++) listeners.get("pointermove")!({ ...down, clientX: x } as PointerEvent);
    expect(runtime.camera).not.toHaveBeenCalled();
    now += 16; frame(); expect(runtime.camera).toHaveBeenCalledOnce();
    expect(state.position).not.toEqual({ x: 7, y: 2, z: 3 });
    if (button === 2) expect(state.target).not.toEqual({ x: 4, y: 0, z: 0 });
    listeners.get("pointerup")!(down);
    for (let i = 0; i < 150; i++) { now += 16; frame(); }
    if (button === 0) expect(runtime.camera.mock.calls.length).toBeGreaterThan(2);
    else expect(runtime.camera).toHaveBeenCalledOnce();
    expect(continuous).toHaveBeenLastCalledWith("deep-camera", false);
    await bridge.switchTo("webgl"); expect(continuous).toHaveBeenLastCalledWith("deep-camera", false);
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
      compilePackage: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
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
      compilePackage: async () => ({ bytes: new Uint8Array([1, 2, 3]) }),
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
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
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
    viewer_physics_pose: async () => JSON.stringify({ instanceId: "unused", fixedStep: 0, translation: [0, 0, 0] }),
  };
  return runtime;
}
