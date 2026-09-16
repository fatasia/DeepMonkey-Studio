import { vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { PacketBuffers } from "./packetBuffers.js";
import { mainPipelineKey, shadowPipelineKey, type Pipelines } from "./pipelines.js";
export function authorPacket(selectedLevels = [1], revision = 1): RenderPacket {
  return { geometries: ["high", "low"].map((id, index) => ({ id, revision: 0,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    indices: new Uint32Array(index ? [0, 1, 2] : [0, 1, 2, 0, 1, 2]) })),
    materials: [{ id: "m", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
    instances: [{ id: "author", geometry: "high", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1],
      lod: { strategy: "author-selected", revision, levels: [{ geometry: "high", distance: 0, hysteresis: .1 },
        { geometry: "low", distance: 10, hysteresis: .2 }], selectedLevels } }] };
}
export function authorFixture() {
  const owned = new Set<GPUBuffer>();
  const writes: Array<{ label: string; buffer: GPUBuffer; bytes: ArrayBuffer }> = [];
  const device = { limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 28, maxComputeWorkgroupsPerDimension: 65535 },
    createBuffer: vi.fn((d: GPUBufferDescriptor) => ({ ...d, mapState: "unmapped", destroy: vi.fn() }) as unknown as GPUBuffer),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})), pushErrorScope: vi.fn(),
    popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    queue: { writeBuffer: vi.fn((buffer: GPUBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => {
      writes.push({ buffer, label: buffer.label, bytes: data instanceof ArrayBuffer ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
    }) } };
  const session = { state: "ready", device, own<T extends GPUBuffer>(buffer: T) { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } } as unknown as DeviceSession;
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
  const encoder = { beginComputePass: vi.fn(() => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} })) } as unknown as GPUCommandEncoder;
  const pipelines = { mainPipelines: new Map([[mainPipelineKey("plain", false, "ccw"), {}]]),
    shadowPipelines: new Map([[shadowPipelineKey("solid", "ccw"), {}]]) } as unknown as Pipelines;
  return { session, device, owned, writes, pass, encoder, pipelines, cache: new PacketBuffers(session) };
}
export const authorView = { camera: { projection: "perspective" as const, position: [0, 0, 0] as const,
  forward: [0, 0, 1] as const, verticalFovRadians: Math.PI / 2, near: .1, far: 1000 }, viewport: { width: 800, height: 600 },
  frustum: { planes: [[1, 0, 0, 100], [-1, 0, 0, 100], [0, 1, 0, 100], [0, -1, 0, 100], [0, 0, 1, 100], [0, 0, -1, 100]] as const } };
