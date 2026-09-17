import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { LocalSpotShadowRuntime } from "./localSpotShadowRuntime.js";
import { DeviceResourceBudgetError } from "./deviceResourceMemory.js";
import type { Pipelines } from "./pipelines.js";
import { authorFixture, authorPacket, authorView } from "./authorLod.testUtils.js";
import { PBR_FRAME_UNIFORM_BYTES, PBR_FRAME_FLOAT_OFFSETS } from "./pipelines.js";

interface FakeTexture extends GPUTexture { descriptor: GPUTextureDescriptor; destroy: ReturnType<typeof vi.fn> }
interface FakeBuffer extends GPUBuffer { label: string; destroy: ReturnType<typeof vi.fn> }

function fixture(scopeError: { message: string } | null = null) {
  const owned = new Set<FakeTexture | FakeBuffer>(), textures: FakeTexture[] = [];
  const pass = { setViewport: vi.fn(), setScissorRect: vi.fn(), setPipeline: vi.fn(), setBindGroup: vi.fn(), end: vi.fn() };
  const device = {
    limits: { maxTextureDimension2D: 8192 },
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve(scopeError)),
    queue: { writeBuffer: vi.fn() },
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => {
      const texture = { descriptor, createView: vi.fn((view = {}) => ({ texture, view })),
        destroy: vi.fn() } as unknown as FakeTexture;
      textures.push(texture); return texture;
    }),
    createBuffer: vi.fn(({ label, size }: GPUBufferDescriptor) => ({ label, size, destroy: vi.fn() }) as unknown as FakeBuffer),
    createSampler: vi.fn((descriptor: GPUSamplerDescriptor) => ({ descriptor })),
    createBindGroup: vi.fn(({ entries }: GPUBindGroupDescriptor) => ({ entries })),
  };
  const session = { state: "ready", device,
    own<T extends FakeTexture | FakeBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: FakeTexture | FakeBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  const encoder = { beginRenderPass: vi.fn(() => pass) } as unknown as GPUCommandEncoder;
  const draw = vi.fn(() => ({ drawCalls: 2, triangles: 7 })), packets = { draw, encodeIndependentLod: vi.fn(() => undefined) };
  const pipelines = { shadow: { getBindGroupLayout: vi.fn(() => ({})) } } as unknown as Pipelines;
  return { device, session: session as unknown as DeviceSession, textures, encoder, pass, packets, draw, pipelines, owned };
}

const lights = () => ({
  points: [{ positionWorld: [0, 1, 0] as const, range: 5, color: [1, 1, 1] as const,
    intensity: 100, shadow: { key: "point", importance: 100 } }],
  spots: [{ positionWorld: [2, 3, 4] as const, directionWorld: [0, -1, 0] as const, range: 20,
    color: [1, 0.8, 0.6] as const, intensity: 4, innerConeCos: 0.9, outerConeCos: 0.7,
    shadow: { key: "hero-spot", importance: 10 } }],
});

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1, RENDER_ATTACHMENT: 2 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 4, COPY_DST: 8 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Browser local spot shadow runtime", () => {
  it("propagates ownership budget refusal without silently allocating a fallback", async () => {
    const f = fixture(), error = new DeviceResourceBudgetError("budget refused"), controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    f.session.assertResourceAdmission = vi.fn(() => { throw error; });
    await expect(LocalSpotShadowRuntime.create(f.session, controller.signal)).rejects.toBe(error);
    expect(f.device.createTexture).not.toHaveBeenCalled();
    expect(f.device.createBuffer).not.toHaveBeenCalled();
    expect(f.owned.size).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("uses isolated spot LOD outputs before the raster pass, never camera or CSM visibility", async () => {
    vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
    vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256 });
    const f = fixture(), g = authorFixture(), runtime = await LocalSpotShadowRuntime.create(f.session);
    Object.assign(f.pass, g.pass);
    const encoder = { beginComputePass: g.encoder.beginComputePass, beginRenderPass: f.encoder.beginRenderPass } as GPUCommandEncoder;
    const pipelines = { ...g.pipelines, shadow: f.pipelines.shadow } as Pipelines;
    g.cache.set(authorPacket([0, 1])); g.cache.encodeLod(g.encoder, authorView); g.cache.commitLodFrame();
    g.cache.draw(g.pass as unknown as GPURenderPassEncoder, pipelines, "opaque");
    const cameraArgs = g.pass.drawIndexedIndirect.mock.calls.map(call => call[0]); g.pass.drawIndexedIndirect.mockClear();
    const spot = lights().spots[0]!, two = { spots: [spot, { ...spot, positionWorld: [-2, 3, 4] as const,
      directionWorld: [1, 0, 0] as const, shadow: { key: "other", importance: 5 } }] };
    const writes = g.writes.length;
    const result = runtime.prepareAndEncode(encoder, g.cache, pipelines, two, false);
    expect(result).toMatchObject({ rendered: true, authorFrustumPasses: 4, authorFrustumDispatches: 8 });
    const args = g.pass.drawIndexedIndirect.mock.calls.map(call => call[0]);
    expect(args).toHaveLength(4); expect(new Set(args).size).toBe(4);
    for (const arg of args) expect(cameraArgs).not.toContain(arg);
    const frusta = g.writes.slice(writes).filter(write => write.label === "Deep culling frustum");
    expect(frusta).toHaveLength(4); expect([...new Float32Array(frusta[0]!.bytes)]).not.toEqual([...new Float32Array(frusta[2]!.bytes)]);
    expect(g.encoder.beginComputePass.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.encoder.beginRenderPass.mock.invocationCallOrder[0]!);
    runtime.commit(); const after = g.writes.length;
    const cached = runtime.prepareAndEncode(encoder, g.cache, pipelines, two, false);
    expect(cached.rendered).toBe(false); expect(cached.authorFrustumPasses ?? 0).toBe(0); expect(g.writes).toHaveLength(after);
    runtime.commit(); runtime.dispose(); g.cache.dispose(); expect(f.owned.size).toBe(0); expect(g.owned.size).toBe(0);
  });

  it("allocates the bounded shared atlas and publishes fixed binding resources", async () => {
    const f = fixture(), runtime = await LocalSpotShadowRuntime.create(f.session);
    expect(f.textures[0]?.descriptor).toMatchObject({ size: { width: 1024, height: 1024, depthOrArrayLayers: 1 },
      format: "depth32float", usage: 3 });
    expect(f.device.pushErrorScope).toHaveBeenCalledTimes(3);
    expect(runtime.bindings).toMatchObject({ uniform: expect.anything(), atlasView: expect.anything(), sampler: expect.anything() });
    expect(runtime.degraded).toBe(false);
    runtime.dispose(); runtime.dispose(); expect(f.owned.size).toBe(0);
  });

  it("renders one stable spot tile, uploads its matrix, and reuses an unchanged frame", async () => {
    const f = fixture(), runtime = await LocalSpotShadowRuntime.create(f.session);
    f.device.queue.writeBuffer.mockClear();
    const first = runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines, lights(), false);
    expect(first).toMatchObject({ rendered: true, drawCalls: 2, triangles: 7, shadowedSpotIndex: 0, degraded: false });
    expect(first.plan?.allocations.map(value => value.key)).toEqual(["hero-spot"]);
    expect(first.plan?.rejected).toContainEqual({ key: "point", kind: "point", requiredViews: 6, reason: "view-budget" });
    expect(f.pass.setViewport).toHaveBeenCalledWith(2, 2, 508, 508, 0, 1);
    expect(f.pass.setScissorRect).toHaveBeenCalledWith(2, 2, 508, 508);
    expect(f.draw).toHaveBeenCalledOnce(); expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(2);
    const metadata = f.device.queue.writeBuffer.mock.calls.find(call => (call[0] as GPUBuffer).label === "Deep local spot shadow data")?.[2] as Float32Array;
    const shadowFrame = f.device.queue.writeBuffer.mock.calls.find(call => (call[0] as GPUBuffer).label === "Deep local spot shadow frame 0")!;
    expect((shadowFrame[0] as GPUBuffer).size).toBe(PBR_FRAME_UNIFORM_BYTES);
    expect((shadowFrame[2] as Float32Array).byteLength).toBe(PBR_FRAME_UNIFORM_BYTES);
    expect([...(shadowFrame[2] as Float32Array).slice(PBR_FRAME_FLOAT_OFFSETS.lightViewProjection, PBR_FRAME_FLOAT_OFFSETS.lightViewProjection + 16)])
      .toEqual([...metadata.slice(0, 16)]);
    expect([...metadata.slice(16, 21)]).toEqual([2 / 1024, 2 / 1024, 508 / 1024, 508 / 1024, 0]);
    expect(metadata[21]).toBeCloseTo(0.001, 8); expect([...metadata.slice(22, 24)]).toEqual([1 / 1024, 1]);
    const projected = project(metadata.subarray(0, 16), [2, -2, 4]);
    expect(projected[0]).toBeCloseTo(0, 6); expect(projected[1]).toBeCloseTo(0, 6);
    expect(projected[2]).toBeGreaterThan(0); expect(projected[2]).toBeLessThan(1);
    runtime.commit(); f.device.queue.writeBuffer.mockClear();
    expect(runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines, lights(), false).rendered).toBe(false);
    expect(f.device.queue.writeBuffer).not.toHaveBeenCalled();
    const hero = lights().spots[0]!, reordered = { spots: [{ ...hero, shadow: { key: "fill-spot", importance: 1 } }, hero] };
    const remapped = runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines, reordered, false);
    expect(remapped.shadowedSpotIndex).toBe(1); expect(f.pass.setViewport).toHaveBeenCalledWith(2, 2, 508, 508, 0, 1);
    expect((f.device.queue.writeBuffer.mock.calls.find(call => (call[0] as GPUBuffer).label === "Deep local spot shadow data")?.[2] as Float32Array)[20]).toBe(1);
    expect(f.device.createTexture).toHaveBeenCalledOnce(); runtime.dispose();
  });

  it("keeps four importance-ranked keys on stable atlas tiles and bounds overflow", async () => {
    const f = fixture(), runtime = await LocalSpotShadowRuntime.create(f.session);
    const spot = (key: string, importance: number) => ({ positionWorld: [0, 0, 0] as const,
      directionWorld: [0, 0, -1] as const, range: 10, color: [1, 1, 1] as const, intensity: 1,
      innerConeCos: 0.8, outerConeCos: 0.7, shadow: { key, importance } });
    const authored = [spot("a", 5), spot("b", 4), spot("c", 3), spot("d", 2), spot("e", 1)];
    f.device.queue.writeBuffer.mockClear();
    const first = runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines, { spots: authored }, false);
    expect(first).toMatchObject({ rendered: true, drawCalls: 8, triangles: 28,
      shadowedSpotIndex: 0, shadowedSpotIndices: [0, 1, 2, 3] });
    expect(first.plan?.allocations.map(value => [value.key, value.tiles[0]?.slot])).toEqual([
      ["a", 0], ["b", 1], ["c", 2], ["d", 3],
    ]);
    expect(first.plan?.rejected).toContainEqual({ key: "e", kind: "spot", requiredViews: 1, reason: "light-budget" });
    expect(first.plan).toMatchObject({ maxShadowedLights: 4, maxShadowViews: 4, allocatedViewCount: 4,
      estimatedDepthTextureBytes: 4 * 1024 * 1024 });
    expect(f.pass.setViewport.mock.calls).toEqual([
      [2, 2, 508, 508, 0, 1], [514, 2, 508, 508, 0, 1],
      [2, 514, 508, 508, 0, 1], [514, 514, 508, 508, 0, 1],
    ]);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(4);
    runtime.commit(); f.pass.setViewport.mockClear(); f.device.queue.writeBuffer.mockClear();
    const reordered = runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines,
      { spots: [...authored].reverse() }, false);
    expect(reordered.shadowedSpotIndices).toEqual([4, 3, 2, 1]);
    expect(reordered.plan?.allocations.map(value => [value.key, value.tiles[0]?.slot])).toEqual([
      ["a", 0], ["b", 1], ["c", 2], ["d", 3],
    ]);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(4);
    const metadata = f.device.queue.writeBuffer.mock.calls.find(call => (call[0] as GPUBuffer).label === "Deep local spot shadow data")?.[2] as Float32Array;
    expect([metadata[20], metadata[44], metadata[68], metadata[92]]).toEqual([4, 3, 2, 1]);
    runtime.dispose();
  });

  it("restores committed metadata after an encoding failure", async () => {
    const f = fixture(), runtime = await LocalSpotShadowRuntime.create(f.session);
    runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines, lights(), false); runtime.commit();
    const committed = f.device.queue.writeBuffer.mock.calls.filter(call => (call[0] as GPUBuffer).label === "Deep local spot shadow data").at(-1)?.[2] as Float32Array;
    f.device.queue.writeBuffer.mockClear(); f.draw.mockImplementationOnce(() => { throw new Error("draw failed"); });
    const changed = lights(), moved = { spots: [{ ...changed.spots[0]!, positionWorld: [3, 3, 4] as const }] };
    expect(() => runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines, moved, false)).toThrow("draw failed");
    runtime.failFrame();
    expect([...(f.device.queue.writeBuffer.mock.calls.at(-1)?.[2] as Float32Array)]).toEqual([...committed]);
    expect(runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines, lights(), false).rendered).toBe(true);
    runtime.dispose();
  });

  it("reports a device-limited atlas downgrade without exceeding the fixed budget", async () => {
    const f = fixture(); f.device.limits.maxTextureDimension2D = 512;
    const runtime = await LocalSpotShadowRuntime.create(f.session);
    expect(runtime.degraded).toBe(true);
    expect(runtime.budget).toMatchObject({ width: 512, height: 512, allocatedDepthTextureBytes: 1024 * 1024,
      maxShadowedLights: 4, maxShadowViews: 4, downgraded: true });
    expect(runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines, lights(), false).degraded).toBe(true);
    runtime.dispose();
  });

  it("leaves points and unallocated lights fully lit and disables stale metadata", async () => {
    const f = fixture(), runtime = await LocalSpotShadowRuntime.create(f.session);
    runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines, lights(), false); runtime.commit();
    f.device.queue.writeBuffer.mockClear(); f.encoder.beginRenderPass.mockClear();
    const result = runtime.prepareAndEncode(f.encoder, f.packets as never, f.pipelines, { points: lights().points }, false);
    expect(result).toMatchObject({ rendered: false, shadowedSpotIndex: undefined });
    expect(f.encoder.beginRenderPass).not.toHaveBeenCalled(); expect(f.device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect((f.device.queue.writeBuffer.mock.calls[0]?.[2] as Float32Array).every(value => value === 0)).toBe(true);
    runtime.dispose();
  });

  it("falls back to disabled bindings when atlas validation fails and honors cancellation", async () => {
    const failed = fixture({ message: "simulated atlas failure" }), runtime = await LocalSpotShadowRuntime.create(failed.session);
    expect(runtime.degraded).toBe(true); expect(failed.textures.map(value => value.descriptor.size)).toEqual([
      { width: 1024, height: 1024, depthOrArrayLayers: 1 }, { width: 1, height: 1, depthOrArrayLayers: 1 },
    ]);
    expect(runtime.prepareAndEncode(failed.encoder, failed.packets as never, failed.pipelines, lights(), true).rendered).toBe(false);
    runtime.dispose(); expect(failed.owned.size).toBe(0);
    const cancelled = fixture(), controller = new AbortController(); controller.abort();
    await expect(LocalSpotShadowRuntime.create(cancelled.session, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.textures).toHaveLength(0); expect(cancelled.owned.size).toBe(0);
  });

  it("preserves a named Error AbortError without requiring DOMException", async () => {
    const f = fixture(), reason = new Error("cancelled validation"); reason.name = "AbortError";
    f.device.popErrorScope.mockRejectedValueOnce(reason);
    await expect(LocalSpotShadowRuntime.create(f.session)).rejects.toBe(reason);
    expect(f.textures).toHaveLength(1); expect(f.owned.size).toBe(0);
  });

  it("keeps an epoch on one device and advances it after device replacement", async () => {
    const first = fixture(), initial = await LocalSpotShadowRuntime.create(first.session);
    const epoch = initial.deviceEpoch; initial.dispose();
    const sameDevice = await LocalSpotShadowRuntime.create(first.session);
    expect(sameDevice.deviceEpoch).toBe(epoch); sameDevice.dispose();
    const replacement = fixture(), recovered = await LocalSpotShadowRuntime.create(replacement.session);
    expect(recovered.deviceEpoch).not.toBe(epoch); recovered.dispose();
    expect(first.owned.size).toBe(0); expect(replacement.owned.size).toBe(0);
  });
});

function project(matrix: Float32Array, point: readonly [number, number, number]): readonly [number, number, number] {
  const clip = [0, 1, 2, 3].map(row => matrix[row]! * point[0] + matrix[4 + row]! * point[1]
    + matrix[8 + row]! * point[2] + matrix[12 + row]!);
  return [clip[0]! / clip[3]!, clip[1]! / clip[3]!, clip[2]! / clip[3]!];
}
