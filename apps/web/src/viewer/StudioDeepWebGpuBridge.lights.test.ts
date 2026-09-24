import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderView } from "@bim-studio/deep-engine/webgpu";
import type { ViewerEngine } from "./ViewerEngine";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";

type BridgeModule = typeof import("@bim-studio/deep-engine/three-bridge");

// 真正运行宿主桥和 Three 灯投影；GPU 由受控后端替身隔离，本组不证明像素画质。
describe("Studio Deep bridge author lighting", () => {
  let raf: Map<number, FrameRequestCallback>;
  let authorFrames: Set<() => void>;
  let bridges: StudioDeepWebGpuBridge[];
  let scenes: THREE.Scene[];
  beforeEach(() => {
    raf = new Map(); authorFrames = new Set(); bridges = []; scenes = [];
    let frameId = 0;
    vi.stubGlobal("navigator", { gpu: {} });
    vi.stubGlobal("document", { createElement: canvas, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { raf.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => raf.delete(id));
  });
  afterEach(() => { bridges.forEach(bridge => bridge.dispose()); vi.unstubAllGlobals(); });
  function canvas() {
    return { style: { position: "", inset: "", width: "", height: "", opacity: "1", zIndex: "", pointerEvents: "" },
      dataset: {}, clientWidth: 640, clientHeight: 480, setAttribute: vi.fn(), remove: vi.fn() };
  }
  async function settle() { for (let index = 0; index < 20; index++) await Promise.resolve(); }
  async function frame() {
    const callbacks = [...raf.values()]; raf.clear(); callbacks.forEach(callback => callback(16));
    await settle();
    // 产品里 presentViewerFrame 在通知桥之前刷新作者场景矩阵;夹具直接调用
    // 桥回调,必须补齐同一职责,否则灯光矩阵仍是上一帧的。
    scenes.forEach(scene => scene.updateMatrixWorld(true));
    authorFrames.forEach(callback => callback()); await settle();
  }
  function fixture() {
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
    scenes.push(scene);
    scene.background = new THREE.Color("#123456");
    const authorCanvas = canvas(), container = { clientWidth: 640, clientHeight: 480, append: vi.fn() };
    const backend = { setProbeClipmapEnabled: vi.fn(), prepareScene: vi.fn(async (_root: unknown, _view: RenderView) => ({ frame: 1 })),
      stageShadowMapSize: vi.fn(async (_mapSize: number, _signal: AbortSignal): Promise<"staged" | "superseded"> => "staged"),
      sync: vi.fn(async () => ({ status: "committed", update: "instances", packet: {} })),
      render: vi.fn((_view: RenderView) => ({ frame: 1 })), dispose: vi.fn(), runtime: {} };
    const create = vi.fn(async (_request: { view: RenderView; renderer?: unknown }) => backend);
    const presentation = vi.fn(), failure = vi.fn(), unsubscribe = vi.fn();
    const shadowMap = { enabled: true };
    const viewer = { scene, camera, orbit: { target: new THREE.Vector3() },
      renderer: { domElement: authorCanvas, getPixelRatio: () => 1, toneMappingExposure: 1, shadowMap,
        toneMapping: THREE.ACESFilmicToneMapping }, usesAuthorPostProcessing: () => true,
      getDeepProjectionRoot: () => scene, getDeepEditorOverlayRoots: () => [], setPresentationRendererBackend: presentation,
      getPostProcessing: () => ({ ...DEFAULT_POST_PROCESSING, enabled: false }),
      setPresentationPerformanceSource: vi.fn(),
      subscribePresentationFrames: (callback: () => void) => {
        authorFrames.add(callback); return () => { authorFrames.delete(callback); unsubscribe(); };
      } } as unknown as ViewerEngine;
    const module = { DeepWebGpuBackend: { create }, ThreeProjectionBridge: class {},
      // Deliberately omit lights here: the Studio bridge must attach the author projection itself.
      threeRenderView: () => ({}) } as unknown as BridgeModule;
    const bridge = new StudioDeepWebGpuBridge(viewer, container as unknown as HTMLElement,
      { loadModule: async () => module, onRuntimeFailure: failure });
    bridges.push(bridge);
    return { bridge, scene, camera, backend, create, authorCanvas, container, presentation, failure, unsubscribe, shadowMap };
  }
  async function activate(bridge: StudioDeepWebGpuBridge) {
    const pending = bridge.switchTo("webgpu"); await settle(); await frame();
    expect(await pending).toMatchObject({ status: "switched", activeBackend: "webgpu" });
  }
  function sun(scene: THREE.Scene) {
    const light = new THREE.DirectionalLight(0xffffff, 2.7);
    light.position.set(0, 5, 0); light.castShadow = false;
    scene.add(light, light.target); return light;
  }
  it("passes author sun into both create and catch-up instead of Deep defaults", async () => {
    const { bridge, scene, create, backend } = fixture();
    sun(scene);
    await activate(bridge);
    const expected = { directional: [{ color: [1, 1, 1], intensity: 2.7,
      directionWorld: [0, -1, 0], castShadow: false }], points: [], spots: [] };
    expect(create.mock.calls[0]![0].view.lights).toEqual(expected);
    expect(backend.prepareScene.mock.calls[0]![1].lights).toEqual(expected);
  });
  it("allocates the author's exact shadow resolution and refreshes its camera after light movement", async () => {
    const { bridge, scene, create, backend } = fixture();
    const light = sun(scene); light.castShadow = true;
    light.shadow.mapSize.set(2048, 2048); light.shadow.bias = -0.002; light.shadow.normalBias = 0.03;
    await activate(bridge);
    expect(create.mock.calls[0]![0].renderer).toMatchObject({ shadows: {
      exactProfile: { cascadeCount: 1, shadowMapSize: 2048 } } });
    const initial = create.mock.calls[0]![0].view.lights?.directional?.[0]?.shadow;
    expect(initial).toMatchObject({ mapSize: 2048, bias: -0.002, normalBias: 0.03 });
    light.position.x = 3; await frame();
    expect(backend.render.mock.calls.at(-1)![0].lights?.directional?.[0]?.shadow?.viewProjection)
      .not.toEqual(initial?.viewProjection);
  });
  it("updates live authored intensity and explicitly clears disabled lights", async () => {
    const { bridge, scene, backend } = fixture(); const light = sun(scene);
    await activate(bridge);
    light.intensity = 0.375; await frame();
    expect(backend.render.mock.calls.at(-1)![0].lights?.directional?.[0]?.intensity).toBe(0.375);
    light.visible = false; await frame();
    expect(backend.render.mock.calls.at(-1)![0].lights).toEqual({ directional: [], points: [], spots: [] });
    light.visible = true; light.intensity = 0; await frame();
    expect(backend.render.mock.calls.at(-1)![0].lights?.directional).toEqual([]);
  });
  it("projects author fog at creation and follows density/type/disabled changes", async () => {
    const { bridge, scene, create, backend } = fixture();
    scene.fog = new THREE.FogExp2(new THREE.Color().setRGB(0.2, 0.3, 0.4), 0.007);
    await activate(bridge);
    expect(create.mock.calls[0]![0].view).toMatchObject({ fog: {
      kind: "exp2", color: [0.2, 0.3, 0.4], density: 0.007 } });
    scene.fog.density = 0.02; await frame();
    expect(backend.render.mock.calls.at(-1)![0]).toMatchObject({ fog: { density: 0.02 } });
    scene.fog = new THREE.Fog(0xffffff, 2, 80); await frame();
    expect(backend.render.mock.calls.at(-1)![0]).toMatchObject({ fog: { kind: "linear", near: 2, far: 80 } });
    scene.fog = null; await frame();
    expect(backend.render.mock.calls.at(-1)![0]).toHaveProperty("fog", null);
  });
  it("keeps Deep active while changing shadow resolution, then renders the prepared map", async () => {
    const { bridge, scene, backend, failure } = fixture();
    const light = sun(scene); light.castShadow = true;
    await activate(bridge);
    let ready!: (result: "staged") => void;
    backend.stageShadowMapSize.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
    light.shadow.mapSize.set(2048, 2048); await frame();
    expect(backend.stageShadowMapSize).toHaveBeenCalledWith(2048, expect.any(AbortSignal));
    expect(backend.render.mock.calls.at(-1)![0].lights?.directional?.[0]?.shadow?.mapSize).toBe(512);
    expect(bridge.activeBackend).toBe("webgpu");
    ready("staged"); await settle(); await frame();
    expect(backend.render.mock.calls.at(-1)![0].lights?.directional?.[0]?.shadow?.mapSize).toBe(2048);
    expect(failure).not.toHaveBeenCalled();
  });
  it("uses camera layers during creation and live updates", async () => {
    const { bridge, scene, camera, create, backend } = fixture();
    const light = sun(scene); light.layers.set(2);
    const excluded = new THREE.RectAreaLight(); excluded.layers.set(3); scene.add(excluded);
    await activate(bridge);
    expect(create.mock.calls[0]![0].view.lights?.directional).toEqual([]);
    camera.layers.enable(2); await frame();
    expect(backend.render.mock.calls.at(-1)![0].lights?.directional).toHaveLength(1);
    camera.layers.disable(2); await frame();
    expect(backend.render.mock.calls.at(-1)![0].lights?.directional).toEqual([]);
    expect(bridge.activeBackend).toBe("webgpu");
  });
  it("restores WebGL and retires Deep when unsupported lighting becomes active", async () => {
    const { bridge, scene, backend, authorCanvas, container, failure, unsubscribe, presentation } = fixture();
    sun(scene); await activate(bridge);
    scene.add(new THREE.RectAreaLight()); await frame();
    expect(bridge.activeBackend).toBe("webgl");
    expect(authorCanvas.style.opacity).toBe("1");
    expect(presentation).toHaveBeenLastCalledWith("webgl");
    expect(backend.dispose).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce();
    expect(container.append.mock.calls[0]![0].remove).toHaveBeenCalledOnce();
    expect(failure).toHaveBeenCalledOnce();
    expect(failure.mock.calls[0]![0].message).toContain("RectAreaLight");
    const rendered = backend.render.mock.calls.length; await frame();
    expect(backend.render).toHaveBeenCalledTimes(rendered);
    expect(backend.dispose).toHaveBeenCalledOnce();
  });
  it("rejects initially unsupported lights without publishing or creating GPU resources", async () => {
    const { bridge, scene, create, presentation, authorCanvas, container } = fixture();
    scene.add(new THREE.RectAreaLight());
    const result = await bridge.switchTo("webgpu");
    expect(result).toMatchObject({ status: "failed", activeBackend: "webgl", error: expect.stringContaining("RectAreaLight") });
    expect(create).not.toHaveBeenCalled(); expect(presentation).not.toHaveBeenCalled();
    expect(authorCanvas.style.opacity).toBe("1");
    expect(container.append.mock.calls[0]![0].remove).toHaveBeenCalledOnce();
  });
  it("delivers ambient and transformed hemisphere light to initialization and active rendering", async () => {
    const { bridge, scene, create, backend } = fixture();
    const ambient = new THREE.AmbientLight(new THREE.Color().setRGB(0.2, 0.3, 0.4), 0.35);
    const hemisphere = new THREE.HemisphereLight(new THREE.Color().setRGB(0.8, 0.7, 0.6),
      new THREE.Color().setRGB(0.1, 0.2, 0.3), 0.65);
    const parent = new THREE.Group(); parent.position.set(3, 0, 0);
    hemisphere.position.set(0, 4, 0); parent.add(hemisphere); scene.add(ambient, parent);
    await activate(bridge);
    const expected = { ambient: [{ color: [0.2, 0.3, 0.4], intensity: 0.35 }],
      hemisphere: [{ directionWorld: [expect.closeTo(0.6, 12), expect.closeTo(0.8, 12), 0], skyColor: [0.8, 0.7, 0.6],
        groundColor: [0.1, 0.2, 0.3], intensity: 0.65 }] };
    expect(create.mock.calls[0]![0].view.lights).toMatchObject(expected);
    expect(backend.prepareScene.mock.calls[0]![1].lights).toMatchObject(expected);
    expect(backend.render.mock.calls.at(-1)![0].lights).toMatchObject(expected);
    hemisphere.intensity = 0.125; await frame();
    expect(backend.render.mock.calls.at(-1)![0].lights).toMatchObject({ hemisphere: [{ intensity: 0.125 }] });
    ambient.visible = false; hemisphere.intensity = 0; await frame();
    const lights = backend.render.mock.calls.at(-1)![0].lights;
    expect(lights?.ambient ?? []).toEqual([]); expect(lights?.hemisphere ?? []).toEqual([]);
    expect(bridge.activeBackend).toBe("webgpu");
  });
  it("updates author shadow parameters when the global switch is enabled", async () => {
    const { bridge, scene, create, backend, shadowMap, failure, authorCanvas } = fixture();
    const light = sun(scene); light.castShadow = true; shadowMap.enabled = false;
    await activate(bridge);
    expect(create.mock.calls[0]![0].view.lights?.directional?.[0]?.castShadow).toBe(false);
    expect(create.mock.calls[0]![0].renderer).toMatchObject({ shadows: {
      exactProfile: { cascadeCount: 1, shadowMapSize: 512 } } });
    expect(backend.render.mock.calls.at(-1)![0].lights?.directional?.[0]?.castShadow).toBe(false);
    shadowMap.enabled = true; await frame();
    expect(bridge.activeBackend).toBe("webgpu"); expect(authorCanvas.style.opacity).toBe("0");
    expect(backend.render.mock.calls.at(-1)![0].lights?.directional?.[0]).toMatchObject({ castShadow: true,
      shadow: { mapSize: 512, bias: 0, normalBias: 0, intensity: 1, radius: 1 } });
    expect(backend.dispose).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
  });
});
