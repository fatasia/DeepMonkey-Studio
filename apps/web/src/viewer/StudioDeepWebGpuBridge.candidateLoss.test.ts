import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepWebGpuSyncResult } from "@bim-studio/deep-engine/three-bridge";
import type { RenderPacket } from "@bim-studio/deep-engine";
import type { ViewerEngine } from "./ViewerEngine";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import { recoveredAttemptCount } from "./studioRecoveryCandidate";
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
describe("Studio recovery candidate before publication", () => {
  it("counts only the current recovery segment including its successful request", () => {
    const backend = { runtime: { session: { recoveryEvents: [
      { type: "classified", code: "device-lost/unknown" }, { type: "attempt" }, { type: "recovered" },
      { type: "classified", code: "uncaptured/out-of-memory" }, { type: "attempt" }, { type: "attempt" }, { type: "recovered" },
    ] } } };
    expect(recoveredAttemptCount(backend)).toBe(3);
    expect(recoveredAttemptCount({ runtime: {} })).toBe(1);
  });
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
      recovery: {},
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

  function candidateLoss(f: ReturnType<typeof recoverySetup>, error = new Error("Renderer is not ready."), delayed = false) {
    let candidateRecovered: (() => void) | undefined;
    Object.assign(f.second, { onDeviceRecreated: (listener: (epoch: number) => void) => {
      candidateRecovered = () => listener(2); return vi.fn();
    } });
    f.second.prepareScene.mockImplementationOnce(async () => {
      f.second.deviceLoss.resolve({ reason: "unknown", message: "registered synthetic unknown" });
      await Promise.resolve();
      if (!delayed) candidateRecovered?.();
      throw error;
    });
    return () => candidateRecovered?.();
  }

  it("replaces a candidate lost before publication within the remaining host budget", async () => {
    const f = recoverySetup(), third = makeBackend();
    f.create.mockResolvedValueOnce(third);
    candidateLoss(f);
    await activate(f.bridge);
    f.recover();
    for (let index = 0; index < 5; index++) await frame(false);
    expect(f.create).toHaveBeenCalledTimes(3);
    expect(f.bridge.activeBackend).toBe("webgpu");
    expect(f.second.dispose).toHaveBeenCalledOnce();
    expect(third.dispose).not.toHaveBeenCalled();
    expect(f.failure).not.toHaveBeenCalled();
    expect(f.create.mock.calls[1]![0].renderer.recovery.maxAttempts).toBe(2);
    expect(f.create.mock.calls[2]![0].renderer.recovery.maxAttempts).toBe(1);
  });

  it("does not retry an unrelated validation error even with a candidate unknown notification", async () => {
    const f = recoverySetup();
    candidateLoss(f, new Error("authored packet validation failed"));
    await activate(f.bridge); f.recover();
    for (let index = 0; index < 4; index++) await frame(false);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.bridge.activeBackend).toBe("webgl");
    expect(f.second.dispose).toHaveBeenCalledOnce();
    expect(f.failure).toHaveBeenCalledOnce();
    expect(f.failure.mock.calls[0]![0].message).toBe("authored packet validation failed");
  });

  it.each(["cancel", "webgl", "dispose"] as const)("cancels a candidate recovery wait through %s", async mode => {
    const f = recoverySetup(), late = candidateLoss(f, undefined, true);
    await activate(f.bridge); f.recover();
    for (let index = 0; index < 3; index++) await frame(false);
    await microtasks();
    expect(f.second.prepareScene).toHaveBeenCalledOnce();
    if (mode === "cancel") f.bridge.cancelPendingSwitch();
    else if (mode === "webgl") await f.bridge.switchTo("webgl");
    else f.bridge.dispose();
    late();
    for (let index = 0; index < 3; index++) await frame(false);
    expect(f.bridge.activeBackend).toBe("webgl");
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.second.dispose).toHaveBeenCalledOnce();
    expect(f.failure).not.toHaveBeenCalled();
  });
});
