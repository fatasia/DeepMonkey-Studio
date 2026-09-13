import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { GPU_CULLING_MIN_INSTANCES, PacketBuffers } from "./packetBuffers.js";
import { mainPipelineKey, type Pipelines } from "./pipelines.js";

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1],
  [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] } as const;

function packet(alphaMode: "OPAQUE" | "BLEND", count: number): RenderPacket {
  return { geometries: [{ id: "g", revision: 0,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]) }],
  materials: [{ id: "m", baseColor: [0.5, 0.6, 0.7], metallic: 0, roughness: 0.5, alphaMode }],
  instances: Array.from({ length: count }, (_, index) => ({ id: `instance-${index}`,
    geometry: "g", material: "m", transform })) };
}

function fixture() {
  const owned = new Set<GPUBuffer>();
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxComputeWorkgroupsPerDimension: 65_535, maxTextureDimension2D: 16_384 },
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => ({ label, size, usage,
      mapState: "unmapped", destroy: vi.fn() } as unknown as GPUBuffer)),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})),
    createBindGroup: vi.fn(() => ({})), queue: { writeBuffer: vi.fn() } };
  const session = { state: "ready", device, own<T extends GPUBuffer>(value: T): T { owned.add(value); return value; },
    release(value: GPUBuffer): void { if (owned.delete(value)) value.destroy(); } } as unknown as DeviceSession;
  const cache = new PacketBuffers(session), pass = { setPipeline: vi.fn(), setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
  const pipelines = { mainPipelines: new Map([
    [mainPipelineKey("plain", false, "ccw"), "opaque"], [mainPipelineKey("plain", true, "ccw"), "blend"],
  ]), shadowPipelines: new Map() } as unknown as Pipelines;
  const compute = { setBindGroup: vi.fn(), setPipeline: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const encoder = { clearBuffer: vi.fn(), beginComputePass: vi.fn(() => compute) } as unknown as GPUCommandEncoder;
  return { cache, pass, pipelines, encoder };
}

function previousHiZ() {
  const texture = { width: 64, height: 32, depthOrArrayLayers: 1, mipLevelCount: 7, sampleCount: 1,
    dimension: "2d", format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING,
    createView: vi.fn(() => ({})) } as unknown as GPUTexture;
  const hiz = { texture, format: "r32float", width: 64, height: 32, mipLevelCount: 7,
    levels: Array.from({ length: 7 }, (_, level) => ({ level, width: Math.max(1, Math.floor(64 / 2 ** level)),
      height: Math.max(1, Math.floor(32 / 2 ** level)), view: {} as GPUTextureView })), sourceRevision: 0,
    reversedZ: false, reduction: "max", updated: true } as const;
  return { viewProjection: transform, cameraPosition: [0, 0, 5] as const,
    viewport: [64, 32] as const, hiz, reversedZ: false };
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8, STORAGE: 128, COPY_SRC: 4, INDIRECT: 256 });
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 }); vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("packet Hi-Z and OIT visibility", () => {
  it("reuses camera frustum visibility for batched weighted OIT and keeps BLEND out of shadows", () => {
    const f = fixture(); f.cache.set(packet("BLEND", GPU_CULLING_MIN_INSTANCES));
    const shadow = f.cache.encodeCulling(f.encoder, frustum, "shadow");
    expect(shadow).toEqual({ phase: "shadow", frustumBatches: 0, occlusionBatches: 0 });
    expect(f.encoder.beginComputePass).not.toHaveBeenCalled();
    const opaque = f.cache.encodeCulling(f.encoder, frustum, "opaque");
    expect(opaque).toEqual({ phase: "opaque", frustumBatches: 1, occlusionBatches: 0 });
    f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "transparent", undefined, true);
    expect(f.encoder.beginComputePass).toHaveBeenCalledOnce(); expect(f.pass.drawIndexedIndirect).toHaveBeenCalledOnce();
  });

  it("compacts previous-frame Hi-Z visibility into both PBR vertex streams", () => {
    const f = fixture(); f.cache.set(packet("OPAQUE", 128));
    const stats = f.cache.encodeCulling(f.encoder, frustum, "opaque",
      { sceneRevision: 1, previousHiZ: previousHiZ() });
    expect(stats).toEqual({ phase: "opaque", frustumBatches: 0, occlusionBatches: 1 });
    f.cache.draw(f.pass as unknown as GPURenderPassEncoder, f.pipelines, "opaque", undefined, true);
    expect(f.encoder.beginComputePass).toHaveBeenCalledTimes(2); expect(f.pass.drawIndexedIndirect).toHaveBeenCalledOnce();
    const label = (slot: number) => (f.pass.setVertexBuffer.mock.calls.find(call => call[0] === slot)![1] as GPUBuffer & { label?: string }).label;
    expect([label(1), label(2)]).toEqual(["Deep Hi-Z compacted instances", "Deep Hi-Z compacted previous transforms"]);
  });
});
