import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeepWebGpuSyncResult } from "@bim-studio/deep-engine/three-bridge";
import type { ViewerEngine } from "./ViewerEngine";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
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

  function setup(load?: () => Promise<BridgeModule>) {
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
      setPresentationPerformanceSource: vi.fn(),
      subscribePresentationFrames: subscribe,
    } as unknown as ViewerEngine;
    const container = { append: vi.fn(), clientWidth: 640, clientHeight: 480 };
    const failure = vi.fn();
    const bridge = new StudioDeepWebGpuBridge(viewer, container as unknown as HTMLElement, {
      loadModule: load ?? (() => Promise.resolve(module)), onRuntimeFailure: failure,
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

  it("merges pending camera replay into the next author frame instead of an immediate resubmit", async () => {
    const f = setup(); await activate(f.bridge);
    const fences = [deferred<void>(), deferred<void>(), deferred<void>()];
    f.first.queueDone.mockReset()
      .mockReturnValueOnce(fences[0]!.promise)
      .mockReturnValueOnce(fences[1]!.promise)
      .mockReturnValueOnce(fences[2]!.promise);
    f.first.render.mockClear();
    for (let x = 1; x <= 5; x++) {
      f.camera.position.x = x;
      for (const notify of authorFrames) notify();
      await microtasks();
    }
    expect(f.first.render).toHaveBeenCalledTimes(2);
    expect(f.bridge.diagnostics?.cameraFlow).toMatchObject({ inFlight: 2, maxInFlight: 2,
      submitted: 2, coalesced: 3, pendingLatest: true, limit: 2 });
    // GPU 完成回调只释放在飞名额:不再即时重放 pending,避免与作者帧提交相邻
    // 形成一帧双提交(拖尾主体)。
    fences[0]!.resolve(); await microtasks();
    expect(f.first.render).toHaveBeenCalledTimes(2);
    expect(f.bridge.diagnostics?.cameraFlow).toMatchObject({ inFlight: 1, maxInFlight: 2,
      submitted: 2, pendingLatest: true });
    // 下一作者帧以最新 view 一次提交,并清空补位缓存。
    f.camera.position.x = 6;
    for (const notify of authorFrames) notify();
    await microtasks();
    expect(f.first.render).toHaveBeenCalledTimes(3);
    expect(f.first.render.mock.calls.at(-1)![0]).toMatchObject({ eye: [6, 0, 0] });
    expect(f.bridge.diagnostics?.cameraFlow).toMatchObject({ inFlight: 2, maxInFlight: 2,
      submitted: 3, pendingLatest: false });
    fences[1]!.resolve(); fences[2]!.resolve(); await microtasks();
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

  async function replace(bridge: StudioDeepWebGpuBridge) {
    const fallback = bridge.switchTo("webgl");
    await frame();
    expect(await fallback).toMatchObject({ status: "switched", activeBackend: "webgl" });
    await activate(bridge);
  }

  it.each(["selection", "camera", "resize"])("does not replay an older %s view after delayed author synchronization", async change => {
    const f = setup(); await activate(f.bridge);
    const pending = deferred<DeepWebGpuSyncResult>();
    f.first.sync.mockReturnValueOnce(pending.promise);
    const selection = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.1, 0, -2), new THREE.Vector3(0.1, 0, -2),
    ]), new THREE.LineBasicMaterial({ depthTest: false, toneMapped: false }));
    let selected = true;
    f.viewer.getDeepEditorOverlayRoots = () => selected ? [selection] : [];
    // 发起 sync 的作者帧不再预画(一帧一提交),基线取 mockClear 前最后一笔。
    const baseline = f.first.render.mock.calls.at(-1)![0] as { editorOverlay: { revision: number } };
    f.first.render.mockClear();
    f.first.render.mockImplementation((input: unknown) => {
      const view = input as { editorOverlay: { revision: number } };
      if (view.editorOverlay.revision < baseline.editorOverlay.revision) throw new Error("Editor overlay revision went backwards.");
      return { frame: 1 };
    });
    for (const notify of authorFrames) notify();
    if (change === "selection") selected = false;
    else if (change === "camera") f.camera.position.x = 0.25;
    else f.container.clientHeight = 720;
    for (const notify of authorFrames) notify();
    const cleared = f.first.render.mock.calls.at(-1)![0] as { editorOverlay: { revision: number; vertices: Float32Array } };
    if (change === "selection") expect(cleared.editorOverlay.vertices).toHaveLength(0);
    expect(cleared.editorOverlay.revision).toBeGreaterThan(baseline.editorOverlay.revision);
    pending.resolve(syncResult()); await microtasks();
    for (let settle = 0; settle < 3; settle++) await frame(false);
    expect(f.failure).not.toHaveBeenCalled();
    expect(f.bridge.activeBackend).toBe("webgpu");
    expect(f.first.render.mock.calls.every(([input]) =>
      (input as typeof cleared).editorOverlay.revision >= cleared.editorOverlay.revision)).toBe(true);
    selection.geometry.dispose(); selection.material.dispose();
  });

  it("times out a stuck module and removes the candidate while keeping WebGL", async () => {
    vi.useFakeTimers();
    const loading = deferred<BridgeModule>();
    const { bridge, container, module, create } = setup(() => loading.promise);
    const operation = bridge.switchTo("webgpu");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await operation).toMatchObject({ status: "failed", activeBackend: "webgl", error: expect.stringContaining("timed out") });
    expect(container.append.mock.calls[0]![0].remove).toHaveBeenCalledOnce();
    loading.resolve(module);
    await microtasks();
    expect(create).not.toHaveBeenCalled();
  });

  it("catches up scene and camera edits made while creation is pending before publishing", async () => {
    const { bridge, first, create, scene, camera, authorCanvas, presentation } = setup();
    const creation = deferred<typeof first>();
    const validation = deferred<{ frame: number }>();
    create.mockReset().mockReturnValueOnce(creation.promise);
    first.prepareScene.mockReturnValueOnce(validation.promise);
    const operation = bridge.switchTo("webgpu");
    await microtasks();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
    scene.add(mesh);
    mesh.position.x = 12;
    camera.position.set(4, 5, 6);
    camera.layers.mask = 3;
    creation.resolve(first);
    await microtasks();
    await frame(false);
    expect(first.prepareScene).toHaveBeenCalledWith(scene,
      expect.objectContaining({ eye: [4, 5, 6] }), 3, expect.any(AbortSignal));
    expect(mesh.matrixWorld.elements[12]).toBe(12);
    expect(authorCanvas.style.opacity).toBe("1");
    expect(presentation).not.toHaveBeenCalled();
    validation.resolve({ frame: 2 });
    await microtasks();
    expect(await operation).toMatchObject({ status: "switched", activeBackend: "webgpu" });
    expect(authorCanvas.style.opacity).toBe("0");
    mesh.geometry.dispose();
    mesh.material.dispose();
  });

  it.each(["reject", "cancel", "timeout"] as const)("keeps WebGL and retires the candidate on catch-up %s", async (mode) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { bridge, first, authorCanvas, container, presentation } = setup();
    const validation = deferred<{ frame: number }>();
    first.prepareScene.mockReturnValueOnce(validation.promise);
    const operation = bridge.switchTo("webgpu");
    await microtasks();
    await frame(false);
    expect(first.prepareScene).toHaveBeenCalledOnce();
    if (mode === "reject") validation.reject(new Error("catch-up GPU validation failed"));
    else if (mode === "cancel") bridge.cancelPendingSwitch();
    else await vi.advanceTimersByTimeAsync(30_000);
    expect(await operation).toMatchObject({ status: mode === "cancel" ? "cancelled" : "failed", activeBackend: "webgl" });
    expect(authorCanvas.style.opacity).toBe("1");
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(container.append.mock.calls[0]![0].remove).toHaveBeenCalledOnce();
    expect(presentation).not.toHaveBeenCalled();
    expect(first.prepareScene.mock.calls[0]![3].aborted).toBe(true);
    validation.resolve({ frame: 2 });
    await microtasks();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(presentation).not.toHaveBeenCalled();
  });

  it("falls back on idle device loss without another author frame", async () => {
    const { bridge, first, failure, authorCanvas, unsubscribe } = setup();
    await activate(bridge);
    first.deviceLoss.resolve({ message: "GPU reset", reason: "unknown" });
    await microtasks();
    expect(bridge.activeBackend).toBe("webgl");
    expect(authorCanvas.style.opacity).toBe("1");
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]![0].message).toBe("GPU reset");
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("attempts all retirement steps and restores author presentation when unsubscribe and dispose throw", async () => {
    const { bridge, first, unsubscribe, authorCanvas, container, presentation } = setup();
    await activate(bridge);
    unsubscribe.mockImplementationOnce(() => { throw new Error("unsubscribe failed"); });
    first.dispose.mockImplementationOnce(() => { throw new Error("dispose failed"); });
    expect(() => bridge.dispose()).toThrow(AggregateError);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(container.append.mock.calls[0]![0].remove).toHaveBeenCalledOnce();
    expect(authorCanvas.style.opacity).toBe("0.9");
    expect(presentation).toHaveBeenLastCalledWith("webgl");
    expect(() => bridge.dispose()).not.toThrow();
  });

  it("reports device loss and cleanup errors after returning to WebGL", async () => {
    const { bridge, first, failure, unsubscribe, authorCanvas, container } = setup();
    await activate(bridge);
    unsubscribe.mockImplementationOnce(() => { throw new Error("unsubscribe failed"); });
    first.dispose.mockImplementationOnce(() => { throw new Error("dispose failed"); });
    first.deviceLoss.resolve({ message: "GPU reset", reason: "unknown" });
    await microtasks();
    expect(bridge.activeBackend).toBe("webgl");
    expect(authorCanvas.style.opacity).toBe("1");
    expect(container.append.mock.calls[0]![0].remove).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]![0]).toBeInstanceOf(AggregateError);
    expect(failure.mock.calls[0]![0].errors[0].message).toBe("GPU reset");
  });

  it("ignores device loss from a retired backend", async () => {
    const { bridge, first, second, failure } = setup();
    await activate(bridge);
    await replace(bridge);
    first.deviceLoss.resolve({ message: "retired", reason: "destroyed" });
    await microtasks();
    expect(bridge.activeBackend).toBe("webgpu");
    expect(second.dispose).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });

  it("settles a cancelled WebGL handover even when no browser frame arrives", async () => {
    const { bridge, first } = setup();
    await activate(bridge);
    const switching = bridge.switchTo("webgl");
    expect(frames.size).toBe(1);
    bridge.cancelPendingSwitch();
    expect(await switching).toMatchObject({ status: "cancelled", activeBackend: "webgpu" });
    expect(frames.size).toBe(0);
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it("does not sync or draw during idle browser frames without author demand", async () => {
    const { bridge, first } = setup();
    await activate(bridge);
    first.sync.mockClear();
    first.render.mockClear();

    for (let idle = 0; idle < 5; idle++) await frame(false);

    expect(first.sync).not.toHaveBeenCalled();
    expect(first.render).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });

  it("projects current author color effects on initial preparation, live edits and disable", async () => {
    const f = setup();
    const post = { ...DEFAULT_POST_PROCESSING, enabled: true, vignette: true, vignetteDarkness: 1.8,
      colorGrading: true, hue: 90, saturation: -0.2, brightness: 0.1, contrast: 0.3, ssao: true, bloom: true };
    vi.mocked(f.viewer.getPostProcessing).mockImplementation(() => ({ ...post }));
    await activate(f.bridge);
    const expected = { vignette: { darkness: 1.8 }, colorGrading: { hue: 90, saturation: -0.2,
      brightness: 0.1, contrast: 0.3 } };
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({ view: { authorColorEffects: expected } });
    expect(f.first.prepareScene.mock.calls[0]?.[1]).toMatchObject({ authorColorEffects: expected });
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({ view: { postProcess: { ambientOcclusion: true, bloom: true } } });
    expect(f.create.mock.calls[0]?.[0]).toMatchObject({ view: { postProcess: { authorBloom: {
      strength: post.bloomStrength, threshold: post.bloomThreshold } } } });
    const firstView = f.first.render.mock.calls.at(-1)?.[0];
    post.hue = -90; post.vignetteDarkness = 0; post.bloomStrength = 0; post.bloomThreshold = 0;
    await frame();
    expect(f.first.render.mock.calls.at(-1)?.[0]).toMatchObject({ authorColorEffects: {
      vignette: { darkness: 0 }, colorGrading: { hue: -90 } } });
    expect(firstView).toMatchObject({ authorColorEffects: expected });
    expect(f.first.render.mock.calls.at(-1)?.[0]).toMatchObject({ postProcess: { authorBloom: { strength: 0, threshold: 0 } } });
    post.enabled = false;
    await frame();
    expect(f.first.render.mock.calls.at(-1)?.[0]).toMatchObject({ authorColorEffects: {} });
    expect(f.first.render.mock.calls.at(-1)?.[0]).toMatchObject({ postProcess: { ambientOcclusion: false, bloom: false } });
  });

  it("starts one sync then finitely settles TAA without further author demand or uploads", async () => {
    const { bridge, first, subscribe } = setup();
    await activate(bridge);
    first.sync.mockClear();
    first.render.mockClear();

    await frame();

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(first.sync).toHaveBeenCalledTimes(1);
    expect(first.render).toHaveBeenCalled();
    // One finite TAA callback and one coalesced display-performance sample; neither loops after settling.
    expect(frames.size).toBe(2);
    const renders = first.render.mock.calls.length;
    const settledView = first.render.mock.calls.at(-1)?.[0];
    await frame(false);
    expect(first.render).toHaveBeenCalledTimes(renders);
    for (let settle = 0; settle < 16; settle++) await frame(false);
    expect(first.sync).toHaveBeenCalledTimes(1);
    expect(first.render).toHaveBeenCalledTimes(renders + 16);
    expect(first.render.mock.calls.at(-1)?.[0]).toBe(settledView);
    expect(frames.size).toBe(0);
    await frame(false);
    expect(first.render).toHaveBeenCalledTimes(renders + 16);
  });

  it("unsubscribes exactly once and ignores author notifications after teardown", async () => {
    const { bridge, first, unsubscribe } = setup();
    await activate(bridge);
    first.sync.mockClear();
    first.render.mockClear();

    bridge.dispose();
    bridge.dispose();
    await frame();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(authorFrames.size).toBe(0);
    expect(first.sync).not.toHaveBeenCalled();
    expect(first.render).not.toHaveBeenCalled();
  });

  it("coalesces notifications during an in-flight sync into one trailing sync even when the author sleeps", async () => {
    const { bridge, first } = setup();
    await activate(bridge);
    const pending = deferred<DeepWebGpuSyncResult>();
    first.sync.mockClear().mockReturnValueOnce(pending.promise);
    await frame();
    await frame();
    await frame();
    expect(first.sync).toHaveBeenCalledTimes(1);

    pending.resolve(syncResult());
    await microtasks();

    expect(first.sync).toHaveBeenCalledTimes(2);
    for (let settle = 0; settle < 17; settle++) await frame(false);
    const renders = first.render.mock.calls.length;
    await frame(false);
    await frame(false);
    expect(first.sync).toHaveBeenCalledTimes(2);
    expect(first.render).toHaveBeenCalledTimes(renders);
    expect(frames.size).toBe(0);
  });

  it("ignores a retired backend's late sync rejection after a new backend is published", async () => {
    const { bridge, first, second, failure, presentation } = setup();
    await activate(bridge);
    const oldSync = deferred<DeepWebGpuSyncResult>();
    first.sync.mockReturnValue(oldSync.promise);
    await frame();
    await replace(bridge);

    oldSync.reject(new Error("retired device validation failed"));
    await microtasks();

    expect(bridge.activeBackend).toBe("webgpu");
    expect(presentation).toHaveBeenLastCalledWith("webgpu");
    expect(second.dispose).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it("does not let an old sync finally unlock a newer backend's pending sync", async () => {
    const { bridge, first, second } = setup();
    await activate(bridge);
    const oldSync = deferred<DeepWebGpuSyncResult>();
    first.sync.mockReturnValue(oldSync.promise);
    await frame();
    await replace(bridge);
    const newSync = deferred<DeepWebGpuSyncResult>();
    second.sync.mockClear().mockReturnValue(newSync.promise);
    await frame();
    expect(second.sync).toHaveBeenCalledTimes(1);

    oldSync.resolve(syncResult());
    await microtasks();
    await frame();
    await frame();

    expect(second.sync).toHaveBeenCalledTimes(1);
    newSync.resolve(syncResult());
    await microtasks();
    expect(second.sync).toHaveBeenCalledTimes(2);
    await frame(false);
    expect(second.sync).toHaveBeenCalledTimes(2);
  });

  it("keeps Deep active when a same-backend request supersedes an unpublished WebGL switch", async () => {
    const { bridge, first, presentation } = setup();
    await activate(bridge);
    const obsoleteFallback = bridge.switchTo("webgl");
    expect(await bridge.switchTo("webgpu")).toMatchObject({ status: "unchanged", activeBackend: "webgpu" });
    await frame();

    expect(await obsoleteFallback).toMatchObject({ status: "cancelled", activeBackend: "webgpu" });
    expect(bridge.activeBackend).toBe("webgpu");
    expect(presentation).toHaveBeenLastCalledWith("webgpu");
    expect(first.dispose).not.toHaveBeenCalled();
  });

  it("restores the author canvas and WebGL presentation exactly once on dispose", async () => {
    const { bridge, first, authorCanvas, presentation, create } = setup();
    await activate(bridge);
    expect(authorCanvas.style.opacity).toBe("0");
    bridge.dispose();
    bridge.dispose();
    await frame();

    expect(bridge.activeBackend).toBe("webgl");
    expect(presentation).toHaveBeenLastCalledWith("webgl");
    expect(authorCanvas.style).toMatchObject({ position: "relative", opacity: "0.9", width: "640px", zIndex: "2" });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(await bridge.switchTo("webgpu")).toMatchObject({ status: "failed", activeBackend: "webgl" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it("explicit cancellation keeps the published Deep backend while WebGL waits for its frame", async () => {
    const { bridge, first, presentation, authorCanvas, failure } = setup();
    await activate(bridge);
    const operation = bridge.switchTo("webgl");
    bridge.cancelPendingSwitch();
    bridge.cancelPendingSwitch();
    await frame();

    expect(await operation).toMatchObject({ status: "cancelled", activeBackend: "webgpu" });
    expect(bridge.activeBackend).toBe("webgpu");
    expect(presentation).toHaveBeenLastCalledWith("webgpu");
    expect(authorCanvas.style.opacity).toBe("0");
    expect(first.dispose).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(first.render).toHaveBeenCalled();

    const retry = bridge.switchTo("webgl");
    await frame();
    expect(await retry).toMatchObject({ status: "switched", activeBackend: "webgl" });
    expect(first.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(["switch", "dispose", "explicit"] as const)("does not create GPU resources after module-load cancellation by %s", async (cancel) => {
    const loading = deferred<BridgeModule>();
    const { bridge, module, create, container, failure } = setup(() => loading.promise);
    const operation = bridge.switchTo("webgpu");
    await microtasks();
    expect(container.append).toHaveBeenCalledTimes(1);
    if (cancel === "dispose") bridge.dispose();
    else if (cancel === "explicit") bridge.cancelPendingSwitch();
    else expect(await bridge.switchTo("webgl")).toMatchObject({ status: "unchanged" });
    loading.resolve(module);
    await microtasks();

    expect(await operation).toMatchObject({ status: "cancelled", activeBackend: "webgl" });
    expect(create).not.toHaveBeenCalled();
    expect(container.append.mock.calls[0]![0].remove).toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  });
});
