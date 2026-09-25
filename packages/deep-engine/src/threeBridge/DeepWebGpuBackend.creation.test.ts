import { describe, expect, it, vi } from "vitest";
import { bridge, mesh } from "./testFixture.js";
import { view, deferred, runtime } from "./DeepWebGpuBackend.testUtils.js";
import { DeepWebGpuBackend, type DeepWebGpuRenderRuntime, type DeepWebGpuRuntimeFactory } from "./DeepWebGpuBackend.js";
import { CASCADED_SHADOW_QUALITY_PROFILES } from "../shadows/shadowQuality.js";

describe("DeepWebGpuBackend creation", () => {
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

});
