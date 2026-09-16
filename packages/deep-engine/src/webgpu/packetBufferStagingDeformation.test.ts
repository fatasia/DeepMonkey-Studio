import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { deformationPacket } from "../renderPacketDeformation.testUtils.js";
import type { DeviceSession } from "./deviceSession.js";
import { MaterialBindingPool } from "./materialBindings.js";
import { TextureResources } from "./textureResources.js";
import { discardPacketBufferStage, stagePacketBuffers, type PacketBufferStagingContext } from "./packetBufferStaging.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, VERTEX: 8, UNIFORM: 16, INDEX: 32 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  const owned = new Set<GPUBuffer>(), allocated: GPUBuffer[] = [];
  const device = {
    limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28, maxComputeWorkgroupsPerDimension: 65_535 },
    queue: { writeBuffer: vi.fn() }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { ...descriptor, mapState: "unmapped", destroy: vi.fn() } as unknown as GPUBuffer;
      allocated.push(buffer); return buffer;
    }),
  };
  const session = { state: "ready", device, own(buffer: GPUBuffer) { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } } as unknown as DeviceSession;
  const textures = new TextureResources(session), materials = new MaterialBindingPool(session, undefined);
  const context: PacketBufferStagingContext = { session, textures, materials, geometries: new Map(), batches: new Map(),
    deformationEnabled: true };
  return { context, owned, allocated, device };
}

describe("packet deformation candidate ownership", () => {
  it("rejects unsupported executors before allocating", () => {
    const f = fixture();
    expect(() => stagePacketBuffers({ ...f.context, deformationEnabled: false }, prepareRenderPacket(deformationPacket())))
      .toThrow("not enabled");
    expect(f.device.createBuffer).not.toHaveBeenCalled();
  });

  it.each(["morph", "skin", "morph-skin"] as const)("discards the entire %s candidate exactly once", kind => {
    const f = fixture();
    const stage = stagePacketBuffers(f.context, prepareRenderPacket(deformationPacket(kind)));
    expect(stage.deformation).toBeDefined(); expect(stage.changed).toBe(true);
    expect(f.owned.size).toBeGreaterThan(4);
    discardPacketBufferStage(f.context, stage); discardPacketBufferStage(f.context, stage);
    expect(f.owned.size).toBe(0);
    for (const buffer of f.allocated) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it("releases deformation allocations when a later geometry upload fails", () => {
    const f = fixture();
    f.device.queue.writeBuffer.mockImplementation((buffer: GPUBuffer) => {
      if (buffer.label === "Deep vertices") throw new Error("geometry upload failed");
    });
    expect(() => stagePacketBuffers(f.context, prepareRenderPacket(deformationPacket()))).toThrow("geometry upload failed");
    expect(f.owned.size).toBe(0);
    for (const buffer of f.allocated) expect(buffer.destroy).toHaveBeenCalledOnce();
  });

  it("does not release borrowed active geometry when discarding a replacement pose", () => {
    const f = fixture(), prepared = prepareRenderPacket(deformationPacket());
    const active = stagePacketBuffers(f.context, prepared);
    const activeBuffers = new Set(f.owned);
    const nextContext = { ...f.context, geometries: active.geometries, batches: active.batches };
    const candidate = stagePacketBuffers(nextContext, prepared);
    expect(candidate.createdMeshes).toHaveLength(0);
    expect(candidate.createdBuffers).toHaveLength(0);
    expect(candidate.deformation).not.toBe(active.deformation);
    discardPacketBufferStage(nextContext, candidate);
    expect(f.owned).toEqual(activeBuffers);
    for (const buffer of activeBuffers) expect(buffer.destroy).not.toHaveBeenCalled();
    discardPacketBufferStage(f.context, active);
    expect(f.owned.size).toBe(0);
  });

  it("continues releasing geometry after a deformation destroy failure", () => {
    const f = fixture(), stage = stagePacketBuffers(f.context, prepareRenderPacket(deformationPacket()));
    vi.mocked(f.allocated[0]!.destroy).mockImplementationOnce(() => { throw new Error("destroy failed"); });
    expect(() => discardPacketBufferStage(f.context, stage)).toThrow("rollback failed");
    expect(f.owned.size).toBe(0);
    for (const buffer of f.allocated) expect(buffer.destroy).toHaveBeenCalledOnce();
  });
});
