import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ViewerEngine } from "./ViewerEngine";
import { AdaptiveRenderScaleController } from "./adaptiveRenderScale";

describe("XR session lifecycle", () => {
  beforeEach(() => { vi.stubGlobal("window", { devicePixelRatio: 1 }); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it("clears the XR state when end resolves even if the browser end event is missed", async () => {
    const session = { end: vi.fn(async () => undefined) } as unknown as XRSession;
    const renderer = Object.create(THREE.WebGLRenderer.prototype) as THREE.WebGLRenderer;
    Object.defineProperty(renderer, "xr", {
      value: { enabled: true, getSession: () => session, setSession: vi.fn(async () => undefined) },
      configurable: true
    });
    renderer.setAnimationLoop = vi.fn();
    renderer.setSize = vi.fn();
    renderer.getPixelRatio = vi.fn(() => 1);

    const camera = new THREE.PerspectiveCamera();

    const engine = Object.create(ViewerEngine.prototype) as ViewerEngine & Record<string, unknown>;
    Object.assign(engine, {
      renderer,
      adaptiveRenderScaleController: new AdaptiveRenderScaleController(1),
      camera,
      container: { clientWidth: 1200, clientHeight: 600 },
      xrSession: session,
      xrActive: true,
      xrMode: "immersive-vr",
      xrControllers: [],
      xrRig: { position: { set: vi.fn() }, rotation: { set: vi.fn() } },
      scene: { background: null },
      animate: vi.fn(),
      onXRSessionChange: vi.fn()
    });

    await engine.endXR();

    expect(session.end).toHaveBeenCalledOnce();
    expect(engine["xrActive"]).toBe(false);
    expect(engine.onXRSessionChange).toHaveBeenCalledWith(undefined);
  });

  it("restores the editor camera projection and viewport after XR exits", async () => {
    const session = { end: vi.fn(async () => undefined) } as unknown as XRSession;
    const renderer = Object.create(THREE.WebGLRenderer.prototype) as THREE.WebGLRenderer;
    const setSession = vi.fn(async () => undefined);
    Object.defineProperty(renderer, "xr", {
      value: { enabled: true, getSession: () => session, setSession },
      configurable: true
    });
    renderer.setAnimationLoop = vi.fn();
    renderer.setSize = vi.fn();
    renderer.getPixelRatio = vi.fn(() => 1);
    renderer.setPixelRatio = vi.fn();

    const camera = new THREE.PerspectiveCamera(94, 0.5, 0.25, 800);
    camera.zoom = 1;
    camera.position.set(0, 0, 0);
    camera.quaternion.identity();
    camera.projectionMatrix.set(
      2, 0, 0, 0,
      0, 3, 0, 0,
      0, 0, -1, -1,
      0, 0, -0.2, 0
    );
    const savedPosition = new THREE.Vector3(12, 8, 12);
    const savedQuaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.4, 0.7, 0));
    const savedScale = new THREE.Vector3(1, 1, 1);
    const savedUp = new THREE.Vector3(0, 1, 0);
    const savedTarget = new THREE.Vector3(1, 2, 3);
    const postProcessing = { setSize: vi.fn(), setPixelRatio: vi.fn() };
    // XR 期间窗口移到不同 DPI 显示器，退出时恢复当前显示器像素比。
    vi.stubGlobal("window", { devicePixelRatio: 1.5 });

    const engine = Object.create(ViewerEngine.prototype) as ViewerEngine & Record<string, unknown>;
    Object.assign(engine, {
      renderer,
      rendererBackend: "webgl",
      adaptiveRenderScaleController: new AdaptiveRenderScaleController(1),
      framePerformanceMonitor: { reset: vi.fn() },
      postProcessing,
      container: { clientWidth: 1200, clientHeight: 600 },
      camera,
      xrSession: session,
      xrActive: true,
      xrMode: "immersive-vr",
      orbit: { target: new THREE.Vector3(40, 50, 60) },
      xrSavedCamera: {
        position: savedPosition,
        quaternion: savedQuaternion,
        scale: savedScale,
        up: savedUp,
        target: savedTarget,
        fov: 50,
        zoom: 1.5,
        near: 0.1,
        far: 2_000
      },
      xrControllers: [],
      xrRig: { position: { set: vi.fn() }, rotation: { set: vi.fn() } },
      scene: { background: null },
      animate: vi.fn(),
      onXRSessionChange: vi.fn()
    });

    await engine.endXR();

    expect(camera.position).toEqual(savedPosition);
    expect(camera.quaternion.angleTo(savedQuaternion)).toBeCloseTo(0);
    expect(camera.fov).toBe(50);
    expect(camera.zoom).toBe(1.5);
    expect(camera.near).toBe(0.1);
    expect(camera.far).toBe(2_000);
    expect((engine["orbit"] as { target: THREE.Vector3 }).target).toEqual(savedTarget);
    expect(camera.aspect).toBe(2);
    expect(renderer.setSize).toHaveBeenCalledWith(1200, 600, false);
    expect(postProcessing.setSize).toHaveBeenCalledWith(1200, 600);
    expect(renderer.setPixelRatio).toHaveBeenCalledWith(1.5);
    expect(postProcessing.setPixelRatio).toHaveBeenCalledWith(1.5);
  });
});
