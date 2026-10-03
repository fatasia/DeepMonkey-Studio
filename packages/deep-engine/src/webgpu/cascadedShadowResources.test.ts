import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CASCADED_SHADOW_UNIFORM_BYTES } from "../shadows/cascadedShadowShader.js";
import type { DeviceSession } from "./deviceSession.js";
import { CascadedShadowResources, PBR_CASCADE_COUNT, PBR_CASCADE_MAP_SIZE } from "./cascadedShadowResources.js";
import type { Pipelines } from "./pipelines.js";

interface FakeResource { readonly destroy: ReturnType<typeof vi.fn> }
function fixture(limitOverrides: Partial<{ maxTextureDimension2D: number; maxTextureArrayLayers: number }> = {}) {
  const owned = new Set<FakeResource>(), views: GPUTextureViewDescriptor[] = [], writes: ArrayBufferView[] = [];
  const bufferDescriptors: GPUBufferDescriptor[] = [];
  const texture = { destroy: vi.fn(), createView: vi.fn((descriptor: GPUTextureViewDescriptor = {}) => {
    views.push(descriptor); return { descriptor } as GPUTextureView;
  }) } as unknown as GPUTexture & FakeResource;
  const buffers: Array<GPUBuffer & FakeResource> = [];
  const device = {
    limits: { maxTextureDimension2D: 8192, maxTextureArrayLayers: 256, ...limitOverrides },
    queue: { writeBuffer: vi.fn((_buffer: GPUBuffer, _offset: number, data: ArrayBufferView) => writes.push(data)) },
    createTexture: vi.fn(() => texture), createSampler: vi.fn(() => ({ kind: "sampler" })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      bufferDescriptors.push(descriptor);
      const buffer = { destroy: vi.fn() } as unknown as GPUBuffer & FakeResource; buffers.push(buffer); return buffer;
    }),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => ({ descriptor })),
  };
  const session = { device, own<T extends FakeResource>(value: T) { owned.add(value); return value; },
    release(value: FakeResource) { if (owned.delete(value)) value.destroy(); } };
  const pipelines = { cascadedShadowLayout: { kind: "csm" },
    shadow: { getBindGroupLayout: vi.fn(() => ({ kind: "shadow" })) } } as unknown as Pipelines;
  return { session: session as unknown as DeviceSession, device, pipelines, texture, buffers, bufferDescriptors,
    owned, views, writes };
}

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { RENDER_ATTACHMENT: 1, TEXTURE_BINDING: 2 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 4, COPY_DST: 8 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const input = Object.freeze({ eye: [4, 3, 5] as const, target: [0, 0, 0] as const,
  verticalFovRadians: Math.PI / 3, aspect: 16 / 9, near: 0.1, far: 1_000, extent: 10 });

describe("default PBR cascaded shadow resources", () => {
  // B1 Brief-VSM:group 2 增补 binding 3..5 后,级联档持有 2 占位 storage buffer +
  // 1 占位 r32float atlas(4×4)。资源序:[ph0, ph1, uniform, frame0..N-1]。
  const VSM_PLACEHOLDER_BUFFERS = 2, VSM_PLACEHOLDER_TEXTURES = 1;
  it("borrows the real array and uniform with current enable state without allocating or owning a copy", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines);
    expect(() => shadows.godRaysSource()).toThrow("prepared");
    shadows.prepare(input, true, false); const count = f.owned.size, borrowed = shadows.godRaysSource();
    expect(borrowed.enabled).toBe(false); expect(borrowed.view).toHaveProperty("descriptor.dimension", "2d-array");
    expect(borrowed.uniform).toBe(f.buffers[VSM_PLACEHOLDER_BUFFERS]); expect(borrowed.sampler).toBe(shadows.sampler);
    shadows.prepare(input, true, true); expect(shadows.godRaysSource()).toEqual({ ...borrowed, enabled: true });
    expect(f.owned.size).toBe(count);
    expect(f.device.createTexture).toHaveBeenCalledTimes(1 + VSM_PLACEHOLDER_TEXTURES);
    const device = f.session.device; (f.session as { device: GPUDevice }).device = {} as GPUDevice;
    expect(() => shadows.godRaysSource()).toThrow("previous device"); (f.session as { device: GPUDevice }).device = device;
    shadows.dispose(); expect(f.owned.size).toBe(0); expect(() => shadows.godRaysSource()).toThrow("prepared");
  });
  it("uses authored matrix independently of main camera and updates signed sampling parameters", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines,
      { exactProfile: { cascadeCount: 1, shadowMapSize: 1024 } });
    const authored = { viewProjection: [0.2, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, -0.01, 0, 0, 0, 0, 1],
      mapSize: 1024, bias: -0.0001, normalBias: 0.015, intensity: 0.38, radius: 3 };
    const first = shadows.prepare({ ...input, authored, viewportHeight: 800 }, false);
    expect(first.plan.cascades[0]!.viewProjection).toEqual(new Float32Array(authored.viewProjection));
    expect(first.render).toBe(true); shadows.commit();
    expect(shadows.prepare({ ...input, eye: [40, 30, 50], authored, viewportHeight: 800 }, false).render).toBe(false);
    expect(shadows.prepare({ ...input, authored: { ...authored, intensity: 0 }, viewportHeight: 800 }, false).render).toBe(true);
    const uniform = f.writes.at(-2) as Float32Array;
    expect(uniform[149]).toBe(0); expect(uniform[153]).toBeCloseTo(-0.0001); expect(uniform[155]).toBe(2);
    expect(() => shadows.prepare({ ...input, authored: { ...authored, mapSize: 2048 } }, false)).toThrow("matching one-layer");
    shadows.dispose();
  });
  it("suppresses disabled shadow work even when forced and refreshes before re-enabling", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines);
    const binding = shadows.binding;
    expect(shadows.prepare(input, true, false).render).toBe(false);
    shadows.commit();
    expect(shadows.prepare(input, true, false).render).toBe(false);
    shadows.commit();
    expect(shadows.prepare(input, false, true).render).toBe(true);
    // A failed submission cannot publish the fresh shadow map.
    expect(shadows.prepare(input, false, true).render).toBe(true);
    shadows.commit();
    expect(shadows.prepare(input, false, true).render).toBe(false);
    expect(shadows.binding).toBe(binding);
    expect(f.device.createTexture).toHaveBeenCalledTimes(1 + VSM_PLACEHOLDER_TEXTURES);
    shadows.dispose();
  });
  it("refreshes an existing map after author changes while shadows are disabled", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines);
    shadows.prepare(input, false); shadows.commit();
    expect(shadows.prepare(input, true, false).render).toBe(false);
    shadows.commit();
    expect(shadows.prepare(input, false).render).toBe(true);
    shadows.commit();
    expect(shadows.prepare(input, false).render).toBe(false);
    shadows.dispose();
  });
  it("allocates one array map and isolated render views for all cascades", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines);
    expect(shadows.selection).toMatchObject({ requestedTier: "high", selectedTier: "high", downgraded: false });
    expect(f.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({
      size: { width: PBR_CASCADE_MAP_SIZE, height: PBR_CASCADE_MAP_SIZE, depthOrArrayLayers: PBR_CASCADE_COUNT }, format: "depth32float",
    }));
    expect(f.views.slice(0, PBR_CASCADE_COUNT)).toEqual(Array.from({ length: PBR_CASCADE_COUNT }, (_, baseArrayLayer) =>
      ({ dimension: "2d", aspect: "depth-only", baseArrayLayer, arrayLayerCount: 1 })));
    // B1 Brief-VSM:末位视图 = 占位 atlas(binding 5);数组视图在其前一位。
    expect(f.views.at(-1)).toEqual({ dimension: "2d-array" });
    expect(f.views.at(-2)).toEqual({ dimension: "2d-array", baseArrayLayer: 0, arrayLayerCount: PBR_CASCADE_COUNT });
    expect(shadows.frameBindings).toHaveLength(PBR_CASCADE_COUNT);
    expect(f.bufferDescriptors[VSM_PLACEHOLDER_BUFFERS]!.size).toBe(CASCADED_SHADOW_UNIFORM_BYTES);
  });

  it("uses the selected tier for texture layers, frame ABI and planner options", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines, { requestedTier: "performance" });
    expect(shadows.selection).toMatchObject({ selectedTier: "performance", downgraded: false,
      profile: { estimatedDepthTextureBytes: 8 * 1024 * 1024 } });
    expect(f.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ size: { width: 1024, height: 1024, depthOrArrayLayers: 2 } }));
    expect(shadows.layerViews).toHaveLength(2); expect(shadows.frameBindings).toHaveLength(2);
    expect(shadows.prepare(input, false).plan).toMatchObject({ shadowMapSize: 1024, cascades: [{ index: 0 }, { index: 1 }] });
  });

  it("supports an explicit one-layer 2048 comparison profile", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines,
      { exactProfile: { cascadeCount: 1, shadowMapSize: 2048, depthBias: 0.00075,
        receiverNormalBias: "constant-one-texel" } });
    expect(shadows.selection).toMatchObject({ selectedTier: "exact", downgraded: false,
      profile: { estimatedDepthTextureBytes: 16 * 1024 * 1024 } });
    expect(f.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ size: { width: 2048, height: 2048, depthOrArrayLayers: 1 } }));
    expect(shadows.prepare(input, false).plan.cascades).toHaveLength(1);
    const uniform = f.writes.at(-2) as Float32Array;
    expect(uniform[153]).toBeCloseTo(0.00075); expect(uniform[155]).toBe(1);
  });

  it("downgrades against memory and device limits before allocating", () => {
    const budget = fixture();
    const balanced = new CascadedShadowResources(budget.session, budget.pipelines,
      { requestedTier: "high", maxDepthTextureBytes: 40 * 1024 * 1024 });
    expect(balanced.selection).toMatchObject({ selectedTier: "balanced", downgraded: true });
    expect(budget.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ size: { width: 1536, height: 1536, depthOrArrayLayers: 3 } }));

    const limited = fixture({ maxTextureDimension2D: 1536, maxTextureArrayLayers: 2 });
    const performance = new CascadedShadowResources(limited.session, limited.pipelines, { requestedTier: "ultra" });
    expect(performance.selection.selectedTier).toBe("performance");
    expect(limited.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ size: { width: 1024, height: 1024, depthOrArrayLayers: 2 } }));
  });

  it("adapts to the live DeviceSession ownership budget before resource admission", () => {
    const f = fixture();
    Object.assign(f.session, { resourceMemory: { estimatedBytes: 16 * 1024 * 1024,
      admission: { budgetBytes: 64 * 1024 * 1024, rejectedCount: 0 } } });
    const shadows = new CascadedShadowResources(f.session, f.pipelines, { requestedTier: "high" });
    expect(shadows.selection).toMatchObject({ requestedTier: "high", selectedTier: "balanced", downgraded: true,
      rejected: [{ tier: "high", constraints: ["memory-budget"] }] });
    expect(f.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({
      size: { width: 1536, height: 1536, depthOrArrayLayers: 3 },
    }));
    shadows.dispose();
  });

  it("fails closed without allocating when no tier fits or options are malformed", () => {
    const limited = fixture({ maxTextureArrayLayers: 1 });
    expect(() => new CascadedShadowResources(limited.session, limited.pipelines)).toThrow("require at least 1024px");
    expect(limited.device.createTexture).not.toHaveBeenCalled(); expect(limited.owned.size).toBe(0);
    const invalid = fixture();
    expect(() => new CascadedShadowResources(invalid.session, invalid.pipelines, null as never)).toThrow("must be an object");
    expect(invalid.device.createTexture).not.toHaveBeenCalled();
  });

  it("updates camera-dependent data once and honors explicit scene dirtiness", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines);
    const initialWrites = f.writes.length;
    const first = shadows.prepare(input, false);
    expect(first.render).toBe(true); expect(first.plan.cascades).toHaveLength(PBR_CASCADE_COUNT);
    expect(first.plan.cascades.at(-1)!.far).toBeCloseTo(200);
    expect(f.writes).toHaveLength(initialWrites + 1 + PBR_CASCADE_COUNT);
    shadows.commit();
    expect(shadows.prepare(input, false)).toMatchObject({ render: false, plan: first.plan });
    expect(f.writes).toHaveLength(initialWrites + 1 + PBR_CASCADE_COUNT);
    expect(shadows.prepare(input, true)).toMatchObject({ render: true, plan: first.plan });
    expect(f.writes).toHaveLength(initialWrites + 1 + PBR_CASCADE_COUNT);
    shadows.invalidate(); expect(shadows.prepare(input, false).render).toBe(true);
  });

  it("releases every owned GPU allocation", () => {
    const f = fixture(), shadows = new CascadedShadowResources(f.session, f.pipelines);
    // fixture 的 fake createTexture 恒返回同一 texture 对象,owned Set 去重后
    // 占位 atlas 与级联图算 1(真机为独立纹理,释放路径同族覆盖)。
    expect(f.owned.size).toBe(1 + VSM_PLACEHOLDER_BUFFERS + 1 + PBR_CASCADE_COUNT);
    shadows.dispose(); shadows.dispose(); expect(f.owned.size).toBe(0);
    expect(f.texture.destroy).toHaveBeenCalledOnce();
    for (const buffer of f.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
    const writes = f.writes.length;
    expect(() => shadows.prepare(input, false)).toThrow("are disposed");
    expect(f.writes).toHaveLength(writes);
  });

  it("rolls back every owned allocation when ABI binding construction fails", () => {
    const f = fixture();
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("binding failed"); });
    expect(() => new CascadedShadowResources(f.session, f.pipelines)).toThrow("binding failed");
    expect(f.owned.size).toBe(0); expect(f.texture.destroy).toHaveBeenCalledOnce();
    for (const buffer of f.buffers) expect(buffer.destroy).toHaveBeenCalledOnce();
  });
});
