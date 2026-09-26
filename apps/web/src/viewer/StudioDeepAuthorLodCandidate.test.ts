import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import { presentViewerFrame } from "./viewerFramePresentation";
import { updateAuthorLodSelection } from "./authorLodSelection";
import type { ViewerEngine } from "./ViewerEngine";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import * as environmentSource from "./studioDeepEnvironmentSource";

const owners: StudioDeepWebGpuBridge[] = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture() {
  const scheduled = new Map<number, FrameRequestCallback>(), listeners = new Set<() => void>(); let id = 0;
  const canvas = () => ({ style: {}, dataset: {}, clientWidth: 640, clientHeight: 480, setAttribute: vi.fn(), remove: vi.fn() });
  vi.stubGlobal("navigator", { gpu: {} });
  vi.stubGlobal("document", { createElement: canvas, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { scheduled.set(++id, callback); return id; });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => scheduled.delete(key));
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), lod = new THREE.LOD();
  scene.background = new THREE.Color("#123456"); scene.add(lod); camera.position.z = 20;
  const material = new THREE.MeshStandardMaterial();
  lod.addLevel(new THREE.Mesh(new THREE.BoxGeometry(), material), 0);
  lod.addLevel(new THREE.Mesh(new THREE.PlaneGeometry(), material), 10, 0.2);
  const selection = () => lod.levels.flatMap((level, index) => level.object.visible ? [index] : []);
  const captures: number[][] = [], update = vi.spyOn(lod, "update");
  const backend = { setProbeClipmapEnabled: vi.fn(), prepareScene: vi.fn(async () => { captures.push(selection()); return { frame: 1 }; }),
    sync: vi.fn(async () => ({ status: "committed" })), render: vi.fn(() => ({ frame: 1 })),
    dispose: vi.fn(), runtime: { session: { state: "ready" } } };
  const create = vi.fn(async () => { captures.push(selection()); return backend; });
  const projection = vi.fn();
  const module = { DeepWebGpuBackend: { create }, ThreeProjectionBridge: class { constructor(options: unknown) { projection(options); } },
    threeRenderView: (view: unknown) => view };
  const viewer = { scene, camera, orbit: { target: new THREE.Vector3() }, usesAuthorPostProcessing: () => true,
    renderer: { domElement: canvas(), getPixelRatio: () => 1, toneMappingExposure: 1, toneMapping: THREE.ACESFilmicToneMapping },
    getPostProcessing: () => ({ ...DEFAULT_POST_PROCESSING, enabled: false }), getDeepProjectionRoot: () => scene,
    getDeepEditorOverlayRoots: () => [], getDeepSelectionBox: () => undefined,
    getDeepTransformGizmoInput: () => undefined, getDeepMeasurementSegmentInputs: () => [],
    setPresentationRendererBackend: vi.fn(), setPresentationPerformanceSource: vi.fn(),
      setAuthorPacketIndependent: vi.fn(),
    subscribePresentationFrames: (callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); },
  } as unknown as ViewerEngine;
  const bridge = new StudioDeepWebGpuBridge(viewer, { append: vi.fn(), clientWidth: 640, clientHeight: 480 } as unknown as HTMLElement,
    { loadModule: async () => module as unknown as typeof import("@bim-studio/deep-engine/three-bridge") });
  owners.push(bridge);
  const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const tick = () => { const pending = [...scheduled.values()]; scheduled.clear(); pending.forEach(callback => callback(16)); };
  return { scene, camera, lod, update, bridge, backend, create, captures, selection, projection, listeners, flush, tick };
}

describe("Studio candidate author LOD capture ordering (GPU backend mocked)", () => {
  it("does not derive author state when cancelled before asynchronous loading", async () => {
    const f = fixture(), operation = f.bridge.switchTo("webgpu"); f.bridge.cancelPendingSwitch(); await f.flush();
    expect(await operation).toMatchObject({ status: "cancelled" });
    expect(f.create).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
    expect(f.selection()).toEqual([0, 1]);
  });
  it("ignores an environment result that arrives after candidate cancellation", async () => {
    const original = environmentSource.prepareStudioDeepEnvironmentSource;
    let resume!: () => void;
    const pending = new Promise<void>(resolve => { resume = resolve; });
    vi.spyOn(environmentSource, "prepareStudioDeepEnvironmentSource").mockImplementationOnce(async (...args) => {
      const result = await original(...args); await pending; return result;
    });
    const f = fixture(), operation = f.bridge.switchTo("webgpu"); await f.flush();
    f.bridge.cancelPendingSwitch(); resume(); await f.flush();
    expect(await operation).toMatchObject({ status: "cancelled" });
    expect(f.create).not.toHaveBeenCalled(); expect(f.update).not.toHaveBeenCalled();
    expect(f.camera.matrixWorld.elements[14]).toBe(0);
  });
  it("enables Studio author LOD and selects after fresh matrices at create and catch-up", async () => {
    const f = fixture(), operation = f.bridge.switchTo("webgpu"); await f.flush();
    expect(f.captures).toEqual([[1]]); expect(f.camera.matrixWorld.elements[14]).toBe(20);
    f.camera.position.z = 2; f.tick(); await f.flush();
    expect(await operation).toMatchObject({ status: "switched" });
    expect(f.captures).toEqual([[1], [0]]); expect(f.camera.matrixWorld.elements[14]).toBe(2);
    expect(f.projection.mock.calls[0]![0].capabilities.authorLod).toBe(true);
    expect(f.update).toHaveBeenCalledTimes(2);
    // Repaint and sync completion consume the snapshot, not a second author selection/timeline.
    f.tick(); await f.flush(); expect(f.update).toHaveBeenCalledTimes(2);
    presentViewerFrame({ authorBackend: "webgl", presentationBackend: "webgpu", xrActive: false, offscreenFrame: false,
      listeners: f.listeners, drawAuthor: () => { throw new Error("unexpected WebGL draw"); },
      updateAuthorMatrices: () => { f.scene.updateMatrixWorld(true); f.camera.updateMatrixWorld(true); },
      updateAuthorLods: () => updateAuthorLodSelection(f.scene, f.camera) });
    await f.flush(); f.tick(); await f.flush();
    // 相机未动时 LOD 重选按幂等跳过(缓存合同);选择结果不变即满足捕获语义。
    expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.selection()).toEqual([0]);
  });
  it("cancels between RAF resolution and catch-up continuation without touching author selection", async () => {
    const f = fixture(), operation = f.bridge.switchTo("webgpu"); await f.flush();
    f.camera.position.z = 2; f.tick(); f.bridge.cancelPendingSwitch(); await f.flush();
    expect(await operation).toMatchObject({ status: "cancelled", activeBackend: "webgl" });
    expect(f.captures).toEqual([[1]]); expect(f.update).toHaveBeenCalledOnce();
    expect(f.backend.prepareScene).not.toHaveBeenCalled(); expect(f.backend.dispose).toHaveBeenCalledOnce();
    expect(f.selection()).toEqual([1]); expect(f.camera.matrixWorld.elements[14]).toBe(20);
  });
  it("catches up a newer author selection after pending sync without updating the author twice", async () => {
    const f = fixture(), operation = f.bridge.switchTo("webgpu"); await f.flush(); f.tick(); await f.flush(); await operation;
    let commit!: (value: { status: string }) => void;
    const pending = new Promise<{ status: string }>(resolve => { commit = resolve; });
    const selections: number[][] = [];
    f.backend.sync.mockImplementationOnce(() => { selections.push(f.selection()); return pending; });
    f.backend.sync.mockImplementation(async () => { selections.push(f.selection()); return { status: "committed" }; });
    const authorFrame = (distance: number) => {
      f.camera.position.z = distance;
      presentViewerFrame({ authorBackend: "webgl", presentationBackend: "webgpu", xrActive: false, offscreenFrame: false,
        listeners: f.listeners, drawAuthor: vi.fn(),
        updateAuthorMatrices: () => { f.scene.updateMatrixWorld(true); f.camera.updateMatrixWorld(true); },
        updateAuthorLods: () => updateAuthorLodSelection(f.scene, f.camera) });
    };
    authorFrame(20); authorFrame(2); expect(selections).toEqual([[1]]);
    commit({ status: "committed" }); await f.flush();
    expect(selections).toEqual([[1], [0]]);
    // 相机回到 z=2 与 candidate 捕获同位姿:LOD 重选按幂等跳过(缓存合同),捕获读到的 [0] 由 z=20 帧的真实重选推进。
    expect(f.update).toHaveBeenCalledTimes(2);
    f.tick(); await f.flush(); expect(f.update).toHaveBeenCalledTimes(2);
    expect(f.selection()).toEqual([0]);
  });
  it("leaves manual zero or multiple selected levels unchanged at both candidate captures", async () => {
    const f = fixture(); f.lod.autoUpdate = false; f.lod.levels.forEach(level => { level.object.visible = false; });
    const operation = f.bridge.switchTo("webgpu"); await f.flush();
    f.lod.levels.forEach(level => { level.object.visible = true; }); f.tick(); await f.flush();
    expect(await operation).toMatchObject({ status: "switched" });
    expect(f.captures).toEqual([[], [0, 1]]); expect(f.update).not.toHaveBeenCalled();
  });
});
