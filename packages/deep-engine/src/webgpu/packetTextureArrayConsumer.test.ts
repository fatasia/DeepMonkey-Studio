import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { PacketTextureArrayConsumer } from "./packetTextureArrayConsumer.js";
import { drawPacketBatches } from "./packetDraw.js";
import type { PacketCullingResources } from "./packetCulling.js";
import type { Pipelines } from "./pipelines.js";
import type { TextureResources } from "./textureResources.js";

beforeEach(() => {
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, STORAGE: 128, COPY_DST: 8 });
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2 });
});
afterEach(() => vi.unstubAllGlobals());

const slot = (texture: string) => ({ texture, texCoord: 0 as const,
  uvTransform: [1, 0, 0, 0, 1, 0] as const });

function fixture(maxArrayLayers = 1) {
  const owned = new Set<{ destroy(): void }>(), sampler = {} as GPUSampler;
  const device = {
    limits: { maxTextureArrayLayers: maxArrayLayers, minUniformBufferOffsetAlignment: 256 },
    createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({ descriptor, destroy: vi.fn(),
      createView: vi.fn(() => ({})) })),
    createSampler: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createBindGroup: vi.fn(descriptor => ({ descriptor })),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => ({ ...descriptor, destroy: vi.fn() })),
    queue: { writeTexture: vi.fn(), writeBuffer: vi.fn() },
  };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(value: T) { owned.add(value); return value; },
    release(value: { destroy(): void }) { if (owned.delete(value)) value.destroy(); },
  } as unknown as DeviceSession;
  const textures = {
    stagedArrayEntries: () => [
      { textureId: "a", format: "rgba8unorm", width: 1, height: 1 },
      { textureId: "b", format: "rgba8unorm", width: 1, height: 1 },
    ],
    stagedArrayLayer: () => ({ mipLevelCount: 1, sampler,
      levels: [{ data: new Uint8Array(4), bytesPerRow: 4, width: 1, height: 1 }] }),
  } as unknown as TextureResources;
  const batch = (key: string, texture: string): CachedPacketBatch => ({ source: {
    key, geometry: "g", instanceIds: [key], mirrored: false, doubleSided: false, alphaMode: "OPAQUE",
    data: new Float32Array(36), count: 1, textures: { emissiveStrength: 1, baseColor: slot(texture) },
  }, buffer: {} as GPUBuffer, previousBuffer: {} as GPUBuffer, capacity: 1, previousCapacity: 1,
  previousTransforms: new Float32Array(), material: { group: { key: `d2-${key}` } } as never });
  return { session, device, owned, textures, batches: new Map([["a", batch("a", "a")], ["b", batch("b", "b")]]) };
}

describe("packet texture-array consumer", () => {
  it("publishes compatible rows and leaves overflow on the D2 fallback", () => {
    const f = fixture(), consumer = new PacketTextureArrayConsumer(f.session, {} as GPUBindGroupLayout);
    const stage = consumer.stage(f.textures, {} as never, [...f.batches.values()].map(batch => batch.source));
    expect(stage.rows.get("a")?.materialRow).toBe(0);
    expect(stage.rows.get("b")).toBeUndefined();
    consumer.publish(stage); consumer.clear();
    expect(f.owned.size).toBe(0);
  });

  it("packs the table row into reserved instance flag bits and preserves low flags", () => {
    const f = fixture(2), consumer = new PacketTextureArrayConsumer(f.session, {} as GPUBindGroupLayout);
    f.batches.get("a")!.source.data[31] = 257;
    f.batches.get("b")!.source.data[31] = 9;
    const stage = consumer.stage(f.textures, {} as never, [...f.batches.values()].map(batch => batch.source));
    expect(stage.batches.find(batch => batch.key === "a")!.data[31]).toBe(257);
    expect(stage.batches.find(batch => batch.key === "b")!.data[31]).toBe(1024 + 9);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(1); // one shared table; instance buffers upload once downstream
    consumer.rollback(stage);
    expect(f.owned.size).toBe(0);
  });

  it("reuses the active table for instance-only updates without another table upload", () => {
    const f = fixture(2), consumer = new PacketTextureArrayConsumer(f.session, {} as GPUBindGroupLayout);
    const original = [...f.batches.values()].map(batch => batch.source);
    const stage = consumer.stage(f.textures, {} as never, original); consumer.publish(stage);
    f.device.queue.writeBuffer.mockClear();
    const updated = original.map(batch => ({ ...batch, data: new Float32Array(batch.data) }));
    updated[0]!.data[0] = 2;
    const decorated = consumer.decorateCurrent(updated)!;
    expect(decorated[1]!.data[31]).toBe(1024);
    expect(f.device.queue.writeBuffer).not.toHaveBeenCalled();
    expect(consumer.decorateCurrent(updated.map((batch, index) => index ? batch
      : { ...batch, textures: { ...batch.textures!, emissiveStrength: 2 } }))).toBeUndefined();
    consumer.clear(); expect(f.owned.size).toBe(0);
  });

  it("draws indexed shared rows and selects the fallback pipeline per material", () => {
    const group = {} as GPUBindGroup, f = fixture();
    const rows = [0, 1].map(materialRow => ({ group, materialRow,
      arrayKey: "0|-|-|-|-", textureEntries: [], table: {} as GPUBuffer }));
    const arrayMain = {}, fallbackMain = {};
    const fallback = { mainPipelines: new Map([["material/depth/ccw", fallbackMain]]) } as unknown as Pipelines;
    const pipelines = { mainPipelines: new Map([["material/depth/ccw", arrayMain]]), textureArrayFallback: fallback } as unknown as Pipelines;
    const batches = new Map([...f.batches].map(([key, batch], index) => [key,
      index === 0 ? { ...batch, arrayMaterial: rows[0] } : batch]));
    batches.set("c", { ...f.batches.get("a")!, source: { ...f.batches.get("a")!.source, key: "c" }, arrayMaterial: rows[1] as never });
    const mesh = { indexCount: 3, draw: vi.fn() };
    const geometries = new Map([["g", { mesh } as unknown as CachedPacketGeometry]]);
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn() };
    drawPacketBatches(pass as unknown as GPURenderPassEncoder, pipelines, "opaque", batches, geometries,
      { phase: vi.fn() } as unknown as PacketCullingResources);
    expect(pass.setPipeline.mock.calls.map(call => call[0])).toEqual([arrayMain, fallbackMain, arrayMain]);
    expect(pass.setBindGroup.mock.calls).toEqual([[1, group], [1, { key: "d2-b" }], [1, group]]);
  });

  it("binds one shared table once across adjacent array material rows", () => {
    const group = {} as GPUBindGroup, f = fixture();
    const rows = [0, 1].map(materialRow => ({ group, materialRow,
      arrayKey: "0|-|-|-|-", textureEntries: [], table: {} as GPUBuffer }));
    const arrayMain = {};
    const pipelines = { mainPipelines: new Map([["material/depth/ccw", arrayMain]]),
      textureArrayFallback: { mainPipelines: new Map() } } as unknown as Pipelines;
    const batches = new Map([...f.batches].map(([key, batch], index) => [key,
      { ...batch, arrayMaterial: rows[index] as never }]));
    const mesh = { indexCount: 3, draw: vi.fn() };
    const geometries = new Map([["g", { mesh } as unknown as CachedPacketGeometry]]);
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn() };
    drawPacketBatches(pass as unknown as GPURenderPassEncoder, pipelines, "opaque", batches, geometries,
      { phase: vi.fn() } as unknown as PacketCullingResources);
    expect(pass.setPipeline).toHaveBeenCalledTimes(1);
    expect(pass.setBindGroup.mock.calls).toEqual([[1, group]]);
    expect(mesh.draw).toHaveBeenCalledTimes(2);
  });
});
