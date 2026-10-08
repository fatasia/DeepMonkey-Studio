import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepWebGpuSyncResult } from "@bim-studio/deep-engine/three-bridge";
import type { RenderPacket } from "@bim-studio/deep-engine";
import type { ViewerEngine } from "./ViewerEngine";
import { b4HlodClusterEnabled, g1ClusterLodEnabled, StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import type { PresentationPerformanceSource } from "./viewerPresentationPerformance";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import { readStudioFrameCaptureSnapshot, setStudioFrameCaptureRequested } from "./studioFrameCaptureDiagnostics";
import { renderViewFingerprint } from "./studioDeepWebGpuBridgeSceneHelpers";
import { resolvePbrMsaaSampleCount } from "../../../../packages/deep-engine/src/webgpu/renderTargets";
import { DeepCameraController } from "./deepCameraController";

type BridgeModule = typeof import("@bim-studio/deep-engine/three-bridge");
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void };

it("invalidates a static camera frame when the author display domain changes", () => {
  type View = Parameters<typeof renderViewFingerprint>[0];
  const view: View = { eye: [1, 2, 3], target: [0, 0, 0], width: 800, height: 600, pixelRatio: 1,
    extent: 10, background: [0.1, 0.2, 0.3], floor: [0.2, 0.2, 0.2], exposure: 1, roughness: 0.5 };
  expect(renderViewFingerprint(view)).not.toBe(renderViewFingerprint({ ...view, authorDirectDisplay: true }));
});

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

  function setup(load?: () => Promise<BridgeModule>, authorRenderPacket?: () => Promise<RenderPacket>, authorPacketKey?: () => string) {
    const first = makeBackend();
    const second = makeBackend();
    const create = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    // AA-M2 能力门测试用:记录每次 ThreeProjectionBridge 构造参数(投影路径才构造)。
    const projectionOptions: Array<{ capabilities?: Record<string, unknown> }> = [];
    const module = {
      DeepWebGpuBackend: { create },
      ThreeProjectionBridge: class { constructor(options: { capabilities?: Record<string, unknown> }) { projectionOptions.push(options); } },
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
      ...(authorPacketKey ? { authorPacketKey } : {}),
    });
    bridges.push(bridge);
    return { bridge, first, second, create, module, authorCanvas, container, presentation, failure, subscribe, unsubscribe, scene, camera, viewer, projectionOptions };
  }

  async function activate(bridge: StudioDeepWebGpuBridge) {
    const operation = bridge.switchTo("webgpu");
    await microtasks();
    await frame();
    expect(await operation).toMatchObject({ status: "switched", activeBackend: "webgpu" });
    for (let settle = 0; settle < 17; settle++) await frame(false);
  }

  it("reuses one parked packet renderer after a fresh GPU frame admission", async () => {
    const packet = { geometries: [], materials: [], instances: [] } as RenderPacket;
    const f = setup(undefined, async () => packet), validate = vi.fn().mockResolvedValue({ frame: 1 });
    Object.assign(f.first, { usesIndependentPacket: true, prepareView: validate });
    Object.assign(f.first.runtime.session, { resourceMemory: { estimatedBytes: 1024, unknownResources: 0 } });
    Object.assign(f.viewer, { getRenderDemandDiagnostics: () => ({ invalidationRevision: 1 }) });
    const released = deferred<void>(), trim = vi.fn();
    Object.assign(f.first.runtime, { gpuTimer: { releaseIdleResources: () => released.promise }, releaseIdleResources: trim });
    await activate(f.bridge);
    const park = f.bridge.switchTo("webgl"); await frame();
    expect(trim).not.toHaveBeenCalled(); released.resolve(); await park;
    expect(trim).toHaveBeenCalledOnce();
    expect(f.first.dispose).not.toHaveBeenCalled(); expect(f.authorCanvas.style.opacity).toBe("1");
    const resume = f.bridge.switchTo("webgpu"); await microtasks(); await frame();
    expect(await resume).toMatchObject({ status: "switched", activeBackend: "webgpu" });
    expect(f.create).toHaveBeenCalledOnce();
    expect(validate.mock.calls.at(-1)?.[2]).toBe(true);
    f.bridge.dispose(); expect(f.first.dispose).toHaveBeenCalledOnce();
  });

  it("applies immediate pan on an author frame even when spherical damping has settled", async () => {
    const f = setup(); await activate(f.bridge);
    f.camera.position.set(7, 2, 3); f.viewer.orbit.target.set(4, 0, 0);
    const controller = new DeepCameraController(); controller.setPose([7, 2, 3], [4, 0, 0]);
    Object.assign(f.bridge, { controller, gestureActive: true, lastAppliedPose: controller.getPose() });
    f.viewer.getCameraState = () => ({ position: f.camera.position, target: f.viewer.orbit.target, mode: "orbit" }) as never;
    f.viewer.applyViewportCameraPose = pose => {
      f.camera.position.fromArray(pose.eye); f.viewer.orbit.target.fromArray(pose.target);
    };
    controller.pan(20, 10, 480); await frame();
    expect(f.camera.position.toArray()).not.toEqual([7, 2, 3]);
    expect(f.viewer.orbit.target.toArray()).not.toEqual([4, 0, 0]);
  });

  it("prewarms a hidden candidate without changing the author, then admits it without GPU creation", async () => {
    const packet = { geometries: [], materials: [], instances: [] } as RenderPacket;
    const f = setup(undefined, async () => packet, () => "scene");
    Object.assign(f.first, { usesIndependentPacket: true, prepareView: vi.fn().mockResolvedValue({ frame: 1 }) });
    const memory = { estimatedBytes: 1024, unknownResources: 1 };
    const drain = vi.fn(async () => { memory.unknownResources = 0; });
    Object.assign(f.first.runtime.session, { resourceMemory: memory });
    Object.assign(f.first.runtime, { gpuTimer: { releaseIdleResources: drain } });
    Object.assign(f.viewer, { getRenderDemandDiagnostics: () => ({ invalidationRevision: 1 }) });
    const warm = f.bridge.prewarm(new AbortController().signal); await microtasks(); await frame();
    expect(await warm).toMatchObject({ status: "switched", activeBackend: "webgl" });
    expect(f.presentation).not.toHaveBeenCalled();
    expect(f.viewer.setAuthorPacketIndependent).not.toHaveBeenCalledWith(true);
    expect(f.first.dispose).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledOnce();
    await activate(f.bridge); expect(f.create).toHaveBeenCalledOnce();
  });

  it.each([
    [312_465_992, 0, true], [384 * 1024 * 1024, 0, true],
    [384 * 1024 * 1024 + 1, 0, false], [312_465_992, 1, false],
  ])("uses the bounded parking contract for %s bytes / %s unknown resources", async (bytes, unknownResources, retained) => {
    const packet = { geometries: [], materials: [], instances: [] } as RenderPacket;
    const f = setup(undefined, async () => packet);
    Object.assign(f.first, { usesIndependentPacket: true, prepareView: vi.fn().mockResolvedValue({ frame: 1 }) });
    Object.assign(f.first.runtime.session, { resourceMemory: { estimatedBytes: bytes, unknownResources } });
    Object.assign(f.viewer, { getRenderDemandDiagnostics: () => ({ invalidationRevision: 1 }) });
    await activate(f.bridge); const park = f.bridge.switchTo("webgl"); await frame(); await park;
    expect(f.first.dispose).toHaveBeenCalledTimes(retained ? 0 : 1);
    await activate(f.bridge);
    expect(f.create).toHaveBeenCalledTimes(retained ? 1 : 2);
    f.bridge.dispose(); expect(f.first.dispose).toHaveBeenCalledOnce();
  });

  it("retires the parked GPU owner on device loss before a new switch", async () => {
    const packet = { geometries: [], materials: [], instances: [] } as RenderPacket;
    const f = setup(undefined, async () => packet); let revision = 1;
    Object.assign(f.first, { usesIndependentPacket: true, prepareView: vi.fn().mockResolvedValue({ frame: 1 }) });
    Object.assign(f.first.runtime.session, { resourceMemory: { estimatedBytes: 1024, unknownResources: 0 } });
    Object.assign(f.viewer, { getRenderDemandDiagnostics: () => ({ invalidationRevision: revision }) });
    await activate(f.bridge); const park = f.bridge.switchTo("webgl"); await frame(); await park;
    f.first.deviceLoss.resolve({ reason: "unknown", message: "lost" }); await microtasks();
    expect(f.first.dispose).toHaveBeenCalledOnce();
    await activate(f.bridge); expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("still retires the current parked owner on loss after previous parking subscriptions were transferred", async () => {
    const packet = { geometries: [], materials: [], instances: [] } as RenderPacket;
    const f = setup(undefined, async () => packet);
    Object.assign(f.first, { usesIndependentPacket: true, prepareView: vi.fn().mockResolvedValue({ frame: 1 }) });
    Object.assign(f.first.runtime.session, { resourceMemory: { estimatedBytes: 1024, unknownResources: 0 } });
    Object.assign(f.viewer, { getRenderDemandDiagnostics: () => ({ invalidationRevision: 1 }) });
    await activate(f.bridge);
    for (let cycle = 0; cycle < 3; cycle++) {
      const park = f.bridge.switchTo("webgl"); await frame(); await park;
      await activate(f.bridge);
      expect(f.first.dispose).not.toHaveBeenCalled();
    }
    expect(f.create).toHaveBeenCalledOnce();
    const finalPark = f.bridge.switchTo("webgl"); await frame(); await finalPark;
    f.first.deviceLoss.resolve({ reason: "unknown", message: "device lost after warm transfers" });
    await microtasks();
    expect(f.first.dispose).toHaveBeenCalledOnce();
    await activate(f.bridge);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.second.dispose).not.toHaveBeenCalled();
  });

  it("updates a parked device after semantic edits without rebuilding or publishing in the background", async () => {
    let packet = { geometries: [], materials: [], instances: [] } as RenderPacket;
    let key = "author-v1", revision = 1;
    const f = setup(undefined, async () => packet, () => key);
    const update = vi.fn().mockResolvedValue({ frame: 2 });
    Object.assign(f.first, { usesIndependentPacket: true, prepareView: vi.fn().mockResolvedValue({ frame: 1 }), prepareRenderPacket: update });
    Object.assign(f.first.runtime.session, { resourceMemory: { estimatedBytes: 1024, unknownResources: 0 } });
    Object.assign(f.viewer, { getRenderDemandDiagnostics: () => ({ invalidationRevision: revision }) });
    await activate(f.bridge); const park = f.bridge.switchTo("webgl"); await frame(); await park;
    revision++; await frame(); expect(f.first.dispose).not.toHaveBeenCalled();
    key = "author-v2"; packet = { ...packet }; revision++; await frame();
    expect(f.first.dispose).not.toHaveBeenCalled();
    f.presentation.mockClear(); vi.mocked(f.viewer.setAuthorPacketIndependent).mockClear();
    const warm = f.bridge.prewarm(new AbortController().signal); await microtasks(); await frame();
    expect(await warm).toMatchObject({ status: "switched", activeBackend: "webgl" });
    expect(update).toHaveBeenCalledOnce(); expect(update.mock.calls[0]?.[0]).toBe(packet);
    expect(f.presentation).not.toHaveBeenCalled();
    expect(f.viewer.setAuthorPacketIndependent).not.toHaveBeenCalledWith(true);
    await activate(f.bridge); expect(f.create).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledOnce(); expect(f.first.dispose).not.toHaveBeenCalled();
  });

  it.each(["advanced", "coverage"])("rebuilds a parked renderer only when the edited packet needs new %s capabilities", async kind => {
    let packet = { geometries: [], materials: [], instances: [] } as RenderPacket, key = "v1";
    const f = setup(undefined, async () => packet, () => key);
    Object.assign(f.first, { usesIndependentPacket: true, prepareView: vi.fn().mockResolvedValue({ frame: 1 }) });
    Object.assign(f.first.runtime.session, { resourceMemory: { estimatedBytes: 1024, unknownResources: 0 } });
    await activate(f.bridge); const park = f.bridge.switchTo("webgl"); await frame(); await park;
    packet = { ...packet, materials: [{ id: "m", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      ...(kind === "advanced" ? { specularFactor: 0.5 } : { alphaToCoverage: true }) }] };
    key = "v2"; await activate(f.bridge);
    expect(f.first.dispose).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledTimes(2);
    const renderer = f.create.mock.calls[1]?.[0]?.renderer;
    expect(kind === "advanced" ? renderer.advancedMaterials : renderer.msaaSampleCount).toBe(kind === "advanced" ? true : 4);
  });

  it("releases a parked candidate when compiling the edited snapshot fails", async () => {
    const packet = { geometries: [], materials: [], instances: [] } as RenderPacket;
    let broken = false;
    const f = setup(undefined, async () => { if (broken) throw Error("invalid snapshot"); return packet; });
    Object.assign(f.first, { usesIndependentPacket: true, prepareView: vi.fn().mockResolvedValue({ frame: 1 }) });
    Object.assign(f.first.runtime.session, { resourceMemory: { estimatedBytes: 1024, unknownResources: 0 } });
    await activate(f.bridge); const park = f.bridge.switchTo("webgl"); await frame(); await park;
    broken = true;
    expect(await f.bridge.switchTo("webgpu")).toMatchObject({ status: "failed", activeBackend: "webgl", error: "invalid snapshot" });
    expect(f.first.dispose).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce();
  });

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

  it("resolves the opaque author's creation request to existing MSAA4 without enabling a2c", async () => {
    const f = setup();
    const solid = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    f.scene.add(solid);
    await activate(f.bridge);
    expect(f.create.mock.calls[0]![0].renderer.msaaSampleCount).toBeUndefined();
    expect(resolvePbrMsaaSampleCount(f.create.mock.calls[0]![0].renderer.msaaSampleCount)).toBe(4);
    expect(f.projectionOptions[0]?.capabilities?.alphaToCoverage).toBeUndefined();
    solid.geometry.dispose(); (solid.material as THREE.Material).dispose();
  });

  it.each([false, true])("preserves the Studio no-TAA contract in the actual candidate with composer %s", async enabled => {
    const f = setup();
    vi.mocked(f.viewer.getPostProcessing).mockReturnValue({ ...DEFAULT_POST_PROCESSING, enabled,
      smaa: true, gtao: true, bloom: true });
    await activate(f.bridge);
    const request = f.create.mock.calls[0]![0];
    expect(request.renderer.features.temporalAa).toBe(false);
    expect(request.renderer.features.contactShadows).toBe(false);
    expect(resolvePbrMsaaSampleCount(request.renderer.msaaSampleCount)).toBe(4);
    expect(request.view.postProcess.bloom).toBe(enabled);
    expect(request.view.postProcess.ambientOcclusion).toBe(enabled);
  });

  it("keeps MSAA4 in direct author display for an opaque independent packet", async () => {
    const packet = { geometries: [], materials: [{ id: "solid", alphaMode: "OPAQUE" }], instances: [] } as unknown as RenderPacket;
    const f = setup(undefined, async () => packet);
    Object.assign(f.viewer, { usesAuthorPostProcessing: () => false });
    await activate(f.bridge);
    expect(f.create.mock.calls[0]![0].view).toMatchObject({ authorDirectDisplay: true });
    expect(resolvePbrMsaaSampleCount(f.create.mock.calls[0]![0].renderer.msaaSampleCount)).toBe(4);
    expect(f.projectionOptions).toHaveLength(0);
  });

  it("declares the a2c capability gate and pins MSAA4 when the scene requests alpha-to-coverage", async () => {
    const f = setup();
    const flagged = new THREE.Mesh(new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ alphaToCoverage: true }));
    f.scene.add(flagged);
    await activate(f.bridge);
    expect(f.projectionOptions[0]?.capabilities?.alphaToCoverage).toBe(true);
    expect(f.create.mock.calls[0]![0].renderer.msaaSampleCount).toBe(4);
    flagged.geometry.dispose(); (flagged.material as THREE.Material).dispose();
  });

  it("declares the a2c capability gate from a precompiled author packet", async () => {
    const packet = { geometries: [], materials: [{ id: "a2c", alphaToCoverage: true }], instances: [] } as unknown as RenderPacket;
    const f = setup(undefined, async () => packet);
    await activate(f.bridge);
    // 独立包路径不构造投影桥,能力经渲染器 MSAA4 主 pass 与包材质位生效。
    expect(f.create.mock.calls[0]![0].renderer.msaaSampleCount).toBe(4);
    expect(f.projectionOptions).toHaveLength(0);
  });

  it("rebuilds once with the a2c capability gate instead of failing the scene when a late material is rejected", async () => {
    const f = setup();
    await activate(f.bridge);
    expect(f.create.mock.calls[0]![0].renderer.msaaSampleCount).toBeUndefined();
    const rejection = new Error("$.materials[0]: Three projection does not support material alphaToCoverage.");
    (f.bridge as unknown as { failRuntime(reason: unknown): void }).failRuntime(rejection);
    expect(f.bridge.activeBackend).toBe("webgl"); expect(f.authorCanvas.style.opacity).toBe("1");
    expect(f.first.dispose).toHaveBeenCalledOnce(); expect(f.failure).not.toHaveBeenCalled();
    await microtasks(); await frame(false); await frame(false); await microtasks();
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.create.mock.calls[1]![0].renderer.msaaSampleCount).toBe(4);
    expect(f.projectionOptions[1]?.capabilities?.alphaToCoverage).toBe(true);
    expect(f.bridge.activeBackend).toBe("webgpu"); expect(f.second.dispose).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled();
    // 变体已声明后同一拒绝不再重建,走原失败路径(无重建环)。
    (f.bridge as unknown as { failRuntime(reason: unknown): void }).failRuntime(rejection);
    await microtasks();
    expect(f.create).toHaveBeenCalledTimes(2); expect(f.failure).toHaveBeenCalledOnce(); expect(f.bridge.activeBackend).toBe("webgl");
  });

  it("fails without rebuild for the semantically-undefined a2c+transparent rejection", async () => {
    const f = setup();
    await activate(f.bridge);
    (f.bridge as unknown as { failRuntime(reason: unknown): void }).failRuntime(
      new Error("Three projection does not support material alphaToCoverage with transparent."));
    await microtasks();
    expect(f.create).toHaveBeenCalledOnce(); expect(f.failure).toHaveBeenCalledOnce(); expect(f.bridge.activeBackend).toBe("webgl");
  });

  it("rebuilds once with the mask-fallback capability when the renderer probe reports a2c ineffective", async () => {
    const f = setup();
    const flagged = new THREE.Mesh(new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial({ alphaToCoverage: true }));
    f.scene.add(flagged);
    await activate(f.bridge);
    expect(f.projectionOptions[0]?.capabilities?.alphaToCoverage).toBe(true);
    // A2C-P1:渲染器探针只披露(FrameMetrics.a2cProbe,读回异步结算后滞后披露),降级决策在桥。
    f.first.render.mockImplementation(() => ({ frame: 2, a2cProbe: { frame: 1, verdict: "ineffective",
      alphaNonOpaquePixels: 7000, edgePixels: 636, edgeDitherThreshold: 4096 } }));
    // frame():作者帧回调驱动的完整绘制路径(settle 静置后 frame(false) 无新绘制)。
    await frame();
    await new Promise(resolve => setTimeout(resolve, 0));
    await microtasks(); await frame(false); await frame(false); await microtasks();
    expect(f.create).toHaveBeenCalledTimes(2);
    // 降级档:a2c 能力门关闭(材质投影失去 a2c 语义),改投 maskFallback(MASK@cutoff);
    // MSAA 回缺省——重建后材质不再请求 a2c,渲染器探针也不会再进入测量。
    expect(f.projectionOptions[1]?.capabilities?.alphaToCoverage).toBeUndefined();
    expect(f.projectionOptions[1]?.capabilities?.alphaToCoverageMaskFallback).toBe(true);
    expect(f.create.mock.calls[1]![0].renderer.msaaSampleCount).toBeUndefined();
    expect(f.bridge.activeBackend).toBe("webgpu");
    expect(f.second.dispose).not.toHaveBeenCalled(); expect(f.failure).not.toHaveBeenCalled();
    // 粘性:降级后再次收到无效披露不再重触发(一次性,无重建环)。
    f.second.render.mockImplementation(() => ({ frame: 3, a2cProbe: { frame: 2, verdict: "ineffective",
      alphaNonOpaquePixels: 7000, edgePixels: 636, edgeDitherThreshold: 4096 } }));
    await frame();
    await new Promise(resolve => setTimeout(resolve, 0));
    await microtasks();
    expect(f.create).toHaveBeenCalledTimes(2);
    flagged.geometry.dispose(); (flagged.material as THREE.Material).dispose();
  });

  it("does not trigger the mask-fallback rebuild for inconclusive or effective probe disclosures", async () => {
    const f = setup();
    await activate(f.bridge);
    f.first.render.mockImplementation(() => ({ frame: 2, a2cProbe: { frame: 1, verdict: "inconclusive",
      alphaNonOpaquePixels: 0, edgePixels: 0, edgeDitherThreshold: 4096 } }));
    await frame(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    await microtasks();
    expect(f.create).toHaveBeenCalledOnce();
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

  it("allows temporal convergence to finish across unchanged author notifications", async () => {
    const packet = { geometries: [], materials: [], instances: [] } as RenderPacket;
    const f = setup(undefined, async () => packet);
    let revision = 1;
    f.viewer.getRenderDemandDiagnostics = () => ({ invalidationRevision: revision, intrinsicActive: false }) as ReturnType<ViewerEngine["getRenderDemandDiagnostics"]>;
    await activate(f.bridge);
    (f.first as unknown as { projection?: unknown }).projection = undefined;
    f.first.render.mockClear();
    f.scene.background = new THREE.Color("#234567");
    revision++;
    for (const notify of authorFrames) notify();
    await microtasks();
    for (let index = 0; index < 20; index++) await frame();
    expect(f.first.render.mock.calls.length).toBeGreaterThan(10);
    const completed = f.first.render.mock.calls.length;
    for (let index = 0; index < 4; index++) await frame();
    expect(f.first.render).toHaveBeenCalledTimes(completed);
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

  it("refreshes authored lighting during a continuous camera gesture when scene revision changes", async () => {
    const f = setup(); let revision = 1;
    Object.assign(f.viewer, { getRenderDemandDiagnostics: () => ({ invalidationRevision: revision }) });
    const light = new THREE.AmbientLight(0xffffff, 1); light.name = "authored-ambient"; f.scene.add(light);
    await activate(f.bridge); f.first.render.mockClear();
    f.camera.position.x = 1; for (const notify of authorFrames) notify(); await microtasks();
    const firstView = f.first.render.mock.calls.at(-1)![0] as Parameters<typeof renderViewFingerprint>[0];
    expect(firstView.lights?.ambient?.[0]?.intensity).toBe(1);
    light.intensity = 3; revision++; f.camera.position.x = 2;
    for (const notify of authorFrames) notify(); await microtasks();
    const latest = f.first.render.mock.calls.at(-1)![0] as Parameters<typeof renderViewFingerprint>[0];
    expect(latest.eye[0]).toBe(2); expect(latest.lights?.ambient?.[0]?.intensity).toBe(3);
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

  it("bounds a thousand camera inputs while GPU completion is pending and replays the newest pose", async () => {
    const f = setup(); await activate(f.bridge);
    const fence = deferred<void>();
    f.first.queueDone.mockReset().mockReturnValue(fence.promise);
    f.first.render.mockClear();
    for (let x = 1; x <= 1000; x++) {
      f.camera.position.x = x;
      for (const notify of authorFrames) notify();
      await microtasks();
    }
    expect(f.first.render).toHaveBeenCalledTimes(2);
    expect(f.bridge.diagnostics?.cameraFlow).toMatchObject({ inFlight: 2, maxInFlight: 2,
      coalesced: 998, pendingLatest: true, limit: 2 });
    fence.resolve(); await microtasks();
    expect(f.first.render).toHaveBeenCalledTimes(3);
    expect(f.first.render.mock.calls.at(-1)![0]).toMatchObject({ eye: [1000, 0, 0] });
    expect(f.bridge.diagnostics?.cameraFlow).toMatchObject({ inFlight: 0, pendingLatest: false });
  });

  it("discards a pending camera view when its backend is switched away", async () => {
    const f = setup(); await activate(f.bridge);
    const completion = deferred<void>(); f.first.queueDone.mockReturnValue(completion.promise);
    f.first.render.mockClear();
    for (let x = 1; x <= 3; x++) { f.camera.position.x = x; for (const notify of authorFrames) notify(); await microtasks(); }
    expect(f.first.render).toHaveBeenCalledTimes(2);
    const switching = f.bridge.switchTo("webgl"); await frame(); await switching;
    completion.resolve(); await microtasks();
    expect(f.first.render).toHaveBeenCalledTimes(2); expect(f.bridge.activeBackend).toBe("webgl");
  });

  it("returns to the author renderer once when pending camera completion rejects", async () => {
    const f = setup(); await activate(f.bridge);
    const completion = deferred<void>(); f.first.queueDone.mockReturnValue(completion.promise);
    for (let x = 1; x <= 3; x++) { f.camera.position.x = x; for (const notify of authorFrames) notify(); await microtasks(); }
    completion.reject(new Error("GPU queue lost")); await microtasks();
    expect(f.failure).toHaveBeenCalledOnce(); expect(f.bridge.activeBackend).toBe("webgl");
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
