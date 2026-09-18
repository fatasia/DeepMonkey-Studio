import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as deep from "@bim-studio/deep-engine/three-bridge";
import type { InstanceUpdate, RenderPacket } from "@bim-studio/deep-engine";
import type { FrameMetrics, PbrRendererOptions } from "@bim-studio/deep-engine/webgpu";
import type { ViewerEngine } from "./ViewerEngine";
import { DEFAULT_POST_PROCESSING } from "../appDefaults";
import { StudioDeepWebGpuBridge } from "./StudioDeepWebGpuBridge";

// Studio、Three投影和Deep backend均真实执行；仅GPU runtime以可控边界替代。
describe("Studio author animation integration", () => {
  let frames: Map<number, FrameRequestCallback>, bridges: StudioDeepWebGpuBridge[], sequence: number;
  beforeEach(() => {
    frames = new Map(); bridges = []; sequence = 0;
    vi.stubGlobal("navigator", { gpu: {} });
    vi.stubGlobal("document", { createElement: canvas, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  });
  afterEach(() => { for (const bridge of bridges) bridge.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function canvas() { return { style: { opacity: "1" }, dataset: {}, clientWidth: 640, clientHeight: 480,
    setAttribute: vi.fn(), remove: vi.fn() }; }
  async function microtasks() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
  async function frame() {
    const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(callback => callback(16)); await microtasks();
  }
  function fixture() {
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(new Array(12).fill(0.2), 3)];
    const author = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
    const scene = new THREE.Scene(), root = new THREE.Group(); root.add(author); scene.add(root);
    scene.background = new THREE.Color("#123456");
    const camera = new THREE.PerspectiveCamera(); camera.position.z = 5;
    const authorCanvas = canvas(), authorFrames = new Set<() => void>(), failure = vi.fn();
    const viewer = { scene, camera, orbit: { target: new THREE.Vector3() },
      renderer: { domElement: authorCanvas, getPixelRatio: () => 1, toneMappingExposure: 1, toneMapping: THREE.ACESFilmicToneMapping },
      usesAuthorPostProcessing: () => true, getPostProcessing: () => ({ ...DEFAULT_POST_PROCESSING, enabled: false }),
      getDeepProjectionRoot: () => root, getDeepEditorOverlayRoots: () => [], setPresentationRendererBackend: vi.fn(), setPresentationPerformanceSource: vi.fn(),
      subscribePresentationFrames: (callback: () => void) => { authorFrames.add(callback); return () => authorFrames.delete(callback); },
    } as unknown as ViewerEngine;
    const metrics = { frame: 1, shadowTier: "exact", shadowMapSize: 1024, shadowCascadeCount: 1,
      shadowDepthBytes: 4 * 1024 * 1024 } as unknown as FrameMetrics;
    const runtime = { id: "deep-webgpu", setPacketValidated: vi.fn(async (_packet: RenderPacket) => {}),
      updateInstances: vi.fn((_update: InstanceUpdate) => {}), render: vi.fn(() => metrics),
      validateFrame: vi.fn(async () => metrics), dispose: vi.fn(),
      session: { state: "ready", device: { lost: new Promise(() => {}) } } };
    const constructorOptions: ConstructorParameters<typeof deep.ThreeProjectionBridge>[0][] = [];
    const createRuntime = vi.fn(async (_canvas: unknown, _gpu: unknown, _signal: AbortSignal, _options?: PbrRendererOptions) => runtime);
    const module = { ...deep,
      ThreeProjectionBridge: class extends deep.ThreeProjectionBridge {
        constructor(options: ConstructorParameters<typeof deep.ThreeProjectionBridge>[0]) { super(options); constructorOptions.push(options); }
      },
      DeepWebGpuBackend: { create: (request: Parameters<typeof deep.DeepWebGpuBackend.create>[0]) =>
        deep.DeepWebGpuBackend.create(request, { create: createRuntime }) },
    } as unknown as typeof deep;
    const container = { append: vi.fn(), clientWidth: 640, clientHeight: 480 };
    const bridge = new StudioDeepWebGpuBridge(viewer, container as unknown as HTMLElement,
      { loadModule: async () => module, onRuntimeFailure: failure }); bridges.push(bridge);
    return { bridge, author, root, scene, runtime, createRuntime, constructorOptions, authorCanvas, authorFrames, failure, container };
  }
  async function activate(f: ReturnType<typeof fixture>) {
    const pending = f.bridge.switchTo("webgpu"); await microtasks(); await frame();
    const result = await pending;
    expect(result, JSON.stringify(result)).toMatchObject({ status: "switched", activeBackend: "webgpu" });
    for (let i = 0; i < 18; i++) await frame();
  }
  async function notify(f: ReturnType<typeof fixture>) { for (const callback of f.authorFrames) callback(); await microtasks(); }

  it("enables both real projection and renderer deformation, then forwards changing and paused poses", async () => {
    const f = fixture(); await activate(f);
    expect(f.constructorOptions[0]!.capabilities).toEqual({ authorDeformation: true, authorLod: true });
    const renderer = f.createRuntime.mock.calls[0]![3]!;
    expect(renderer.deformation).toBe(true); expect(Object.isFrozen(renderer)).toBe(true);
    expect(renderer.meshlets).toBe(true);
    const initial = f.runtime.setPacketValidated.mock.calls[0]![0];
    expect(initial.deformation?.sources[0]!.kind).toBe("morph");
    const fullUploads = f.runtime.setPacketValidated.mock.calls.length;
    f.runtime.updateInstances.mockClear();
    const authorBuffer = f.author.geometry.morphAttributes.position![0]!.array.slice();
    f.author.morphTargetInfluences![0] = 0.75;
    await notify(f);
    const update = f.runtime.updateInstances.mock.calls.at(-1)![0];
    expect(update.poses![0]!.morphWeights!.values[0]).toBe(0.75);
    expect(update.instances[0]!.pose).toBe(update.poses![0]!.id);
    const revision = update.poses![0]!.revision;
    await notify(f);
    expect(f.runtime.updateInstances.mock.calls.at(-1)![0].poses![0]!.revision).toBe(revision);
    expect(f.runtime.setPacketValidated).toHaveBeenCalledTimes(fullUploads);
    expect(f.author.geometry.morphAttributes.position![0]!.array).toEqual(authorBuffer);
    expect(f.failure).not.toHaveBeenCalled();
  });

  it("keeps WebGL when animation packet preparation fails and releases the candidate", async () => {
    const f = fixture(); f.runtime.setPacketValidated.mockRejectedValueOnce(new Error("animation prepare failed"));
    const pending = f.bridge.switchTo("webgpu"); await microtasks();
    expect(await pending).toMatchObject({ status: "failed", activeBackend: "webgl", error: expect.stringContaining("animation prepare failed") });
    expect(f.runtime.setPacketValidated.mock.calls[0]![0].deformation?.poses).toHaveLength(1);
    expect(f.authorCanvas.style.opacity).toBe("1"); expect(f.runtime.dispose).toHaveBeenCalledOnce();
    expect(f.container.append.mock.calls[0]![0].remove).toHaveBeenCalledOnce();
    expect(f.authorFrames.size).toBe(0);
  });

  it("samples authored skin palettes and real tangent sources without updating the skeleton cache", async () => {
    const f = fixture(), geometry = new THREE.PlaneGeometry(2, 2), count = geometry.attributes.position!.count;
    const weights = new Float32Array(count * 4); for (let vertex = 0; vertex < count; vertex++) weights[vertex * 4] = 1;
    geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(new Uint16Array(count * 4), 4));
    geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weights, 4));
    const texture = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1); texture.needsUpdate = true;
    const skin = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ normalMap: texture })), bone = new THREE.Bone();
    skin.add(bone); skin.bind(new THREE.Skeleton([bone])); f.root.remove(f.author); f.root.add(skin);
    const updateSkeleton = vi.spyOn(skin.skeleton, "update");
    await activate(f);
    const initial = f.runtime.setPacketValidated.mock.calls[0]![0];
    expect(initial.deformation!.sources[0]!.kind).toBe("skin");
    expect(initial.deformation!.sources[0]!.skinning!.tangents).toEqual(initial.geometries[0]!.tangents);
    const fullUploads = f.runtime.setPacketValidated.mock.calls.length;
    bone.position.x = 2; await notify(f);
    const pose = f.runtime.updateInstances.mock.calls.at(-1)![0].poses![0]!;
    expect(pose.palette!.matrices[12]).toBe(2);
    expect(pose.palette!.normalMatrices).toBeInstanceOf(Float32Array);
    expect(updateSkeleton).not.toHaveBeenCalled(); expect(f.runtime.setPacketValidated).toHaveBeenCalledTimes(fullUploads);
    expect(geometry.attributes.skinWeight!.array).toEqual(weights);
  });

  it("restores author presentation after a real incremental pose transfer throws", async () => {
    const f = fixture(); await activate(f);
    f.runtime.updateInstances.mockImplementationOnce(() => { throw new Error("pose GPU upload failed"); });
    f.author.morphTargetInfluences![0] = 0.5; await notify(f);
    expect(f.runtime.updateInstances.mock.calls.at(-1)![0].poses![0]!.morphWeights!.values[0]).toBe(0.5);
    expect(f.bridge.activeBackend).toBe("webgl"); expect(f.authorCanvas.style.opacity).toBe("1");
    expect(f.runtime.dispose).toHaveBeenCalledOnce(); expect(f.authorFrames.size).toBe(0);
    expect(f.failure.mock.calls[0]![0].message).toContain("pose GPU upload failed");
  });
});
