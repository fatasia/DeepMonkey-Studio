import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import type { ViewerEngine } from "./ViewerEngine";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";

const owned: StudioDeepWebGpuBridge[] = [];
afterEach(() => { owned.splice(0).forEach(bridge => bridge.dispose()); vi.unstubAllGlobals(); });

function fixture() {
  const scheduled = new Map<number, FrameRequestCallback>(), frames = new Set<() => void>(); let frameId = 0;
  const surface = () => ({ style: { position: "relative", inset: "", width: "640px", height: "480px", opacity: "1", zIndex: "0", pointerEvents: "auto" },
    dataset: {}, clientWidth: 640, clientHeight: 480, setAttribute: vi.fn(), remove: vi.fn() });
  const canvases: ReturnType<typeof surface>[] = [];
  vi.stubGlobal("navigator", { gpu: {} });
  vi.stubGlobal("document", { createElement: () => { const canvas = surface(); canvases.push(canvas); return canvas; }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { scheduled.set(++frameId, callback); return frameId; });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => scheduled.delete(id));
  const pixels = new Uint8ClampedArray(16).fill(128), getImageData = vi.fn(() => ({ data: pixels }));
  const image = { width: 2, height: 2, getContext: () => ({ getImageData }) } as unknown as HTMLCanvasElement;
  const texture = new THREE.CanvasTexture(image); texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const geometry = new THREE.PlaneGeometry(200, 200), grid = new THREE.Mesh(geometry, material);
  grid.name = "helper:grid"; grid.renderOrder = -10;
  const scene = new THREE.Scene(); scene.background = new THREE.Color("#123456"); scene.add(grid);
  const model = new THREE.Group(), camera = new THREE.PerspectiveCamera(); camera.position.z = 3; scene.add(model);
  const authorCanvas = surface(), composer = vi.fn(() => true), presentation = vi.fn(), failure = vi.fn();
  const viewer = { scene, camera, orbit: { target: new THREE.Vector3() }, usesAuthorPostProcessing: composer,
    renderer: { domElement: authorCanvas, getPixelRatio: () => 1, toneMappingExposure: 1, toneMapping: THREE.ACESFilmicToneMapping },
    getPostProcessing: () => ({ ...DEFAULT_POST_PROCESSING, enabled: false }), getDeepProjectionRoot: () => model,
    getDeepGrid: () => grid, getDeepEditorOverlayRoots: () => [], setPresentationRendererBackend: presentation,
    setPresentationPerformanceSource: vi.fn(), subscribePresentationFrames: (callback: () => void) => { frames.add(callback); return () => frames.delete(callback); },
  } as unknown as ViewerEngine;
  const backend = () => ({ prepareScene: vi.fn().mockResolvedValue({ frame: 1 }), sync: vi.fn().mockResolvedValue({ status: "committed" }),
    render: vi.fn(() => ({ frame: 1 })), dispose: vi.fn(), runtime: { session: { state: "ready" } } });
  const first = backend(), second = backend(), create = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const module = { DeepWebGpuBackend: { create }, ThreeProjectionBridge: class {}, threeRenderView: (view: unknown) => view };
  const bridge = new StudioDeepWebGpuBridge(viewer, { append: vi.fn(), clientWidth: 640, clientHeight: 480 } as unknown as HTMLElement,
    { loadModule: async () => module as unknown as typeof import("@bim-studio/deep-engine/three-bridge"), onRuntimeFailure: failure });
  owned.push(bridge);
  const microtasks = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const tick = async () => { const callbacks = [...scheduled.values()]; scheduled.clear(); callbacks.forEach(callback => callback(16)); await microtasks(); };
  const activate = async () => { const pending = bridge.switchTo("webgpu"); await microtasks(); await tick(); return pending; };
  const authorDisposal = [vi.spyOn(texture, "dispose"), vi.spyOn(material, "dispose"), vi.spyOn(geometry, "dispose")];
  return { bridge, first, second, create, grid, material, texture, pixels, getImageData, composer, authorCanvas, canvases,
    presentation, failure, frames, scheduled, activate, tick, microtasks, authorDisposal };
}

describe("author grid failures through the real Studio bridge lifecycle (no GPU)", () => {
  it.each(["composer", "taint"])("keeps author presentation when initial %s preparation fails", async reason => {
    const f = fixture();
    if (reason === "composer") f.composer.mockReturnValue(false);
    else f.getImageData.mockImplementation(() => { throw new Error("tainted author canvas"); });
    expect(await f.activate()).toMatchObject({ status: "failed", activeBackend: "webgl" });
    expect(f.authorCanvas.style.opacity).toBe("1"); expect(f.create).not.toHaveBeenCalled();
    expect(f.canvases[0]!.remove).toHaveBeenCalledOnce(); expect(f.failure).not.toHaveBeenCalled();
    expect(f.grid.parent).not.toBeNull(); expect(f.material.map).toBe(f.texture);
    f.authorDisposal.forEach(dispose => expect(dispose).not.toHaveBeenCalled());
  });
  it("disposes an unpublished candidate when its fresh grid read fails", async () => {
    const f = fixture();
    f.create.mockReset().mockImplementationOnce(async () => { f.texture.needsUpdate = true;
      f.getImageData.mockImplementation(() => { throw new Error("updated pixels tainted"); }); return f.first; });
    expect(await f.activate()).toMatchObject({ status: "failed", activeBackend: "webgl" });
    expect(f.first.prepareScene).not.toHaveBeenCalled(); expect(f.first.dispose).toHaveBeenCalledOnce();
    expect(f.authorCanvas.style.opacity).toBe("1"); expect(f.canvases[0]!.remove).toHaveBeenCalledOnce();
  });
  it("cancels candidate publication and can switch both directions without disposing author resources", async () => {
    const f = fixture(), parent = f.grid.parent;
    const preparing = f.bridge.switchTo("webgpu"); await f.microtasks();
    expect(f.create).toHaveBeenCalledOnce(); f.bridge.cancelPendingSwitch(); await f.microtasks();
    expect(await preparing).toMatchObject({ status: "cancelled", activeBackend: "webgl" });
    expect(f.first.dispose).toHaveBeenCalledOnce(); expect(f.authorCanvas.style.opacity).toBe("1");
    expect(await f.activate()).toMatchObject({ status: "switched" });
    const returning = f.bridge.switchTo("webgl"); await f.tick();
    expect(await returning).toMatchObject({ status: "switched", activeBackend: "webgl" });
    expect(f.second.dispose).toHaveBeenCalledOnce(); expect(f.grid.parent).toBe(parent);
    expect(f.material.map).toBe(f.texture); expect(f.material.opacity).toBe(1); expect(f.texture.image).toBeDefined();
    f.authorDisposal.forEach(dispose => expect(dispose).not.toHaveBeenCalled());
  });
  it.each(["composer", "taint"])("restores author synchronously after active %s failure and permits a clean switch retry", async reason => {
    const f = fixture(); expect(await f.activate()).toMatchObject({ status: "switched" });
    expect(f.authorCanvas.style.opacity).toBe("0");
    if (reason === "composer") f.composer.mockReturnValue(false);
    else { f.texture.needsUpdate = true; f.getImageData.mockImplementation(() => { throw new Error("tainted update"); }); }
    for (const frame of [...f.frames]) frame();
    expect(f.bridge.activeBackend).toBe("webgl"); expect(f.authorCanvas.style.opacity).toBe("1");
    expect(f.first.dispose).toHaveBeenCalledOnce(); expect(f.canvases[0]!.remove).toHaveBeenCalledOnce();
    expect(f.frames.size).toBe(0); expect(f.scheduled.size).toBe(0); expect(f.failure).toHaveBeenCalledOnce();
    await f.microtasks(); expect(f.first.render).not.toHaveBeenCalled();
    f.composer.mockReturnValue(true); f.getImageData.mockImplementation(() => ({ data: f.pixels }));
    f.pixels[0] = 64; f.texture.needsUpdate = true;
    expect(await f.activate()).toMatchObject({ status: "switched", activeBackend: "webgpu" });
    expect(f.second.prepareScene.mock.calls[0]![1].authorGrid.texture.data[0]).toBe(64);
    f.bridge.dispose(); expect(f.second.dispose).toHaveBeenCalledOnce(); expect(f.authorCanvas.style.opacity).toBe("1");
    f.authorDisposal.forEach(dispose => expect(dispose).not.toHaveBeenCalled());
  });
});
