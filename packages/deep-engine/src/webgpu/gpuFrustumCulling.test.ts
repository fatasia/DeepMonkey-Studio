import { afterEach, describe, expect, it, vi } from "vitest";
import { cpuFrustumCull, createGpuCullingPipelineContext, createGpuCullingSharedInputs, createGpuFrustumCulling, GPU_CULL_INSTANCE_STRIDE, GPU_FRUSTUM_CULL_WGSL, packCullingInstances, type Frustum } from "./gpuFrustumCulling";

const m = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
describe("GPU frustum culling contract", () => {
  it("packs the 144-byte instance ABI", () => { const packed=packCullingInstances([{modelMatrix:m,bounds:[0,0,0,1]}]); expect(packed.byteLength).toBe(GPU_CULL_INSTANCE_STRIDE); });
  it("keeps model rows, inverse-transpose normals, and metadata in the bindable Deep vertex layout", () => {
    const matrix = [2,0,0,0, 0,4,0,0, 0,0,8,0, 3,5,7,1];
    const values = new Float32Array(packCullingInstances([{modelMatrix:matrix,bounds:[0,0,0,1],metadata:[9,8,7,6]}]));
    expect(Array.from(values.slice(0, 12))).toEqual([2,0,0,3, 0,4,0,5, 0,0,8,7]);
    expect(values[12]).toBeCloseTo(0.5); expect(values[17]).toBeCloseTo(0.25); expect(values[22]).toBeCloseTo(0.125);
    expect(Array.from(new Uint32Array(values.buffer).slice(32, 36))).toEqual([9,8,7,6]);
  });
  it("accepts an existing full instance row without rewriting material data", () => {
    const row = Array.from({length:36}, (_, index) => index + 0.5);
    const packed = new Float32Array(packCullingInstances([{instanceData:row,bounds:[0,0,0,1]}]));
    expect(Array.from(packed)).toEqual(row);
  });
  it("matches sphere-plane CPU reference", () => { const items=[{modelMatrix:m,bounds:[0,0,0,1] as [number,number,number,number]},{modelMatrix:[...m.slice(0,12),10,0,0,1],bounds:[0,0,0,1] as [number,number,number,number]}]; expect(cpuFrustumCull(items,{planes:[[1,0,0,5],[-1,0,0,5],[0,1,0,5],[0,-1,0,5],[0,0,1,5],[0,0,-1,5]]})).toEqual([0]); });
  it("normalizes planes and preserves uniform-scale support", () => {
    const scaled = [3,0,0,0, 0,3,0,0, 0,0,3,0, 1.2,0,0,1];
    const inside = {modelMatrix:scaled,bounds:[0,0,0,0.2] as [number,number,number,number]};
    const outside = {modelMatrix:[...scaled.slice(0,12),2.1,0,0,1],bounds:[0,0,0,0.2] as [number,number,number,number]};
    const planes: Frustum = {planes:[[2,0,0,2],[-2,0,0,2],[0,2,0,2],[0,-2,0,2],[0,0,2,2],[0,0,-2,2]]};
    expect(cpuFrustumCull([inside,outside],planes)).toEqual([0]);
  });
  it("keeps sheared and reflected ellipsoids that intersect a plane beyond the largest column radius", () => {
    const n = Math.SQRT1_2;
    const affine = (distance: number, reflected = false) => ({
      modelMatrix: [reflected ? -1 : 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, -distance * n, -distance * n, 0, 1],
      bounds: [0, 0, 0, 1] as const,
    });
    const frustum: Frustum = { planes: [[2, 2, 0, 0], [-1, 0, 0, 100], [0, 1, 0, 100],
      [0, -1, 0, 100], [0, 0, 1, 100], [0, 0, -1, 100]] };
    expect(Math.SQRT2).toBeLessThan(1.5);
    expect(Math.sqrt(2.5)).toBeGreaterThan(1.5);
    expect(cpuFrustumCull([affine(1.5), affine(1.7), affine(1.5, true)], frustum)).toEqual([0, 2]);
    const rows = new Float32Array(packCullingInstances([affine(1.5)]));
    expect(cpuFrustumCull([{ instanceData: rows, bounds: [0, 0, 0, 1] }], frustum)).toEqual([0]);
  });
  it("contains atomic compaction and indirect draw ABI", () => { expect(GPU_FRUSTUM_CULL_WGSL).toMatch(/atomicAdd/); expect(GPU_FRUSTUM_CULL_WGSL).toMatch(/drawIndexedIndirect|indirect/); expect(GPU_FRUSTUM_CULL_WGSL).toMatch(/@compute/); });
  it("keeps stable instance uploads separate from per-view resets", () => {
    vi.stubGlobal("GPUBufferUsage", { STORAGE:1, COPY_DST:2, COPY_SRC:4, VERTEX:8, INDIRECT:16 });
    vi.stubGlobal("GPUShaderStage", { COMPUTE:1 });
    const buffers: Array<{ label:string; destroy:ReturnType<typeof vi.fn> }> = [];
    const device = {
      createBuffer: vi.fn(({label}:{label:string}) => { const buffer={label,destroy:vi.fn()}; buffers.push(buffer); return buffer; }),
      createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
      createComputePipeline: vi.fn(({label}:{label:string}) => ({label})), createBindGroup: vi.fn(() => ({})),
    } as unknown as GPUDevice;
    const queue = { writeBuffer:vi.fn() } as unknown as GPUQueue;
    const culler = createGpuFrustumCulling(device, 4, 3);
    const values = [{modelMatrix:m,bounds:[0,0,0,1] as const}];
    const view: Frustum = {planes:[[1,0,0,5],[-1,0,0,5],[0,1,0,5],[0,-1,0,5],[0,0,1,5],[0,0,-1,5]]};
    expect(() => culler.writeView(queue, view)).toThrow("instances");
    culler.writeInstances(queue, values);
    const stableBuffers = new Set([culler.input, culler.previous, culler.bounds, culler.params]);
    expect(vi.mocked(queue.writeBuffer).mock.calls.filter(([buffer]) => stableBuffers.has(buffer)).length).toBe(4);
    culler.writeView(queue, view); culler.writeView(queue, view);
    expect(vi.mocked(queue.writeBuffer).mock.calls.filter(([buffer]) => stableBuffers.has(buffer)).length).toBe(4);
    const pass = { setBindGroup:vi.fn(), setPipeline:vi.fn(), dispatchWorkgroups:vi.fn(), end:vi.fn() };
    const encoder = { beginComputePass:vi.fn(() => pass) } as unknown as GPUCommandEncoder;
    culler.encode(encoder); expect(pass.dispatchWorkgroups).toHaveBeenCalledTimes(2);
    expect(() => culler.encode(encoder)).toThrow("view");
    culler.dispose(); expect(buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });
  it("shares one stable input allocation across isolated shadow and opaque phases", () => {
    vi.stubGlobal("GPUBufferUsage", { STORAGE:1, COPY_DST:2, COPY_SRC:4, VERTEX:8, INDIRECT:16 });
    vi.stubGlobal("GPUShaderStage", { COMPUTE:1 });
    const buffers: Array<{ label:string; destroy:ReturnType<typeof vi.fn> }> = [];
    const device = {
      createBuffer: vi.fn(({label}:{label:string}) => { const buffer={label,destroy:vi.fn()}; buffers.push(buffer); return buffer; }),
      createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
      createComputePipeline: vi.fn(({label}:{label:string}) => ({label})), createBindGroup: vi.fn(() => ({})),
    } as unknown as GPUDevice;
    const queue = { writeBuffer:vi.fn() } as unknown as GPUQueue;
    const shared = createGpuCullingSharedInputs(device, 64);
    const shadow = shared.createPhase(3), opaque = shared.createPhase(3);
    expect(buffers.filter(buffer => buffer.label === "Deep culling input")).toHaveLength(1);
    expect(buffers.filter(buffer => buffer.label === "Deep culling previous transforms")).toHaveLength(1);
    expect(buffers.filter(buffer => buffer.label === "Deep culling bounds")).toHaveLength(1);
    expect(buffers.filter(buffer => buffer.label === "Deep culling parameters")).toHaveLength(1);
    expect(buffers.filter(buffer => buffer.label === "Deep culling compacted instances")).toHaveLength(2);
    shared.writeInstances(queue, [{modelMatrix:m,bounds:[0,0,0,1]}]);
    const view: Frustum = {planes:[[1,0,0,5],[-1,0,0,5],[0,1,0,5],[0,-1,0,5],[0,0,1,5],[0,0,-1,5]]};
    shadow.writeView(queue, view); opaque.writeView(queue, view);
    const stable = new Set([shared.input, shared.previous, shared.bounds, shared.params]);
    expect(vi.mocked(queue.writeBuffer).mock.calls.filter(([buffer]) => stable.has(buffer))).toHaveLength(4);
    shadow.dispose();
    expect(buffers.filter(buffer => buffer.destroy.mock.calls.length === 1)).toHaveLength(5);
    expect(() => shadow.writeView(queue, view)).toThrow("disposed");
    shared.dispose(); shared.dispose();
    expect(buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(() => opaque.writeView(queue, view)).toThrow("disposed");
    expect(() => shared.createPhase(3)).toThrow("disposed");
  });
  it("releases partial source and phase allocations when construction fails", () => {
    vi.stubGlobal("GPUBufferUsage", { STORAGE:1, COPY_DST:2, COPY_SRC:4, VERTEX:8, INDIRECT:16 });
    vi.stubGlobal("GPUShaderStage", { COMPUTE:1 });
    const sourceBuffers: Array<{ destroy:ReturnType<typeof vi.fn> }> = [];
    const sourceDevice = {
      createBuffer: vi.fn(() => {
        if (sourceBuffers.length === 2) throw new Error("source allocation failed");
        const buffer={destroy:vi.fn()}; sourceBuffers.push(buffer); return buffer;
      }),
      createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => ({})),
    } as unknown as GPUDevice;
    expect(() => createGpuCullingSharedInputs(sourceDevice, 64)).toThrow("source allocation failed");
    expect(sourceBuffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);

    const phaseBuffers: Array<{ destroy:ReturnType<typeof vi.fn> }> = [];
    const phaseDevice = {
      createBuffer: vi.fn(() => { const buffer={destroy:vi.fn()}; phaseBuffers.push(buffer); return buffer; }),
      createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => { throw new Error("phase binding failed"); }),
    } as unknown as GPUDevice;
    const shared = createGpuCullingSharedInputs(phaseDevice, 64);
    expect(() => shared.createPhase(3)).toThrow("phase binding failed");
    expect(phaseBuffers.slice(4).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(phaseBuffers.slice(0, 4).every(buffer => buffer.destroy.mock.calls.length === 0)).toBe(true);
    shared.dispose(); expect(phaseBuffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });
  it("invalidates readiness after a partial source or view upload", () => {
    vi.stubGlobal("GPUBufferUsage", { STORAGE:1, COPY_DST:2, COPY_SRC:4, VERTEX:8, INDIRECT:16 });
    vi.stubGlobal("GPUShaderStage", { COMPUTE:1 });
    const device = {
      createBuffer: vi.fn(({label}:{label:string}) => ({label,destroy:vi.fn()})),
      createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    } as unknown as GPUDevice;
    const shared = createGpuCullingSharedInputs(device, 4), phase = shared.createPhase(3);
    const queue = { writeBuffer:vi.fn() }, values = [{modelMatrix:m,bounds:[0,0,0,1] as const}];
    const view: Frustum = {planes:[[1,0,0,5],[-1,0,0,5],[0,1,0,5],[0,-1,0,5],[0,0,1,5],[0,0,-1,5]]};
    shared.writeInstances(queue as unknown as GPUQueue, values);
    queue.writeBuffer.mockImplementation((_buffer: GPUBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView) => {
      if (data instanceof ArrayBuffer && data.byteLength === 16) throw new Error("bounds failed");
    });
    expect(() => shared.writeInstances(queue as unknown as GPUQueue, values)).toThrow("bounds failed");
    expect(shared.inputCount).toBe(0);
    expect(() => phase.writeView(queue as unknown as GPUQueue, view)).toThrow("instances");
    queue.writeBuffer.mockReset(); shared.writeInstances(queue as unknown as GPUQueue, values); phase.writeView(queue as unknown as GPUQueue, view);
    queue.writeBuffer.mockImplementation((buffer: GPUBuffer) => {
      if (buffer === phase.counter) throw new Error("counter failed");
    });
    expect(() => phase.writeView(queue as unknown as GPUQueue, view)).toThrow("counter failed");
    const encoder = { beginComputePass:vi.fn() } as unknown as GPUCommandEncoder;
    expect(() => phase.encode(encoder)).toThrow("view");
    shared.dispose();
  });
  it("accepts the full indirect uint32 index range and context disposal cascades to sources", () => {
    vi.stubGlobal("GPUBufferUsage", { STORAGE:1, COPY_DST:2, COPY_SRC:4, VERTEX:8, INDIRECT:16 });
    vi.stubGlobal("GPUShaderStage", { COMPUTE:1 });
    const buffers: Array<{ destroy:ReturnType<typeof vi.fn> }> = [];
    const device = {
      createBuffer: vi.fn(() => { const buffer={destroy:vi.fn()}; buffers.push(buffer); return buffer; }),
      createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    } as unknown as GPUDevice;
    const context = createGpuCullingPipelineContext(device), first = context.createSharedInputs(2), second = context.createSharedInputs(2);
    expect(() => first.createPhase(0xffffffff)).not.toThrow();
    expect(() => second.createPhase(0x1_0000_0000)).toThrow("uint32");
    expect(vi.mocked(device.createComputePipeline)).toHaveBeenCalledTimes(2);
    context.dispose(); context.dispose();
    expect(buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(() => context.createSharedInputs(2)).toThrow("disposed");
  });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
