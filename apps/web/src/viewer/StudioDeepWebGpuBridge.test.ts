import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepWebGpuSyncResult } from "@bim-studio/deep-engine/three-bridge";
import type { RenderPacket } from "@bim-studio/deep-engine";
import type { ViewerEngine } from "./ViewerEngine";
import { b4HlodClusterEnabled, g1ClusterLodEnabled, StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import type { PresentationPerformanceSource } from "./viewerPresentationPerformance";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import { readStudioFrameCaptureSnapshot, setStudioFrameCaptureRequested } from "./studioFrameCaptureDiagnostics";

type BridgeModule = typeof import("@bim-studio/deep-engine/three-bridge");
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// 本组仅验证宿主生命周期；真实 GPU/packet 验收由 Deep 引擎测试负责。
function makeBackend() {
  const deviceLoss = deferred<{ message: string; reason: string }>();
  const queueDone = vi.fn(() => Promise.resolve());
  return {
    deviceLoss, queueDone,
    // Legacy test backends model the Three projection path. The independent
    // packet path is covered by the creation contract test above; keeping an
    // explicit projection marker here prevents those lifecycle tests from
    // accidentally taking the packet fast path.
    projection: {},
    prepareScene: vi.fn().mockResolvedValue({ frame: 1 }),
    sync: vi.fn<() => Promise<DeepWebGpuSyncResult>>().mockResolvedValue(syncResult()),
    render: vi.fn((_view: unknown) => ({ frame: 1 })),
    setProbeClipmapEnabled: vi.fn(),
    dispose: vi.fn(),
    runtime: { session: { state: "ready", device: { lost: deviceLoss.promise,
      queue: { onSubmittedWorkDone: queueDone } } }, validateFrame: vi.fn().mockResolvedValue({ frame: 1 }) },
  };
}

function syncResult(): DeepWebGpuSyncResult {
  return { status: "committed", update: "instances", packet: {} } as DeepWebGpuSyncResult;
}

describe("B4 cluster HLOD opt-in switch", () => {
  const originalLocation = globalThis.location;
  const setSearch = (search: string): void => {
    Object.defineProperty(globalThis, "location", { configurable: true,
      value: { href: `http://localhost/${search}`, search } });
  };
  afterEach(() => {
    if (originalLocation === undefined) delete (globalThis as { location?: Location }).location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
  });
  it("defaults to off and only 1/true/on enable the cluster decision path", () => {
    setSearch(""); expect(b4HlodClusterEnabled()).toBe(false);
    setSearch("?b4-hlod-cluster=0"); expect(b4HlodClusterEnabled()).toBe(false);
    setSearch("?other=1"); expect(b4HlodClusterEnabled()).toBe(false);
    setSearch("?b4-hlod-cluster=1"); expect(b4HlodClusterEnabled()).toBe(true);
    setSearch("?b4-hlod-cluster=true"); expect(b4HlodClusterEnabled()).toBe(true);
    setSearch("?b4-hlod-cluster=on"); expect(b4HlodClusterEnabled()).toBe(true);
    setSearch("?b4-hlod-cluster=yes"); expect(b4HlodClusterEnabled()).toBe(false);
  });
});

describe("G1 cluster LOD opt-in switch", () => {
  const originalLocation = globalThis.location;
  const setSearch = (search: string): void => {
    Object.defineProperty(globalThis, "location", { configurable: true,
      value: { href: `http://localhost/${search}`, search } });
  };
  afterEach(() => {
    if (originalLocation === undefined) delete (globalThis as { location?: Location }).location;
    else Object.defineProperty(globalThis, "location", { configurable: true, value: originalLocation });
  });
  it("defaults to off and only 1/true/on enable the cluster LOD staging path", () => {
    setSearch(""); expect(g1ClusterLodEnabled()).toBe(false);
    setSearch("?g1-cluster-lod=0"); expect(g1ClusterLodEnabled()).toBe(false);
    setSearch("?b4-hlod-cluster=1"); expect(g1ClusterLodEnabled()).toBe(false);
    setSearch("?g1-cluster-lod=1"); expect(g1ClusterLodEnabled()).toBe(true);
    setSearch("?g1-cluster-lod=true"); expect(g1ClusterLodEnabled()).toBe(true);
    setSearch("?g1-cluster-lod=on"); expect(g1ClusterLodEnabled()).toBe(true);
    setSearch("?g1-cluster-lod=yes"); expect(g1ClusterLodEnabled()).toBe(false);
  });
});

describe("Studio Deep WebGPU bridge lifecycle", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let bridges: StudioDeepWebGpuBridge[];
  let authorFrames: Set<() => void>;

  beforeEach(() => {
    frames = new Map();
    nextFrameId = 0;
    bridges = [];
    authorFrames = new Set();
    vi.stubGlobal("navigator", { gpu: {} });
    vi.stubGlobal("document", { createElement: () => canvas(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrameId, callback);
      return nextFrameId;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  });

  afterEach(() => {
    for (const bridge of bridges) bridge.dispose();
    setStudioFrameCaptureRequested(false);
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function canvas() {
    return {
      style: { position: "relative", inset: "", width: "640px", height: "480px",
        opacity: "0.9", zIndex: "2", pointerEvents: "auto" },
      dataset: {}, clientWidth: 640, clientHeight: 480,
      setAttribute: vi.fn(), remove: vi.fn(),
    };
  }

  async function microtasks() {
    for (let turn = 0; turn < 16; turn++) await Promise.resolve();
  }

  async function frame(notifyAuthor = true) {
    const scheduled = [...frames.values()];
    frames.clear();
    for (const callback of scheduled) callback(16);
    await microtasks();
    if (notifyAuthor) for (const callback of [...authorFrames]) callback();
    await microtasks();
  }

  function setup(load?: () => Promise<BridgeModule>, authorRenderPacket?: () => Promise<RenderPacket>) {
    const first = makeBackend();
    const second = makeBackend();
    const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const module = {
      DeepWebGpuBackend: { create },
      ThreeProjectionBridge: class {},
      threeRenderView: (value: unknown) => value,
    } as unknown as BridgeModule;
    const authorCanvas = canvas();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#123456");
    const camera = new THREE.PerspectiveCamera();
    const presentation = vi.fn();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((callback: () => void) => {
      authorFrames.add(callback);
      return () => { authorFrames.delete(callback); unsubscribe(); };
    });
    const viewer = {
      scene, camera, orbit: { target: new THREE.Vector3() },
      renderer: { domElement: authorCanvas, getPixelRatio: () => 1, toneMappingExposure: 1,
        toneMapping: THREE.ACESFilmicToneMapping },
      usesAuthorPostProcessing: () => true,
      getPostProcessing: vi.fn(() => ({ ...DEFAULT_POST_PROCESSING, enabled: false })),
      getDeepProjectionRoot: () => scene,
      getDeepEditorOverlayRoots: () => [],
      getDeepSelectionBox: () => undefined,
      getDeepTransformGizmoInput: () => undefined,
      getDeepMeasurementSegmentInputs: () => [],
      setPresentationRendererBackend: presentation,
      setAuthorPacketIndependent: vi.fn(),
      setPresentationPerformanceSource: vi.fn(),
      subscribePresentationFrames: subscribe,
    } as unknown as ViewerEngine;
    const container = { append: vi.fn(), clientWidth: 640, clientHeight: 480 };
    const failure = vi.fn();
    const bridge = new StudioDeepWebGpuBridge(viewer, container as unknown as HTMLElement, {
      loadModule: load ?? (() => Promise.resolve(module)), onRuntimeFailure: failure,
      ...(authorRenderPacket ? { authorRenderPacket: () => authorRenderPacket() } : {}),
    });
    bridges.push(bridge);
    return { bridge, first, second, create, module, authorCanvas, container, presentation, failure, subscribe, unsubscribe, scene, camera, viewer };
  }

  async function activate(bridge: StudioDeepWebGpuBridge) {
    const operation = bridge.switchTo("webgpu");
    await microtasks();
    await frame();
    expect(await operation).toMatchObject({ status: "switched", activeBackend: "webgpu" });
    for (let settle = 0; settle < 17; settle++) await frame(false);
  }

  function recoverySetup() {
    const fixture = setup();
    let notification!: () => void;
    Object.assign(fixture.first, { onDeviceRecreated: (listener: (epoch: number) => void) => {
      notification = () => listener(1); return vi.fn();
    } });
    return { ...fixture, recover: () => notification() };
  }

  it("replaces the complete recovered host and ignores a repeated old epoch notification", async () => {
    const { bridge, first, second, create, recover, authorCanvas } = recoverySetup();
    await activate(bridge); first.render.mockClear();
    recover();
    expect(bridge.activeBackend).toBe("webgl"); expect(authorCanvas.style.opacity).toBe("1");
    expect(first.dispose).toHaveBeenCalledOnce(); expect(first.render).not.toHaveBeenCalled();
    recover(); await microtasks(); await frame(false); await frame(false);
    expect(create).toHaveBeenCalledTimes(2); expect(bridge.activeBackend).toBe("webgpu");
    expect(second.prepareScene).toHaveBeenCalledOnce(); expect(second.dispose).not.toHaveBeenCalled();
    expect(authorCanvas.style.opacity).toBe("0");
  });

  it("keeps the author frame and reports once when the complete recovery candidate fails", async () => {
    const { bridge, first, second, recover, authorCanvas, failure } = recoverySetup();
    await activate(bridge); second.prepareScene.mockRejectedValueOnce(new Error("replacement upload failed"));
    recover(); await microtasks(); await frame(false); await frame(false); await microtasks();
    expect(bridge.activeBackend).toBe("webgl"); expect(authorCanvas.style.opacity).toBe("1");
    expect(first.dispose).toHaveBeenCalledOnce(); expect(second.dispose).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledOnce(); recover(); await microtasks(); expect(failure).toHaveBeenCalledOnce();
  });

  it.each(["cancel", "dispose"] as const)("retires a late recovery candidate after %s", async mode => {
    const { bridge, first, second, recover, authorCanvas, failure } = recoverySetup();
    await activate(bridge);
    const validation = deferred<{ frame: number }>(); second.prepareScene.mockReturnValueOnce(validation.promise);
    recover(); await microtasks(); await frame(false);
    expect(second.prepareScene).toHaveBeenCalledOnce();
    if (mode === "cancel") bridge.cancelPendingSwitch(); else bridge.dispose();
    validation.resolve({ frame: 2 }); await microtasks(); await frame(false); await microtasks();
    expect(bridge.activeBackend).toBe("webgl"); expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
    expect(authorCanvas.style.opacity).toBe(mode === "dispose" ? "0.9" : "1");
  });

  it("honors a pending user WebGL handover when an epoch notification arrives", async () => {
    const { bridge, first, create, recover, authorCanvas, failure } = recoverySetup();
    await activate(bridge);
    const switching = bridge.switchTo("webgl"); recover();
    await microtasks(); await frame(false);
    expect(await switching).toMatchObject({ status: "cancelled", activeBackend: "webgl" });
    expect(create).toHaveBeenCalledOnce(); expect(first.dispose).toHaveBeenCalledOnce();
    expect(authorCanvas.style.opacity).toBe("1"); expect(failure).not.toHaveBeenCalled();
  });

  it("rebuilds once with the advancedMaterials variant instead of failing the scene when a late lobe is rejected", async () => {
    const { bridge, first, second, create, authorCanvas, failure } = setup();
    await activate(bridge);
    expect(create.mock.calls[0]![0].renderer.advancedMaterials).toBeUndefined();
    const rejection = new Error("$.materials[0]: Three projection does not support MeshPhysicalMaterial non-neutral extensions.");
    (bridge as unknown as { failRuntime(reason: unknown): void }).failRuntime(rejection);
    // 受控重建:先回到作者(three)画布,不上报失败。
    expect(bridge.activeBackend).toBe("webgl"); expect(authorCanvas.style.opacity).toBe("1");
    expect(first.dispose).toHaveBeenCalledOnce(); expect(failure).not.toHaveBeenCalled();
    await microtasks(); await frame(false); await frame(false); await microtasks();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0].renderer.advancedMaterials).toBe(true);
    expect(bridge.activeBackend).toBe("webgpu"); expect(second.dispose).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
    // 变体已启用后同一拒绝不再重建,走原失败路径(无重建环)。
    (bridge as unknown as { failRuntime(reason: unknown): void }).failRuntime(rejection);
    await microtasks();
    expect(create).toHaveBeenCalledTimes(2); expect(failure).toHaveBeenCalledOnce(); expect(bridge.activeBackend).toBe("webgl");
  });

  it("does not rebuild for unrelated runtime failures", async () => {
    const { bridge, create, failure } = setup();
    await activate(bridge);
    (bridge as unknown as { failRuntime(reason: unknown): void }).failRuntime(new Error("Deep WebGPU device was lost."));
    await microtasks();
    expect(create).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce(); expect(bridge.activeBackend).toBe("webgl");
  });
  it("allocates author frame capture only for an explicitly opened diagnostics session", async () => {
    const regular = setup();
    await activate(regular.bridge);
    expect(regular.create.mock.calls[0]![0].renderer.frameCapture).toBeUndefined();
    expect(readStudioFrameCaptureSnapshot().available).toBe(false);

    setStudioFrameCaptureRequested(true);
    const diagnostic = setup();
    await activate(diagnostic.bridge);
    expect(diagnostic.create.mock.calls[0]![0].renderer.frameCapture?.session).toBeDefined();
    expect(readStudioFrameCaptureSnapshot().available).toBe(true);
    diagnostic.bridge.dispose();
    expect(readStudioFrameCaptureSnapshot().available).toBe(false);
  });

  it("passes a precompiled author packet to Deep without a Three fallback root", async () => {
    const packet = { geometries: [], materials: [], instances: [] } as unknown as RenderPacket;
    const provider = vi.fn(async () => packet);
    const f = setup(undefined, provider);
    const sceneMatrixUpdate = vi.spyOn(f.scene, "updateMatrixWorld");
    await activate(f.bridge);
    expect(provider).toHaveBeenCalledOnce();
    expect(f.create.mock.calls[0]![0].renderPacket).toBe(packet);
    expect(f.create.mock.calls[0]![0].root).toBeUndefined();
    expect(f.create.mock.calls[0]![0].projection).toBeUndefined();
    expect(sceneMatrixUpdate).not.toHaveBeenCalled();
  });

  it("renders immutable author packets without a settled-frame Three sync", async () => {
    const packet = { geometries: [], materials: [], instances: [] } as unknown as RenderPacket;
    const f = setup(undefined, async () => packet);
    await activate(f.bridge);
    // The test factory uses a plain lifecycle double; mark it as the backend
    // shape produced by DeepWebGpuBackend.create({ renderPacket }).
    (f.first as unknown as { projection?: unknown }).projection = undefined;
    f.first.sync.mockClear();
    f.first.render.mockClear();
    for (const notify of authorFrames) notify();
    await microtasks();
    expect(f.first.sync).not.toHaveBeenCalled();
    expect(f.first.render).toHaveBeenCalled();
  });

  it("establishes performance samples from submitted Deep frames through temporal settling", async () => {
    const f = setup();
    await activate(f.bridge);
    const bind = vi.mocked(f.viewer.setPresentationPerformanceSource);
    const source = bind.mock.calls.at(-1)![0] as PresentationPerformanceSource;
    source.reset();
    for (const notify of authorFrames) notify();
    await microtasks();
    for (let index = 0; index < 20; index++) {
      const scheduled = [...frames.values()]; frames.clear();
      scheduled.forEach(callback => callback(index * 16));
      await microtasks();
    }
    expect(source.snapshot().sampleCount).toBeGreaterThan(2);
    expect(source.snapshot().renderer.backend).toBe("webgpu");
    expect(source.snapshot().fps).toBeGreaterThan(55);
    expect(source.snapshot().fps).toBeLessThanOrEqual(62.5);
  });

  it("enables author chunk staging and renders its captured demand camera without advancing author state", async () => {
    const f = setup(); await activate(f.bridge);
    expect(f.create.mock.calls[0]![0].authorChunks).toBe(true);
    f.first.sync.mockClear(); f.first.render.mockClear();
    for (const notify of authorFrames) notify();
    await microtasks();
    const args = f.first.sync.mock.calls[0] as unknown as unknown[];
    expect(args[3]).toMatchObject({ width: 640, height: 480 });
    expect(f.first.render.mock.calls[0]![0]).toBe(args[3]);
    expect(f.first.render.mock.calls.at(-1)![0]).toBe(args[3]);
    expect(f.bridge.activeBackend).toBe("webgpu");
  });

  it("renders camera-only frames without scene sync and performs one trailing correctness sync", async () => {
    const f = setup(); await activate(f.bridge);
    f.first.sync.mockClear(); f.first.render.mockClear();
    const matrixUpdate = vi.spyOn(f.scene, "updateMatrixWorld");
    f.scene.updateMatrixWorld(); matrixUpdate.mockClear();
    f.camera.position.x = 2;
    for (const notify of authorFrames) notify();
    await microtasks();
    expect(matrixUpdate).not.toHaveBeenCalled();
    expect(f.first.sync).not.toHaveBeenCalled();
    expect(f.first.render).toHaveBeenCalledTimes(1);
    expect(f.first.render.mock.calls[0]![0]).toMatchObject({ eye: [2, 0, 0] });

    const edited = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    f.scene.add(edited);
    await new Promise(resolve => setTimeout(resolve, 90));
    await microtasks();
    expect(f.first.sync).toHaveBeenCalledTimes(1);
    expect((f.first.sync.mock.calls[0] as unknown as unknown[])[0]).toBe(f.scene);
    edited.geometry.dispose(); edited.material.dispose();
  });

  it("keeps gesture camera frames out of the temporal settle sequence until input rests", async () => {
    const f = setup(); await activate(f.bridge);
    f.first.sync.mockClear(); f.first.render.mockClear();
    // 手势相机帧 settle=false:呈现一次,不重启 TAA 收敛重绘(拖拽期一帧一提交)。
    f.camera.position.x = 1;
    for (const notify of authorFrames) notify();
    await microtasks();
    expect(f.first.render).toHaveBeenCalledTimes(1);
    expect(f.first.sync).not.toHaveBeenCalled();
    // 后续浏览器帧零收敛重绘、零 sync:手势帧没有重启 settler(残余 rAF 是
    // 性能采样回调,不是收敛序列)。
    for (let idle = 0; idle < 3; idle++) await frame(false);
    expect(f.first.render).toHaveBeenCalledTimes(1);
    expect(f.first.sync).not.toHaveBeenCalled();
    // 输入静止 → 80ms 尾随 sync:上传完成的那一帧才呈现,并启动有界收敛序列。
    await new Promise(resolve => setTimeout(resolve, 90));
    await microtasks();
    expect(f.first.sync).toHaveBeenCalledTimes(1);
    const settledView = f.first.render.mock.calls.at(-1)![0];
    const rendersBeforeSettle = f.first.render.mock.calls.length;
    for (let settle = 0; settle < 17; settle++) await frame(false);
    expect(f.first.render).toHaveBeenCalledTimes(rendersBeforeSettle + 16);
    expect(f.first.render.mock.calls.at(-1)![0]).toBe(settledView);
    await frame(false);
    expect(f.first.render).toHaveBeenCalledTimes(rendersBeforeSettle + 16);
    expect(frames.size).toBe(0);
  });

  it("submits the latest camera on every author frame, releasing the in-flight slot on submit", async () => {
    const f = setup(); await activate(f.bridge);
    // GPU 完成回调挂起:相机帧的呈现节奏必须跟随作者帧,而不是 vsync 级的
    // queue.onSubmittedWorkDone(Chrome 实测滞后 2-3 帧,会让提交限流到每 2 帧
    // 一次)。提交即释放名额,每个作者帧都呈现当时最新的相机。
    const fence = deferred<void>();
    f.first.queueDone.mockReset().mockReturnValue(fence.promise);
    f.first.render.mockClear();
    for (let x = 1; x <= 5; x++) {
      f.camera.position.x = x;
      for (const notify of authorFrames) notify();
      await microtasks();
    }
    expect(f.first.render).toHaveBeenCalledTimes(5);
    expect(f.first.render.mock.calls.at(-1)![0]).toMatchObject({ eye: [5, 0, 0] });
    expect(f.bridge.diagnostics?.cameraFlow).toMatchObject({ inFlight: 0, maxInFlight: 1,
      submitted: 5, coalesced: 0, pendingLatest: false, limit: 2 });
  });

  it("tracks the authored GI switch through the published Deep backend lifecycle", async () => {
    const f = setup();
    let enabled = true;
    f.viewer.getGlobalLighting = () => ({ enabled: true, globalIlluminationEnabled: enabled }) as never;
    await activate(f.bridge);
    expect(f.create.mock.calls[0]![0].renderer.probeClipmap).toBeUndefined();
    expect(f.first.setProbeClipmapEnabled).toHaveBeenCalledWith(true);
    enabled = false;
    for (const notify of authorFrames) notify();
    await microtasks();
    expect(f.first.setProbeClipmapEnabled).toHaveBeenLastCalledWith(false);
    f.bridge.dispose();
    expect(f.first.dispose).toHaveBeenCalledOnce();
  });
});
