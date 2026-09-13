import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { GPU_CULLING_MIN_INSTANCES, PacketBuffers } from "./packetBuffers.js";
import { mainPipelineKey, shadowPipelineKey, type Pipelines } from "./pipelines.js";

function fixture() {
  const owned = new Set<GPUBuffer>(), allocated: GPUBuffer[] = [];
  const contents = new Map<GPUBuffer, number[]>(), bindGroups: GPUBindGroupDescriptor[] = [];
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxComputeWorkgroupsPerDimension: 65_535, maxTextureDimension2D: 16_384 },
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => {
      const buffer = { label, size, usage, mapState: "unmapped", destroy: vi.fn() } as unknown as GPUBuffer;
      allocated.push(buffer); return buffer;
    }),
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => { bindGroups.push(descriptor); return {}; }),
    queue: { writeBuffer: vi.fn((buffer: GPUBuffer, _offset: number, data: ArrayBuffer | Float32Array | Uint32Array) => {
      contents.set(buffer, Array.from(data instanceof ArrayBuffer ? new Float32Array(data) : data));
    }) } };
  const session = { state: "ready", device, own(buffer: GPUBuffer) { owned.add(buffer); return buffer; },
    release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } };
  const cache = new PacketBuffers(session as unknown as DeviceSession);
  const pass = { setPipeline: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
  const mainPipelines = new Map<string, GPURenderPipeline>([
    [mainPipelineKey("plain", false, "ccw"), "main" as unknown as GPURenderPipeline],
    [mainPipelineKey("plain", false, "cw"), "mirror" as unknown as GPURenderPipeline],
    [mainPipelineKey("plain", false, "double"), "double" as unknown as GPURenderPipeline],
    [mainPipelineKey("plain", true, "ccw"), "blend" as unknown as GPURenderPipeline],
    [mainPipelineKey("plain", true, "cw"), "blendMirror" as unknown as GPURenderPipeline],
    [mainPipelineKey("plain", true, "double"), "blendDouble" as unknown as GPURenderPipeline],
  ]);
  const shadowPipelines = new Map<string, GPURenderPipeline>([
    [shadowPipelineKey("solid", "ccw"), "shadow" as unknown as GPURenderPipeline],
    [shadowPipelineKey("solid", "cw"), "shadowMirror" as unknown as GPURenderPipeline],
    [shadowPipelineKey("solid", "double"), "shadowDouble" as unknown as GPURenderPipeline],
    [shadowPipelineKey("maskPlain", "ccw"), "shadowMask" as unknown as GPURenderPipeline],
    [shadowPipelineKey("maskPlain", "double"), "shadowMaskDouble" as unknown as GPURenderPipeline],
  ]);
  const pipelines = { main: "main", shadow: "shadow", mainPipelines, shadowPipelines } as unknown as Pipelines;
  const draw = (shadow = false) => cache.draw(pass as unknown as GPURenderPassEncoder, pipelines, shadow ? "shadow" : "opaque");
  const byLabel = (label: string) => allocated.filter(buffer =>
    (buffer as GPUBuffer & { label?: string }).label === label);
  return { cache, device, session, owned, allocated, contents, bindGroups, pass, pipelines, draw, byLabel };
}
const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function packet(revision = 0): RenderPacket {
  return { geometries: [{ id: "g", revision, vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "m", baseColor: [0.5, 0.6, 0.7], metallic: 0, roughness: 0.5 }],
    instances: [{ id: "i", geometry: "g", material: "m", transform }] };
}

function expectCompleteCullingBundle(buffers: readonly GPUBuffer[]): void {
  const count = (label: string) => buffers.filter(buffer =>
    (buffer as GPUBuffer & { label?: string }).label === label).length;
  for (const label of ["Deep culling input", "Deep culling previous transforms", "Deep culling bounds", "Deep culling parameters"])
    expect(count(label)).toBe(1);
  for (const label of ["Deep culling compacted instances", "Deep culling compacted previous transforms",
    "Deep culling frustum", "Deep culling counter", "Deep culling indirect arguments"])
    expect(count(label)).toBe(2);
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8, STORAGE: 128, COPY_SRC: 4, INDIRECT: 256 });
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("packet GPU culling and draw dispatch", () => {
  it("uses direct draws below the GPU culling break-even threshold and compute/indirect at the threshold", () => {
    const small = fixture(), p = packet();
    small.cache.set({ ...p, instances: Array.from({ length: GPU_CULLING_MIN_INSTANCES - 1 }, (_, index) => ({
      ...p.instances[0]!, id: `small-${index}`,
    })) });
    const smallCompute = { beginComputePass: vi.fn() };
    const smallStats = small.cache.encodeCulling(smallCompute as unknown as GPUCommandEncoder,
      { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] }, "opaque");
    small.cache.draw(small.pass as unknown as GPURenderPassEncoder, {
      mainPipelines: new Map([[mainPipelineKey("plain", false, "ccw"), "main"]]), shadowPipelines: new Map(),
    } as unknown as Pipelines, "opaque", undefined, true);
    expect(smallCompute.beginComputePass).not.toHaveBeenCalled();
    expect(smallStats).toEqual({ phase: "opaque", frustumBatches: 0, occlusionBatches: 0 });
    expect(small.pass.drawIndexed).toHaveBeenCalledOnce();
    expect(small.pass.drawIndexedIndirect).not.toHaveBeenCalled();

    const large = fixture();
    large.cache.set({ ...p, instances: Array.from({ length: GPU_CULLING_MIN_INSTANCES }, (_, index) => ({
      ...p.instances[0]!, id: `large-${index}`,
    })) });
    const computePass = { setBindGroup: vi.fn(), setPipeline: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const largeEncoder = { beginComputePass: vi.fn(() => computePass) };
    const largeStats = large.cache.encodeCulling(largeEncoder as unknown as GPUCommandEncoder,
      { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] }, "opaque");
    large.cache.draw(large.pass as unknown as GPURenderPassEncoder, {
      mainPipelines: new Map([[mainPipelineKey("plain", false, "ccw"), "main"]]), shadowPipelines: new Map(),
    } as unknown as Pipelines, "opaque", undefined, true);
    expect(largeEncoder.beginComputePass).toHaveBeenCalledOnce();
    expect(largeStats).toEqual({ phase: "opaque", frustumBatches: 1, occlusionBatches: 0 });
    expect(computePass.dispatchWorkgroups).toHaveBeenCalledTimes(2);
    expect(large.pass.drawIndexed).not.toHaveBeenCalled();
    expect(large.pass.drawIndexedIndirect).toHaveBeenCalledOnce();
  });
  it("uploads one stable culling source while keeping shadow and opaque outputs isolated", () => {
    const f = fixture(), p = packet();
    const instances = Array.from({ length: GPU_CULLING_MIN_INSTANCES }, (_, index) => ({
      ...p.instances[0]!, id: `large-${index}`,
    }));
    f.cache.set({ ...p, instances });
    const moved = instances.map(instance => ({ ...instance,
      transform: [...transform.slice(0, 12), 2, 0, 0, 1] }));
    f.cache.updateInstances({ materials: p.materials, instances: moved });
    f.device.queue.writeBuffer.mockClear();
    const computePass = { setBindGroup: vi.fn(), setPipeline: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const encoder = { beginComputePass: vi.fn(() => computePass) } as unknown as GPUCommandEncoder;
    const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] } as const;
    f.cache.encodeCulling(encoder, frustum, "shadow");
    f.cache.encodeCulling(encoder, frustum, "opaque");
    const culling = f.allocated.filter(buffer => String((buffer as GPUBuffer & { label?: string }).label).startsWith("Deep culling"));
    expectCompleteCullingBundle(culling);
    const input = f.byLabel("Deep culling input")[0]!, previous = f.byLabel("Deep culling previous transforms")[0]!;
    expect(f.contents.get(input)![3]).toBe(2); expect(f.contents.get(previous)![3]).toBe(0);
    const stable = new Set([input, previous, f.byLabel("Deep culling bounds")[0]!, f.byLabel("Deep culling parameters")[0]!]);
    expect(f.device.queue.writeBuffer.mock.calls.filter(([buffer]) => stable.has(buffer))).toHaveLength(4);
    expect(encoder.beginComputePass).toHaveBeenCalledTimes(2);
    expect(computePass.dispatchWorkgroups).toHaveBeenCalledTimes(4);
    f.cache.draw(f.pass as unknown as GPURenderPassEncoder, {
      mainPipelines: new Map([[mainPipelineKey("plain", false, "ccw"), "main"]]), shadowPipelines: new Map(),
    } as unknown as Pipelines, "opaque", undefined, true);
    expect(f.pass.drawIndexedIndirect).toHaveBeenCalledOnce();
    const currentOutput = f.pass.setVertexBuffer.mock.calls.find(call => call[0] === 1)![1] as GPUBuffer;
    const previousOutput = f.pass.setVertexBuffer.mock.calls.find(call => call[0] === 2)![1] as GPUBuffer;
    expect((currentOutput as GPUBuffer & { label?: string }).label).toBe("Deep culling compacted instances");
    expect((previousOutput as GPUBuffer & { label?: string }).label).toBe("Deep culling compacted previous transforms");
    const entries = f.bindGroups.at(-1)!.entries;
    const bound = (binding: number) => (entries.find(entry => entry.binding === binding)!.resource as GPUBufferBinding).buffer;
    expect(bound(2)).toBe(currentOutput); expect(bound(8)).toBe(previousOutput);
    expect(f.cache.commitFrame()).toBe(true);
    expect(f.contents.get(f.byLabel("Deep packet previous transforms")[0]!)![3]).toBe(2);
    expect(f.contents.get(previous)![3]).toBe(2);
  });
  it("creates one compute pipeline context for multiple material batches", () => {
    const f = fixture(), p = packet();
    const instances = [
      ...Array.from({ length: GPU_CULLING_MIN_INSTANCES }, (_, index) => ({ ...p.instances[0]!, id: `normal-${index}` })),
      ...Array.from({ length: GPU_CULLING_MIN_INSTANCES }, (_, index) => ({
        ...p.instances[0]!, id: `mirrored-${index}`, transform: [-1, ...transform.slice(1)],
      })),
    ];
    const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] } as const;
    const compute = { setBindGroup: vi.fn(), setPipeline: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const encoder = { beginComputePass: vi.fn(() => compute) } as unknown as GPUCommandEncoder;
    f.cache.set({ ...p, instances });
    f.cache.encodeCulling(encoder, frustum, "shadow"); f.cache.encodeCulling(encoder, frustum, "opaque");
    expect(f.device.createShaderModule).toHaveBeenCalledOnce();
    expect(f.device.createBindGroupLayout).toHaveBeenCalledOnce();
    expect(f.device.createPipelineLayout).toHaveBeenCalledOnce();
    expect(f.device.createComputePipeline).toHaveBeenCalledTimes(2);
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(4);
    expect(f.byLabel("Deep culling input")).toHaveLength(2);
    expect(f.byLabel("Deep culling previous transforms")).toHaveLength(2);
    expect(f.byLabel("Deep culling bounds")).toHaveLength(2);
    expect(f.byLabel("Deep culling compacted instances")).toHaveLength(4);
    expect(f.byLabel("Deep culling compacted previous transforms")).toHaveLength(4);
  });
  it("reuses shared capacity after a shrink and releases it below the culling threshold", () => {
    const f = fixture(), p = packet();
    const makeInstances = (count: number) => Array.from({ length: count }, (_, index) => ({ ...p.instances[0]!, id: `item-${index}` }));
    const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] } as const;
    const pass = { setBindGroup: vi.fn(), setPipeline: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const encoder = { beginComputePass: vi.fn(() => pass) } as unknown as GPUCommandEncoder;
    f.cache.set({ ...p, instances: makeInstances(65) });
    f.cache.encodeCulling(encoder, frustum, "shadow"); f.cache.encodeCulling(encoder, frustum, "opaque");
    const cullingBuffers = () => f.allocated.filter(buffer => String((buffer as GPUBuffer & { label?: string }).label).startsWith("Deep culling"));
    const first = cullingBuffers(); expectCompleteCullingBundle(first);
    f.cache.updateInstances({ materials: p.materials, instances: makeInstances(64) });
    f.cache.encodeCulling(encoder, frustum, "shadow"); f.cache.encodeCulling(encoder, frustum, "opaque");
    expect(cullingBuffers()).toEqual(first);
    expect(first.every(buffer => !(buffer as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy.mock.calls.length)).toBe(true);
    f.cache.updateInstances({ materials: p.materials, instances: makeInstances(GPU_CULLING_MIN_INSTANCES - 1) });
    expect(first.every(buffer => (buffer as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy.mock.calls.length === 1)).toBe(true);
    f.cache.encodeCulling(encoder, frustum, "opaque");
    expect(encoder.beginComputePass).toHaveBeenCalledTimes(4);
  });
  it("grows shared capacity transactionally and disposes it when the batch is deleted", () => {
    const f = fixture(), p = packet();
    const makeInstances = (count: number) => Array.from({ length: count }, (_, index) => ({ ...p.instances[0]!, id: `item-${index}` }));
    const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] } as const;
    const compute = { setBindGroup: vi.fn(), setPipeline: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const encoder = { beginComputePass: vi.fn(() => compute) } as unknown as GPUCommandEncoder;
    const cullingBuffers = () => f.allocated.filter(buffer => String((buffer as GPUBuffer & { label?: string }).label).startsWith("Deep culling"));
    f.cache.set({ ...p, instances: makeInstances(64) });
    f.cache.encodeCulling(encoder, frustum, "shadow"); f.cache.encodeCulling(encoder, frustum, "opaque");
    const first = cullingBuffers(); expectCompleteCullingBundle(first);
    f.cache.updateInstances({ materials: p.materials, instances: makeInstances(65) });
    f.cache.encodeCulling(encoder, frustum, "shadow"); f.cache.encodeCulling(encoder, frustum, "opaque");
    const second = cullingBuffers().slice(first.length); expectCompleteCullingBundle(second);
    expect(first.every(buffer => (buffer as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy.mock.calls.length === 1)).toBe(true);
    expect(second.every(buffer => !(buffer as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy.mock.calls.length)).toBe(true);
    f.cache.set({ geometries: [], materials: [], instances: [] });
    expect(second.every(buffer => (buffer as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy.mock.calls.length === 1)).toBe(true);
  });
  it("invalidates the undersized source when capacity growth cannot be allocated", () => {
    const f = fixture(), p = packet();
    const makeInstances = (count: number) => Array.from({ length: count }, (_, index) => ({ ...p.instances[0]!, id: `item-${index}` }));
    const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] } as const;
    const compute = { setBindGroup: vi.fn(), setPipeline: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const encoder = { beginComputePass: vi.fn(() => compute) } as unknown as GPUCommandEncoder;
    f.cache.set({ ...p, instances: makeInstances(64) }); f.cache.encodeCulling(encoder, frustum, "opaque");
    const first = f.allocated.filter(buffer => String((buffer as GPUBuffer & { label?: string }).label).startsWith("Deep culling"));
    f.cache.updateInstances({ materials: p.materials, instances: makeInstances(65) });
    const create = f.device.createBuffer.getMockImplementation()!;
    f.device.createBuffer.mockImplementation((descriptor: { label?: string }) => {
      if (descriptor.label === "Deep culling input") throw new Error("culling allocation failed");
      return create(descriptor);
    });
    expect(() => f.cache.encodeCulling(encoder, frustum, "opaque")).toThrow("culling allocation failed");
    expect(first.every(buffer => (buffer as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy.mock.calls.length === 1)).toBe(true);
    f.pass.drawIndexed.mockClear(); f.pass.drawIndexedIndirect.mockClear();
    f.cache.draw(f.pass as unknown as GPURenderPassEncoder, {
      mainPipelines: new Map([[mainPipelineKey("plain", false, "ccw"), "main"]]), shadowPipelines: new Map(),
    } as unknown as Pipelines, "opaque", undefined, true);
    expect(f.pass.drawIndexed).toHaveBeenCalledOnce(); expect(f.pass.drawIndexedIndirect).not.toHaveBeenCalled();
  });
  it("refreshes shared bounds once per geometry revision and replaces only phase outputs when index count changes", () => {
    const f = fixture(), p = packet();
    const instances = Array.from({ length: GPU_CULLING_MIN_INSTANCES }, (_, index) => ({ ...p.instances[0]!, id: `item-${index}` }));
    const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] } as const;
    const compute = { setBindGroup: vi.fn(), setPipeline: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const encoder = { beginComputePass: vi.fn(() => compute) } as unknown as GPUCommandEncoder;
    f.cache.set({ ...p, instances }); f.cache.encodeCulling(encoder, frustum, "shadow"); f.cache.encodeCulling(encoder, frustum, "opaque");
    const byLabel = (label: string) => f.allocated.filter(buffer => (buffer as GPUBuffer & { label?: string }).label === label);
    const input = byLabel("Deep culling input")[0]!, previous = byLabel("Deep culling previous transforms")[0]!;
    const bounds = byLabel("Deep culling bounds")[0]!, params = byLabel("Deep culling parameters")[0]!;
    const revised = packet(1); revised.geometries[0]!.indices = new Uint32Array([0, 1, 2, 0, 2, 1]);
    f.cache.set({ ...revised, instances }); f.cache.encodeCulling(encoder, frustum, "shadow"); f.cache.encodeCulling(encoder, frustum, "opaque");
    expect(byLabel("Deep culling input")).toEqual([input]); expect(byLabel("Deep culling previous transforms")).toEqual([previous]);
    expect(byLabel("Deep culling bounds")).toEqual([bounds]); expect(byLabel("Deep culling parameters")).toEqual([params]);
    expect(f.device.queue.writeBuffer.mock.calls.filter(([buffer]) => buffer === input)).toHaveLength(2);
    expect(f.device.queue.writeBuffer.mock.calls.filter(([buffer]) => buffer === bounds)).toHaveLength(2);
    expect(byLabel("Deep culling compacted instances")).toHaveLength(4);
    expect(byLabel("Deep culling compacted previous transforms")).toHaveLength(4);
    for (const buffer of byLabel("Deep culling compacted instances").slice(0, 2))
      expect((buffer as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalledOnce();
    for (const buffer of byLabel("Deep culling compacted previous transforms").slice(0, 2))
      expect((buffer as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy).toHaveBeenCalledOnce();
  });
  it("drops a partially updated shared source and falls back to a direct draw after upload failure", () => {
    const f = fixture(), p = packet();
    const makeInstances = (offset: number) => Array.from({ length: GPU_CULLING_MIN_INSTANCES }, (_, index) => ({
      ...p.instances[0]!, id: `item-${index}`, transform: [...transform.slice(0, 12), offset, 0, 0, 1],
    }));
    const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] } as const;
    const compute = { setBindGroup: vi.fn(), setPipeline: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const encoder = { beginComputePass: vi.fn(() => compute) } as unknown as GPUCommandEncoder;
    f.cache.set({ ...p, instances: makeInstances(0) }); f.cache.encodeCulling(encoder, frustum, "shadow"); f.cache.encodeCulling(encoder, frustum, "opaque");
    const first = f.allocated.filter(buffer => String((buffer as GPUBuffer & { label?: string }).label).startsWith("Deep culling"));
    f.cache.updateInstances({ materials: p.materials, instances: makeInstances(1) });
    const write = f.device.queue.writeBuffer.getMockImplementation()!;
    f.device.queue.writeBuffer.mockImplementation((buffer, offset, data) => {
      if ((buffer as GPUBuffer & { label?: string }).label === "Deep culling bounds") throw new Error("culling bounds upload failed");
      write(buffer, offset, data);
    });
    expect(() => f.cache.encodeCulling(encoder, frustum, "shadow")).toThrow("culling bounds upload failed");
    expect(first.every(buffer => (buffer as unknown as { destroy: ReturnType<typeof vi.fn> }).destroy.mock.calls.length === 1)).toBe(true);
    f.pass.drawIndexed.mockClear(); f.pass.drawIndexedIndirect.mockClear();
    f.cache.draw(f.pass as unknown as GPURenderPassEncoder, {
      mainPipelines: new Map([[mainPipelineKey("plain", false, "ccw"), "main"]]), shadowPipelines: new Map(),
    } as unknown as Pipelines, "opaque", undefined, true);
    expect(f.pass.drawIndexed).toHaveBeenCalledOnce(); expect(f.pass.drawIndexedIndirect).not.toHaveBeenCalled();
  });
  it.each([false, true])("rolls back culling frame history and releases unsafe culling state=%s", rollbackFails => {
    const f = fixture(), p = packet();
    const makeInstances = (x: number) => Array.from({ length: GPU_CULLING_MIN_INSTANCES }, (_, index) => ({
      ...p.instances[0]!, id: `history-${index}`, transform: [...transform.slice(0, 12), x, 0, 0, 1],
    }));
    const frustum = { planes: [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1]] } as const;
    const compute = { setBindGroup: vi.fn(), setPipeline: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const encoder = { beginComputePass: vi.fn(() => compute) } as unknown as GPUCommandEncoder;
    f.cache.set({ ...p, instances: makeInstances(0) }); f.cache.encodeCulling(encoder, frustum, "opaque");
    f.cache.updateInstances({ materials: p.materials, instances: makeInstances(3) }); f.cache.encodeCulling(encoder, frustum, "opaque");
    const directPrevious = f.byLabel("Deep packet previous transforms")[0]!;
    const cullingPrevious = f.byLabel("Deep culling previous transforms")[0]!;
    const beforeDirect = f.contents.get(directPrevious), beforeCulling = f.contents.get(cullingPrevious); let cullingWrites = 0;
    const write = f.device.queue.writeBuffer.getMockImplementation()!;
    f.device.queue.writeBuffer.mockImplementation((buffer, offset, data) => {
      write(buffer, offset, data);
      if (buffer === cullingPrevious && (++cullingWrites === 1 || rollbackFails)) throw new Error("culling history failed");
    });
    expect(() => f.cache.commitFrame()).toThrow(rollbackFails ? "Culling history rollback failed" : "culling history failed");
    expect(f.contents.get(directPrevious)).toEqual(beforeDirect);
    if (rollbackFails) expect(cullingPrevious.destroy).toHaveBeenCalledOnce();
    else expect(f.contents.get(cullingPrevious)).toEqual(beforeCulling);
  });
});
