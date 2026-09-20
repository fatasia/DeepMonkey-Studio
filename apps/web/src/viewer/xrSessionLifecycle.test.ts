import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ViewerEngine } from "./ViewerEngine";
import { AdaptiveRenderScaleController } from "./adaptiveRenderScale";
import {
  describeXrEntryBlock,
  describeXrSessionRequestFailure,
  describeXrSessionSetupFailure,
} from "./xrSession";

/** xrSession.test.ts 同款 stub 模式：Object.create + Object.assign，只装配被测路径需要的成员。 */
function createEngineStub(options: { setSessionError?: Error } = {}) {
  const xr: Record<string, unknown> = {
    enabled: false,
    setSession: options.setSessionError
      ? vi.fn(async () => { throw options.setSessionError; })
      : vi.fn(async () => undefined),
    setReferenceSpaceType: vi.fn(),
    getSession: () => null,
    getController: () => new THREE.Group(),
  };
  const renderer = Object.create(THREE.WebGLRenderer.prototype) as THREE.WebGLRenderer;
  Object.defineProperty(renderer, "xr", { value: xr, configurable: true });
  renderer.setAnimationLoop = vi.fn();
  renderer.setSize = vi.fn();
  renderer.getPixelRatio = vi.fn(() => 1);
  renderer.setPixelRatio = vi.fn();

  const camera = new THREE.PerspectiveCamera(50, 1.6, 0.1, 500);
  camera.position.set(12, 8, 12);
  camera.lookAt(0, 1, 0);

  const engine = Object.create(ViewerEngine.prototype) as ViewerEngine & Record<string, unknown>;
  Object.assign(engine, {
    renderer,
    rendererBackend: "webgl",
    adaptiveRenderScaleController: new AdaptiveRenderScaleController(1),
    framePerformanceMonitor: { reset: vi.fn() },
    resetPerformanceSamples: vi.fn(),
    container: { clientWidth: 1200, clientHeight: 600 },
    camera,
    orbit: { target: new THREE.Vector3(1, 2, 3) },
    scene: { background: new THREE.Color(0x112233) },
    navigationSettings: { eyeHeight: 1.7 },
    animationFrame: 0,
    drawingBufferInitialized: true,
    lastViewportWidth: 1200,
    lastViewportHeight: 600,
    xrRig: new THREE.Group(),
    xrControllers: [],
    xrSnapTurnReady: true,
    xrExitPressed: false,
    xrStartPending: false,
    xrActive: false,
    animate: vi.fn(),
    onXRSessionChange: vi.fn(),
  });
  return { engine, renderer, xr, camera };
}

function stubXrEnvironment(options: { secure?: boolean; isSessionSupported?: (mode: string) => Promise<boolean>; requestSession?: (mode: string) => Promise<unknown> } = {}) {
  vi.stubGlobal("window", { devicePixelRatio: 1, isSecureContext: options.secure ?? true });
  const xrApi = {
    isSessionSupported: options.isSessionSupported ?? vi.fn(async () => true),
    requestSession: options.requestSession ?? vi.fn(async () => ({ addEventListener: vi.fn(), end: vi.fn(async () => undefined) })),
  };
  vi.stubGlobal("navigator", { xr: xrApi });
  return xrApi;
}

beforeEach(() => {
  vi.stubGlobal("window", { devicePixelRatio: 1, isSecureContext: true });
  // Node 测试环境没有 rAF；startXR 会取消普通循环并把渲染交给 XRSession rAF。
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("XR entry gate messages", () => {
  it("tiers static blocks: backend first, then secure context, then WebXR API", () => {
    expect(describeXrEntryBlock({ secureContext: true, webxrApi: true, authorBackend: "webgl" })).toBeUndefined();
    expect(describeXrEntryBlock({ secureContext: true, webxrApi: true, authorBackend: "webgpu" })).toContain("仅 Three WebGL 渲染后端支持");
    expect(describeXrEntryBlock({ secureContext: false, webxrApi: true, authorBackend: "webgl" })).toContain("HTTPS");
    expect(describeXrEntryBlock({ secureContext: true, webxrApi: false, authorBackend: "webgl" })).toContain("navigator.xr");
    // 后端原因优先于环境原因，避免用户去改一个不相干的条件。
    expect(describeXrEntryBlock({ secureContext: false, webxrApi: false, authorBackend: "webgpu" })).toContain("仅 Three WebGL");
  });

  it("maps requestSession DOMException names to precise causes", () => {
    const denied = describeXrSessionRequestFailure(new DOMException("denied", "NotAllowedError"), "immersive-vr");
    expect(denied).toContain("权限");
    expect(describeXrSessionRequestFailure(new DOMException("sec", "SecurityError"), "immersive-vr")).toContain("安全策略");
    expect(describeXrSessionRequestFailure(new DOMException("ns", "NotSupportedError"), "immersive-ar")).toContain("不支持");
    expect(describeXrSessionRequestFailure(new Error("boom"), "immersive-ar")).toContain("boom");
  });

  it("marks setup failures as recovered", () => {
    expect(describeXrSessionSetupFailure(new Error("gpu gone"), "immersive-vr")).toContain("已恢复编辑器视图");
    expect(describeXrSessionSetupFailure(new Error("gpu gone"), "immersive-vr")).toContain("gpu gone");
  });
});

describe("XR session entry", () => {
  it("throws tiered reasons without requesting a session", async () => {
    vi.stubGlobal("window", { devicePixelRatio: 1, isSecureContext: true });
    vi.stubGlobal("navigator", {});
    const { engine } = createEngineStub();
    await expect(engine.startXR("immersive-vr")).rejects.toThrow("navigator.xr");
    expect(engine["xrActive"]).toBe(false);

    vi.stubGlobal("window", { devicePixelRatio: 1, isSecureContext: false });
    const xrApi = stubXrEnvironment({ secure: false });
    await expect(engine.startXR("immersive-vr")).rejects.toThrow("HTTPS");
    expect(xrApi.requestSession).not.toHaveBeenCalled();

    const xrApi2 = stubXrEnvironment({ isSessionSupported: async () => false });
    await expect(engine.startXR("immersive-vr")).rejects.toThrow("当前设备不支持 VR");
    expect((xrApi2.requestSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("maps a permission-denied requestSession failure to the permission tier", async () => {
    const requestSession = vi.fn((_mode: string) => Promise.reject(new DOMException("user denied", "NotAllowedError")));
    stubXrEnvironment({ requestSession: (mode) => requestSession(mode) });
    const { engine } = createEngineStub();
    await expect(engine.startXR("immersive-vr")).rejects.toThrow("权限");
    expect(requestSession).toHaveBeenCalledOnce();
    expect(engine["xrActive"]).toBe(false);
    expect(engine["onXRSessionChange"]).not.toHaveBeenCalled();
  });

  it("rolls the editor view back when renderer XR wiring fails after the session starts", async () => {
    const { engine, renderer, camera } = createEngineStub({ setSessionError: new Error("framebuffer rejected") });
    stubXrEnvironment();
    const savedPosition = camera.position.clone();

    await expect(engine.startXR("immersive-vr")).rejects.toThrow("已恢复编辑器视图");

    expect(engine["xrActive"]).toBe(false);
    expect(engine["xrSession"]).toBeUndefined();
    expect(engine["xrMode"]).toBeUndefined();
    expect(renderer.xr.enabled).toBe(false);
    expect(renderer.setAnimationLoop).toHaveBeenCalledWith(null);
    expect(camera.position.equals(savedPosition)).toBe(true);
    expect(engine["onXRSessionChange"]).toHaveBeenCalledWith(undefined);
    expect(engine["xrStartPending"]).toBe(false);
  });

  it("rejects a second concurrent entry while the first request is still in flight", async () => {
    let releaseRequest: ((session: unknown) => void) | undefined;
    const sessionPromise = new Promise((resolve) => { releaseRequest = (value) => resolve(value); });
    const requestSession = vi.fn((_mode: string) => sessionPromise);
    stubXrEnvironment({ requestSession: (mode) => requestSession(mode) });
    const { engine } = createEngineStub();

    const first = engine.startXR("immersive-vr");
    const second = await engine.startXR("immersive-vr");
    expect(second).toBe(false);

    releaseRequest!({ addEventListener: vi.fn(), end: vi.fn(async () => undefined) });
    await expect(first).resolves.toBe(true);
    expect(requestSession).toHaveBeenCalledOnce();
  });

  it("restores the editor when the device ends the session unexpectedly", async () => {
    let endListener: ((event: { currentTarget?: unknown }) => void) | undefined;
    const session = {
      addEventListener: vi.fn((type: string, listener: (event: { currentTarget?: unknown }) => void) => {
        if (type === "end") endListener = listener;
      }),
      end: vi.fn(async () => undefined),
    };
    stubXrEnvironment({ requestSession: async () => session });
    const { engine, renderer, camera } = createEngineStub();
    const savedPosition = camera.position.clone();

    await expect(engine.startXR("immersive-vr")).resolves.toBe(true);
    expect(endListener).toBeTypeOf("function");

    // 头显摘下 / 系统退出：仅 end 事件，引擎未主动调用 endXR。
    endListener!({ currentTarget: session });
    await Promise.resolve();
    await Promise.resolve();

    expect(engine["xrActive"]).toBe(false);
    expect(engine["xrSession"]).toBeUndefined();
    expect(renderer.xr.enabled).toBe(false);
    expect(camera.position.equals(savedPosition)).toBe(true);
    expect(engine["onXRSessionChange"]).toHaveBeenLastCalledWith(undefined);
    // 渲染循环交还给窗口 rAF。
    expect(engine["animate"]).toHaveBeenCalled();
  });

  it("ends a lingering XR session when the engine is disposed", () => {
    const { engine, renderer } = createEngineStub();
    const end = vi.fn(async () => undefined);
    const controller = new THREE.Group();
    Object.assign(engine, {
      xrActive: true,
      xrSession: { end },
      xrMode: "immersive-vr",
      xrControllers: [controller],
      disposeObject: vi.fn(),
    });

    (engine as unknown as { teardownXRSessionOnDispose(): void }).teardownXRSessionOnDispose();

    expect(renderer.setAnimationLoop).toHaveBeenCalledWith(null);
    expect(renderer.xr.enabled).toBe(false);
    expect(end).toHaveBeenCalledOnce();
    expect(engine["xrActive"]).toBe(false);
    expect(engine["xrSession"]).toBeUndefined();
    expect(engine["xrMode"]).toBeUndefined();
    expect(engine["xrControllers"]).toHaveLength(0);
  });
});
