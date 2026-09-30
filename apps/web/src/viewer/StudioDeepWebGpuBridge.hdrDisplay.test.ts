import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepWebGpuSyncResult } from "@bim-studio/deep-engine/three-bridge";
import type { HdrDisplayRequest } from "@bim-studio/deep-engine/webgpu";
import type { ViewerEngine } from "./ViewerEngine";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";

type BridgeModule = typeof import("@bim-studio/deep-engine/three-bridge");

// I-C21:Studio → engine 的 HDR 显示请求透传面。只验证宿主请求/快照/诊断合同,
// 真实 GPU 探测与呈现由 deep-engine 测试与两 fresh 真机步骤负责。
function makeBackend(withHdrRuntime?: Record<string, unknown>) {
  const deviceLoss = { promise: new Promise<{ message: string; reason: string }>(() => {}) };
  return {
    deviceLoss,
    projection: {},
    prepareScene: vi.fn().mockResolvedValue({ frame: 1 }),
    sync: vi.fn<() => Promise<DeepWebGpuSyncResult>>().mockResolvedValue(
      { status: "committed", update: "instances", packet: {} } as DeepWebGpuSyncResult),
    render: vi.fn(() => ({ frame: 1 })),
    setProbeClipmapEnabled: vi.fn(),
    dispose: vi.fn(),
    runtime: { ...withHdrRuntime, session: { state: "ready", device: { lost: deviceLoss.promise,
      queue: { onSubmittedWorkDone: () => Promise.resolve() } } }, validateFrame: vi.fn().mockResolvedValue({ frame: 1 }) },
  };
}

describe("Studio Deep WebGPU bridge HDR display request contract", () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrameId: number;
  let bridges: StudioDeepWebGpuBridge[];

  beforeEach(() => {
    frames = new Map();
    nextFrameId = 0;
    bridges = [];
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

  async function frame() {
    const scheduled = [...frames.values()];
    frames.clear();
    for (const callback of scheduled) callback(16);
    await microtasks();
  }

  function setup(request?: HdrDisplayRequest, backends?: ReturnType<typeof makeBackend>[]) {
    const created = backends ?? [makeBackend()];
    const create = vi.fn();
    for (const backend of created) create.mockResolvedValueOnce(backend);
    const module = {
      DeepWebGpuBackend: { create },
      ThreeProjectionBridge: class {},
      threeRenderView: (value: unknown) => value,
    } as unknown as BridgeModule;
    const authorCanvas = canvas();
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#123456");
    const camera = new THREE.PerspectiveCamera();
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
      setPresentationRendererBackend: vi.fn(),
      setAuthorPacketIndependent: vi.fn(),
      setPresentationPerformanceSource: vi.fn(),
      subscribePresentationFrames: vi.fn(() => () => {}),
    } as unknown as ViewerEngine;
    const container = { append: vi.fn(), clientWidth: 640, clientHeight: 480 };
    const bridge = new StudioDeepWebGpuBridge(viewer, container as unknown as HTMLElement, {
      loadModule: () => Promise.resolve(module),
      ...(request === undefined ? {} : { hdrDisplay: request }),
    });
    bridges.push(bridge);
    return { bridge, create, viewer, scene, camera };
  }

  async function activate(bridge: StudioDeepWebGpuBridge) {
    const operation = bridge.switchTo("webgpu");
    await microtasks();
    await frame();
    expect(await operation).toMatchObject({ status: "switched", activeBackend: "webgpu" });
  }

  it("does not attach an HDR request when the host keeps the SDR default", async () => {
    const f = setup();
    await activate(f.bridge);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.create.mock.calls[0]![0].renderer).not.toHaveProperty("hdrDisplay");
    expect(f.bridge.diagnostics).not.toHaveProperty("hdrDisplay");
  });

  it("passes an explicit request through as a construction-time frozen snapshot", async () => {
    // 宿主在异步模块加载窗口内改动请求对象:构造期快照必须不受影响。
    const request: { enabled: true; pqPeakNits?: number; strategy?: "extended-linear" | "pq-2020" } = { enabled: true, pqPeakNits: 1600 };
    const f = setup(request);
    const operation = f.bridge.switchTo("webgpu");
    await microtasks();
    request.pqPeakNits = 1;
    (request as { strategy?: string }).strategy = "pq-2020";
    await frame();
    expect(await operation).toMatchObject({ status: "switched" });
    expect(f.create.mock.calls[0]![0].renderer.hdrDisplay).toEqual({ enabled: true, pqPeakNits: 1600 });
  });

  it("replays the same frozen request snapshot on every switch instead of re-reading the host object", async () => {
    const request: HdrDisplayRequest = { enabled: true };
    const f = setup(request, [makeBackend(), makeBackend(), makeBackend()]);
    await activate(f.bridge);
    const fallback = f.bridge.switchTo("webgl");
    await frame();
    expect(await fallback).toMatchObject({ status: "switched", activeBackend: "webgl" });
    const again = f.bridge.switchTo("webgpu");
    await microtasks();
    await frame();
    expect(await again).toMatchObject({ status: "switched", activeBackend: "webgpu" });
    expect(f.create).toHaveBeenCalledTimes(2);
    const first = f.create.mock.calls[0]![0].renderer.hdrDisplay as HdrDisplayRequest;
    const third = f.create.mock.calls[1]![0].renderer.hdrDisplay as HdrDisplayRequest;
    expect(third).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("surfaces the negotiated HDR runtime through bridge diagnostics", async () => {
    const hdrRuntime = { state: "active",
      policy: { mode: "hdr", strategy: "extended-linear", failClosed: false, reason: "hdr-active" },
      canvasFormat: "rgba16float" };
    const f = setup({ enabled: true }, [makeBackend({ hdrDisplay: hdrRuntime })]);
    await activate(f.bridge);
    expect(f.bridge.diagnostics?.hdrDisplay).toEqual(hdrRuntime);
    expect(f.bridge.diagnostics?.cameraFlow).toMatchObject({ limit: 2 });
  });
});
