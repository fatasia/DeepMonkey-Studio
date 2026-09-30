import { describe, expect, it, vi } from "vitest";
import { bridge, mesh } from "./testFixture.js";
import { view, deferred, runtime } from "./DeepWebGpuBackend.testUtils.js";
import { DeepWebGpuBackend, type DeepWebGpuRenderRuntime, type DeepWebGpuRuntimeFactory } from "./DeepWebGpuBackend.js";
import { CASCADED_SHADOW_QUALITY_PROFILES } from "../shadows/shadowQuality.js";

describe("DeepWebGpuBackend creation", () => {
  it.each(["lost", "recovering", "disposed", "degraded"])("rejects a cached first frame after session becomes %s", async state => {
    const session = { state: "ready", device: { lost: new Promise<never>(() => {}) } };
    const target = Object.assign(runtime(), { session });
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: { geometries: [], materials: [], instances: [] } }, { create: vi.fn(async () => target) });
    vi.mocked(target.validateFrame).mockClear(); session.state = state;
    await expect(backend.prepareView(view)).rejects.toThrow("GPU session is not ready");
    expect(target.validateFrame).not.toHaveBeenCalled(); backend.dispose();
  });
  it("rejects a cached first frame belonging to the previous device", async () => {
    const session = { state: "ready", device: { lost: new Promise<never>(() => {}) } };
    const target = Object.assign(runtime(), { session });
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: { geometries: [], materials: [], instances: [] } }, { create: vi.fn(async () => target) });
    vi.mocked(target.validateFrame).mockClear(); session.device = { lost: new Promise<never>(() => {}) };
    await expect(backend.prepareView(view)).rejects.toThrow("GPU device changed");
    expect(target.validateFrame).not.toHaveBeenCalled(); backend.dispose();
  });
  it("reuses the cached first frame on its ready original device", async () => {
    const session = { state: "ready", device: { lost: new Promise<never>(() => {}) } };
    const target = Object.assign(runtime(), { session });
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: { geometries: [], materials: [], instances: [] } }, { create: vi.fn(async () => target) });
    vi.mocked(target.validateFrame).mockClear(); await expect(backend.prepareView(view)).resolves.toMatchObject({ frame: 1 });
    expect(target.validateFrame).not.toHaveBeenCalled(); backend.dispose();
  });
  it.each([true, false])("snapshots the meshlets runtime option %s", async meshlets => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const renderer = { meshlets };
    const pending = DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer }, { create: createRuntime });
    renderer.meshlets = !meshlets;
    const backend = await pending;
    expect(createRuntime.mock.calls[0]![3]!.meshlets).toBe(meshlets); backend.dispose();
  });
  it.each([null, 1, "true", {}, []])("rejects malformed meshlets %j before creating runtime", async meshlets => {
    const createRuntime = vi.fn(async () => runtime());
    await expect(DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer: { meshlets } as never }, { create: createRuntime })).rejects.toThrow(/meshlets/);
    expect(createRuntime).not.toHaveBeenCalled();
  });
  it.each([true, false])("snapshots the explicit deformation capability %s", async deformation => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const renderer = { deformation };
    const pending = DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer }, { create: createRuntime });
    renderer.deformation = !deformation;
    const backend = await pending;
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied.deformation).toBe(deformation); expect(Object.isFrozen(supplied)).toBe(true);
    backend.dispose();
  });

  it.each([null, 0, 1, "true", {}, []])("rejects malformed deformation capability %j before creating a runtime", async deformation => {
    const createRuntime = vi.fn(async () => runtime());
    await expect(DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer: { deformation } as never }, { create: createRuntime }))
      .rejects.toThrow("deformation option must be boolean");
    expect(createRuntime).not.toHaveBeenCalled();
  });
  it.each([true, false])("snapshots the clusterLod runtime option %s (G1)", async clusterLod => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const renderer = { clusterLod };
    const pending = DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer }, { create: createRuntime });
    renderer.clusterLod = !clusterLod;
    const backend = await pending;
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied.clusterLod).toBe(clusterLod);
    expect(Object.isFrozen(supplied)).toBe(true);
    backend.dispose();
  });
  it.each([null, 1, "true", {}, []])("rejects malformed clusterLod %j before creating a runtime (G1)", async clusterLod => {
    const createRuntime = vi.fn(async () => runtime());
    await expect(DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer: { clusterLod } as never }, { create: createRuntime }))
      .rejects.toThrow("clusterLod option must be boolean");
    expect(createRuntime).not.toHaveBeenCalled();
  });
  it("creates the PBR runtime from a frozen renderer-settings snapshot", async () => {
    const target = runtime("performance", 8 * 1024 * 1024), createRuntime = vi.fn(async () => target);
    const factory: DeepWebGpuRuntimeFactory = { create: createRuntime };
    const renderer = { shadows: { requestedTier: "performance" as const, maxDepthTextureBytes: 16 * 1024 * 1024 } };
    const preparing = DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: {} as GPU,
      projection: bridge(), root: mesh(), view, renderer }, factory);
    renderer.shadows.maxDepthTextureBytes = 32 * 1024 * 1024;
    const backend = await preparing;
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied).toEqual({ shadows: { requestedTier: "performance", maxDepthTextureBytes: 16 * 1024 * 1024 } });
    expect(Object.isFrozen(supplied)).toBe(true); expect(Object.isFrozen(supplied.shadows)).toBe(true);
    expect(backend.shadowSelection).toEqual({ selectedTier: "performance", estimatedDepthTextureBytes: 8 * 1024 * 1024 });
  });

  it("keeps the legacy high-quality default when creation options are omitted", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view }, { create: createRuntime });
    expect(createRuntime.mock.calls[0]![3]).toEqual({});
    expect(backend.shadowSelection?.selectedTier).toBe("high");
  });

  it("accepts an immutable author packet without a Three projection or root", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const packet = { geometries: [], materials: [], instances: [] };
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: packet }, { create: createRuntime });
    expect(target.setPacketValidated).toHaveBeenCalledOnce();
    expect(backend.modelIdForInstanceId("missing")).toBeUndefined();
    await expect(backend.sync(mesh(), 1)).resolves.toMatchObject({ status: "committed", update: "instances" });
    backend.dispose();
  });

  it("keeps editor picking identity across packet publication and replacement", async () => {
    const target = runtime();
    const first = { geometries: [], materials: [], instances: [], objectBindings: [
      { nodeId: "model-a", instanceIds: ["a-1", "a-2"] },
      { nodeId: "model-b", instanceIds: ["b-1"] },
      { nodeId: "duplicate-binding", instanceIds: ["a-2"] },
    ] };
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: first }, { create: vi.fn(async () => target) });
    expect(backend.modelIdForInstanceId("a-2")).toBe("model-a");
    expect(backend.modelIdForInstanceId("b-1")).toBe("model-b");
    await backend.prepareRenderPacket({ ...first, objectBindings: [
      { nodeId: "model-c", instanceIds: ["c-1"] },
    ] }, view);
    expect(backend.modelIdForInstanceId("a-2")).toBeUndefined();
    expect(backend.modelIdForInstanceId("c-1")).toBe("model-c");
    backend.dispose();
    expect(backend.modelIdForInstanceId("c-1")).toBeUndefined();
  });

  it("snapshots feature and environment policy for a bridge-created runtime", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer: {
        features: { environment: false, bloom: false, spatialAa: false, toneMapping: "three-aces-r185" },
        environment: { kind: "studio" },
      } }, { create: createRuntime });
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied.features).toMatchObject({ environment: false, bloom: false, spatialAa: false, toneMapping: "three-aces-r185" });
    expect(supplied.environment).toEqual({ kind: "studio" });
    expect(Object.isFrozen(supplied.features)).toBe(true);
    expect(Object.isFrozen(supplied.environment)).toBe(true);
    backend.dispose();
  });

  it.each(["performance", "balanced", "high", "ultra"] as const)("forwards the %s shadow setting", async (tier) => {
    const bytes = CASCADED_SHADOW_QUALITY_PROFILES[tier].estimatedDepthTextureBytes;
    const target = runtime(tier, bytes), createRuntime = vi.fn(async () => target);
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer: { shadows: { requestedTier: tier,
        maxDepthTextureBytes: 300 * 1024 * 1024 } } }, { create: createRuntime });
    expect(createRuntime.mock.calls[0]![3]).toEqual({ shadows: {
      requestedTier: tier, maxDepthTextureBytes: 300 * 1024 * 1024,
    } });
    expect(backend.shadowSelection?.selectedTier).toBe(tier);
  });

  it("rejects malformed settings before requesting a GPU runtime", async () => {
    const createRuntime = vi.fn(async () => runtime()), request = {
      canvas: {} as HTMLCanvasElement, gpu: undefined, projection: bridge(), root: mesh(), view,
    };
    await expect(DeepWebGpuBackend.create({ ...request,
      renderer: { shadows: { requestedTier: "cinematic" as "high" } } }, { create: createRuntime }))
      .rejects.toThrow("Unknown cascaded shadow quality tier");
    await expect(DeepWebGpuBackend.create({ ...request,
      renderer: { shadows: { maxDepthTextureBytes: 0 } } }, { create: createRuntime }))
      .rejects.toThrow("Invalid maximum shadow depth bytes");
    await expect(DeepWebGpuBackend.create({ ...request,
      renderer: { typo: true } as never }, { create: createRuntime })).rejects.toThrow("Unknown Deep WebGPU renderer option");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("retires a runtime that arrives after creation was cancelled", async () => {
    const gate = deferred<DeepWebGpuRenderRuntime>(), target = runtime(), controller = new AbortController();
    const preparing = DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, signal: controller.signal }, { create: vi.fn(async () => gate.promise) });
    controller.abort(); gate.resolve(target);
    await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
    expect(target.dispose).toHaveBeenCalledOnce(); expect(target.setPacketValidated).not.toHaveBeenCalled();
  });

  it("retires a factory runtime whose identity violates the backend contract", async () => {
    const target = runtime(); Object.defineProperty(target, "id", { value: "other" });
    await expect(DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view }, { create: vi.fn(async () => target) })).rejects.toThrow("runtime id");
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("retires a runtime that reports an inconsistent shadow selection", async () => {
    const target = runtime("high", CASCADED_SHADOW_QUALITY_PROFILES.performance.estimatedDepthTextureBytes);
    await expect(DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view }, { create: vi.fn(async () => target) })).rejects.toThrow("expected");
    expect(target.dispose).toHaveBeenCalledOnce();
  });

  it("derives first-frame main pipeline keys from an independent render packet", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const packet = {
      geometries: [], materials: [
        { id: "m-texture", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1,
          baseColorTexture: { texture: "t", texCoord: 0 as const, uvTransform: [0, 0, 0, 0, 0, 0] as const } },
        { id: "m-plain", baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1, alphaMode: "BLEND" as const, doubleSided: true },
      ],
      instances: [
        { id: "i-1", geometry: "g", material: "m-texture", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        { id: "i-2", geometry: "g", material: "m-plain", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
      ],
    };
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      view, renderPacket: packet,
      renderer: { pipelines: { firstFrameSubset: true, deferDeformation: true } } }, { create: createRuntime });
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied.pipelines!.deferDeformation).toBe(true);
    expect(supplied.pipelines!.firstFrameMainKeys).toEqual(["material/depth/ccw", "plain/blend/double"]);
    expect(Object.isFrozen(supplied.pipelines!.firstFrameMainKeys)).toBe(true);
    backend.dispose();
  });

  it("keeps the full critical path when firstFrameSubset is set without a render packet", async () => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view,
      renderer: { pipelines: { firstFrameSubset: true, deferDeformation: true } } }, { create: createRuntime });
    const supplied = createRuntime.mock.calls[0]![3]!;
    expect(supplied.pipelines!.firstFrameMainKeys).toBeUndefined();
    expect(supplied.pipelines!.deferDeformation).toBe(true);
  });

  it.each([true, false])("snapshots the C13 recovery option %s", async recovery => {
    const target = runtime(), createRuntime = vi.fn(async () => target);
    const renderer = { recovery: recovery ? { maxAttempts: 3 } : undefined };
    const pending = DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer }, { create: createRuntime });
    renderer.recovery = recovery ? undefined : { maxAttempts: 3 };
    const backend = await pending;
    const supplied = createRuntime.mock.calls[0]![3]!;
    if (recovery) {
      expect(supplied.recovery).toEqual({ maxAttempts: 3 });
      expect(Object.isFrozen(supplied.recovery)).toBe(true);
    } else {
      expect(supplied.recovery).toBeUndefined();
    }
    backend.dispose();
  });
  it.each([null, 0, "3", [], { maxAttempts: 0 }, { backoffMs: -1 }])("rejects malformed C13 recovery %j before creating a runtime", async recovery => {
    const createRuntime = vi.fn(async () => runtime());
    await expect(DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view, renderer: { recovery } as never }, { create: createRuntime }))
      .rejects.toThrow();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("exposes session recovery hooks and tolerates their absence (C13)", async () => {
    const listeners: ((epoch: number) => void)[] = [];
    const target = runtime();
    (target as unknown as { session: unknown }).session = {
      onDeviceRecreated: (listener: (epoch: number) => void) => { listeners.push(listener); return () => {}; },
    };
    const backend = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view }, { create: vi.fn(async () => target) });
    const unsubscribe = backend.onDeviceRecreated(() => {});
    expect(listeners).toHaveLength(1);
    unsubscribe();
    backend.onFatalLoss(() => {});
    const bare = await DeepWebGpuBackend.create({ canvas: {} as HTMLCanvasElement, gpu: undefined,
      projection: bridge(), root: mesh(), view }, { create: vi.fn(async () => ({ ...target, session: undefined })) });
    expect(bare.onDeviceRecreated(() => {})).toBeTypeOf("function");
    expect(bare.onFatalLoss(() => {})).toBeTypeOf("function");
    bare.dispose(); backend.dispose();
  });

});
