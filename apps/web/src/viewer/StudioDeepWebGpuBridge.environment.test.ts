import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PbrEnvironmentSource, PbrRendererOptions, RenderView } from "@bim-studio/deep-engine/webgpu";
import type { ViewerEngine } from "./ViewerEngine";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";

type BridgeModule = typeof import("@bim-studio/deep-engine/three-bridge");
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function texture(value: number) {
  const image = new THREE.DataTexture(new Float32Array([value, 0.2, 0.3, 1, 0.4, 0.5, value, 1]),
    2, 1, THREE.RGBAFormat, THREE.FloatType);
  image.colorSpace = THREE.LinearSRGBColorSpace; image.mapping = THREE.EquirectangularReflectionMapping;
  image.flipY = true; return image;
}
function canvas() {
  return { style: { position: "", inset: "", width: "", height: "", opacity: "1", zIndex: "", pointerEvents: "" },
    dataset: {}, clientWidth: 640, clientHeight: 480, setAttribute: vi.fn(), remove: vi.fn() };
}

// Uses the real CPU environment conversion/session and bridge, with GPU staging controlled independently.
describe("Studio Deep bridge environment staging", () => {
  let frames: Map<number, FrameRequestCallback>, authorFrames: Set<() => void>;
  let bridges: StudioDeepWebGpuBridge[];
  beforeEach(() => {
    frames = new Map(); authorFrames = new Set(); bridges = []; let id = 0;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("navigator", { gpu: {} });
    vi.stubGlobal("document", { createElement: canvas, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; });
    vi.stubGlobal("cancelAnimationFrame", (value: number) => frames.delete(value));
  });
  afterEach(() => { bridges.forEach(bridge => bridge.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });
  async function settle() { for (let index = 0; index < 24; index++) await Promise.resolve(); }
  async function preparePixels() { await settle(); await vi.advanceTimersByTimeAsync(1); await settle(); }
  async function frame() {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(16));
    await settle(); authorFrames.forEach(callback => callback()); await settle();
  }
  function fixture() {
    const scene = new THREE.Scene(); scene.background = new THREE.Color().setRGB(0.1, 0.2, 0.3);
    scene.environment = texture(2); scene.environmentIntensity = 0.4;
    const authorCanvas = canvas(), camera = new THREE.PerspectiveCamera();
    const backend = { setProbeClipmapEnabled: vi.fn(), sync: vi.fn(async () => ({ status: "committed", update: "instances", packet: {} })),
      prepareScene: vi.fn(async (_root: unknown, _view: RenderView) => ({ frame: 1 })),
      stageEnvironment: vi.fn(async (_source: PbrEnvironmentSource, _signal: AbortSignal): Promise<"staged" | "superseded"> => "staged"),
      render: vi.fn((_view: RenderView) => ({ frame: 1 })), dispose: vi.fn(), runtime: {} };
    const create = vi.fn(async (_request: { renderer: PbrRendererOptions; view: RenderView }) => backend);
    const presentation = vi.fn(), failure = vi.fn(), container = { clientWidth: 640, clientHeight: 480, append: vi.fn() };
    const viewer = { scene, camera, orbit: { target: new THREE.Vector3() },
      renderer: { domElement: authorCanvas, toneMappingExposure: 1.2, toneMapping: THREE.ACESFilmicToneMapping, getPixelRatio: () => 1 },
      getDeepProjectionRoot: () => scene, getDeepEditorOverlayRoots: () => [], usesAuthorPostProcessing: () => true,
      getPostProcessing: () => ({ ...DEFAULT_POST_PROCESSING, enabled: false }),
      setPresentationPerformanceSource: vi.fn(),
      setPresentationRendererBackend: presentation, subscribePresentationFrames: (callback: () => void) => {
        authorFrames.add(callback); return () => authorFrames.delete(callback);
      } } as unknown as ViewerEngine;
    const module = { DeepWebGpuBackend: { create }, ThreeProjectionBridge: class {},
      threeRenderView: (source: unknown) => source } as unknown as BridgeModule;
    const bridge = new StudioDeepWebGpuBridge(viewer, container as unknown as HTMLElement,
      { loadModule: async () => module, onRuntimeFailure: failure });
    bridges.push(bridge);
    return { bridge, scene, backend, create, authorCanvas, failure, presentation, container };
  }
  async function activate(bridge: StudioDeepWebGpuBridge) {
    const pending = bridge.switchTo("webgpu"); await preparePixels(); await frame();
    expect(await pending).toMatchObject({ status: "switched", activeBackend: "webgpu" });
  }
  it("creates from owned author HDR pixels with no fabricated ground and Three ACES", async () => {
    const { bridge, scene, create } = fixture(); await activate(bridge);
    const { renderer, view } = create.mock.calls[0]![0];
    expect(renderer.features).toMatchObject({ environment: true, groundPlane: false, groundGrid: false, toneMapping: "three-aces-r185" });
    expect(renderer.environment?.kind).toBe("radiance-hdr");
    if (renderer.environment?.kind !== "radiance-hdr") throw new Error("Expected HDR pixels");
    expect(renderer.environment.image.data[0]).toBe(2);
    expect(view.environmentIntensity).toBe(0.4);
    expect(view.background).toEqual([0.1, 0.2, 0.3]);
    (scene.environment as THREE.DataTexture).image.data![0] = 8;
    expect(renderer.environment.image.data[0]).toBe(2);
  });
  it("keeps prior view while GPU environment staging waits, then publishes the matching view", async () => {
    const { bridge, scene, backend, create } = fixture(); await activate(bridge);
    const staging = deferred<"staged" | "superseded">(); backend.stageEnvironment.mockReturnValueOnce(staging.promise);
    scene.environment = texture(3); scene.environmentIntensity = 0.8;
    scene.background = new THREE.Color().setRGB(0.6, 0.7, 0.8);
    await frame(); await preparePixels();
    expect(backend.stageEnvironment).toHaveBeenCalledOnce();
    expect(backend.render.mock.calls.at(-1)![0]).toMatchObject({ environmentIntensity: 0.4, background: [0.1, 0.2, 0.3] });
    expect(backend.dispose).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledOnce();
    staging.resolve("staged"); await settle();
    expect(backend.render.mock.calls.at(-1)![0]).toMatchObject({ environmentIntensity: 0.8, background: [0.6, 0.7, 0.8] });
    expect(bridge.activeBackend).toBe("webgpu");
  });
  it("aborts staging on bridge disposal and ignores late completion", async () => {
    const { bridge, scene, backend, presentation } = fixture(); await activate(bridge);
    const staging = deferred<"staged" | "superseded">(); backend.stageEnvironment.mockReturnValueOnce(staging.promise);
    scene.environment = texture(4); await frame(); await preparePixels();
    const signal = backend.stageEnvironment.mock.calls[0]![1];
    bridge.dispose(); expect(signal.aborted).toBe(true);
    const rendered = backend.render.mock.calls.length;
    staging.resolve("staged"); await settle();
    expect(backend.render).toHaveBeenCalledTimes(rendered); expect(backend.dispose).toHaveBeenCalledOnce();
    expect(presentation).toHaveBeenLastCalledWith("webgl");
  });
  it("cancels a superseded environment without retiring the published backend", async () => {
    const { bridge, scene, backend, failure } = fixture(); await activate(bridge);
    const obsolete = deferred<"staged" | "superseded">(), latest = deferred<"staged" | "superseded">();
    backend.stageEnvironment.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(latest.promise);
    scene.environment = texture(4); scene.environmentIntensity = 0.6;
    await frame(); await preparePixels();
    const obsoleteSignal = backend.stageEnvironment.mock.calls[0]![1];
    scene.environment = texture(5); scene.environmentIntensity = 0.9;
    await frame(); await preparePixels();
    expect(obsoleteSignal.aborted).toBe(true);
    expect(backend.stageEnvironment).toHaveBeenCalledTimes(2);
    const latestSource = backend.stageEnvironment.mock.calls[1]![0];
    expect(latestSource.kind).toBe("radiance-hdr");
    if (latestSource.kind !== "radiance-hdr") throw new Error("Expected latest HDR source");
    expect(latestSource.image.data[0]).toBe(5);
    expect(backend.dispose).not.toHaveBeenCalled();
    expect(backend.render.mock.calls.at(-1)![0].environmentIntensity).toBe(0.4);
    latest.resolve("staged"); await settle();
    expect(backend.render.mock.calls.at(-1)![0].environmentIntensity).toBe(0.9);
    obsolete.resolve("staged"); await settle();
    expect(bridge.activeBackend).toBe("webgpu"); expect(failure).not.toHaveBeenCalled();
    expect(backend.render.mock.calls.at(-1)![0].environmentIntensity).toBe(0.9);
  });
  it("returns to author WebGL when GPU environment preparation fails", async () => {
    const { bridge, scene, backend, failure, authorCanvas } = fixture(); await activate(bridge);
    backend.stageEnvironment.mockRejectedValueOnce(new Error("environment GPU validation failed"));
    scene.environment = texture(4); await frame(); await preparePixels();
    expect(bridge.activeBackend).toBe("webgl"); expect(authorCanvas.style.opacity).toBe("1");
    expect(backend.dispose).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]![0].message).toContain("GPU validation failed");
  });
  it("cancels a replacement when the author returns to the already active source", async () => {
    const { bridge, scene, backend, failure } = fixture(); const initial = scene.environment;
    await activate(bridge);
    const obsolete = deferred<"staged" | "superseded">(); backend.stageEnvironment.mockReturnValueOnce(obsolete.promise);
    scene.environment = texture(6); await frame(); await preparePixels();
    const signal = backend.stageEnvironment.mock.calls[0]![1];
    scene.environment = initial; scene.environmentIntensity = 0.7; await frame();
    expect(signal.aborted).toBe(true); expect(backend.stageEnvironment).toHaveBeenCalledOnce();
    expect(backend.render.mock.calls.at(-1)![0].environmentIntensity).toBe(0.7);
    obsolete.resolve("staged"); await settle();
    expect(bridge.activeBackend).toBe("webgpu"); expect(failure).not.toHaveBeenCalled();
    expect(backend.dispose).not.toHaveBeenCalled();
  });
  it("reports author view incompatibility introduced during GPU staging", async () => {
    const { bridge, scene, backend, failure } = fixture(); await activate(bridge);
    const staging = deferred<"staged" | "superseded">(); backend.stageEnvironment.mockReturnValueOnce(staging.promise);
    scene.environment = texture(6); await frame(); await preparePixels();
    scene.environmentRotation.y = 0.3;
    staging.resolve("staged"); await settle();
    expect(bridge.activeBackend).toBe("webgl"); expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]![0].message).toContain("旋转");
    expect(backend.dispose).toHaveBeenCalledOnce();
  });
});
