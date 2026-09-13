import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MorphPrimitiveSource } from "../morph/types.js";
import type { DeviceSession } from "./deviceSession.js";
import { GpuMorphDeformer, cpuDeformMorphVertices, prepareMorphInput } from "./gpuMorphDeformation.js";
import type { GpuMorphSource, GpuMorphWeights } from "./gpuMorphTypes.js";
import { GPU_MORPH_WGSL } from "./gpuMorphWgsl.js";

const primitive = (): MorphPrimitiveSource => ({ id: "face:0", sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1, targets: [
  { index: 0, name: "raise", positionDeltas: new Float32Array([2, 0, 0]), normalDeltas: new Float32Array([0, 1, 0]),
    tangentDeltas: new Float32Array([0, 1, 0]) },
  { index: 1, name: "slide", positionDeltas: new Float32Array([0, 4, 0]) },
] });
const source = (revision = 0): GpuMorphSource => ({ revision, primitive: primitive(), positions: new Float32Array([1, 0, 0]),
  normals: new Float32Array([0, 0, 1]), tangents: new Float32Array([1, 0, 0, -1]) });
const weights = (revision = 0, values = [0.5, 0.25]): GpuMorphWeights => ({ revision, values: new Float32Array(values) });

interface FakeBuffer extends GPUBuffer { readonly destroy: ReturnType<typeof vi.fn> }
function fixture() {
  const owned = new Set<FakeBuffer>(), buffers: FakeBuffer[] = [], writes: Array<{ target: GPUBuffer; data: ArrayBuffer | ArrayBufferView }> = [];
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30, maxComputeWorkgroupsPerDimension: 65_535 },
    queue: { writeBuffer: vi.fn((target: GPUBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView) => writes.push({ target, data })) },
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({ label: "morph-pipeline" })), createBindGroup: vi.fn(({ entries }) => ({ entries })),
    createBuffer: vi.fn(({ size, usage, label }: GPUBufferDescriptor) => {
      const value = { size, usage, label, mapState: "unmapped", destroy: vi.fn() } as unknown as FakeBuffer;
      buffers.push(value); return value;
    }),
  };
  const session = { state: "ready", device, own<T extends FakeBuffer>(item: T) { owned.add(item); return item; },
    release(item: FakeBuffer) { if (owned.delete(item)) item.destroy(); } };
  return { session: session as unknown as DeviceSession, raw: session, device, owned, buffers, writes };
}

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, VERTEX: 8, UNIFORM: 16 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("GPU morph deformation", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-gpu-morph.wgsl", "--input-kind", "wgsl"], { input: GPU_MORPH_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("packs target-major deltas and matches normalized CPU POSITION/NORMAL/TANGENT output", () => {
    const prepared = prepareMorphInput(source(), weights()), output = cpuDeformMorphVertices(prepared);
    expect(prepared).toMatchObject({ vertexCount: 1, targetCount: 2, flags: 3 });
    expect([...output.slice(0, 4)]).toEqual([2, 1, 0, 1]);
    expect(output[4]).toBeCloseTo(0); expect(output[5]).toBeCloseTo(0.4472136); expect(output[6]).toBeCloseTo(0.8944272);
    expect(output[8]).toBeCloseTo(0.9128709); expect(output[9]).toBeCloseTo(0.3651484); expect(output[10]).toBeCloseTo(-0.1825742);
    expect(output[11]).toBe(-1);
  });

  it("supports position-only sources and zeroes absent shading semantics", () => {
    const positionOnly: GpuMorphSource = { revision: 0, positions: new Float32Array([0, 0, 0]), primitive: { ...primitive(), targets: [
      { index: 0, name: "position", positionDeltas: new Float32Array([1, 2, 3]) },
    ] } };
    const output = cpuDeformMorphVertices(prepareMorphInput(positionOnly, weights(0, [2])));
    expect([...output]).toEqual([2, 4, 6, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("uploads once and atomically alternates two reusable weight buffers", () => {
    const f = fixture(), deformer = new GpuMorphDeformer(f.session), initialSource = source();
    expect(deformer.setSource(initialSource, weights())).toBe(true); expect(f.buffers).toHaveLength(6); expect(f.owned.size).toBe(6);
    const first = f.device.createBindGroup.mock.calls.at(-1)![0].entries[2].resource.buffer;
    expect(deformer.updateWeights(weights(1, [1, 0]))).toBe(true);
    const second = f.device.createBindGroup.mock.calls.at(-1)![0].entries[2].resource.buffer; expect(second).not.toBe(first);
    const finalWeights = weights(2, [0, 1]); expect(deformer.updateWeights(finalWeights)).toBe(true);
    expect(f.device.createBindGroup.mock.calls.at(-1)![0].entries[2].resource.buffer).toBe(first);
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const result = deformer.encode({ beginComputePass: vi.fn(() => pass) } as unknown as GPUCommandEncoder);
    expect(result).toMatchObject({ vertexCount: 1, outputStride: 48, hasNormals: true, hasTangents: true,
      sourceRevision: 0, weightsRevision: 2 });
    expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(1); expect(deformer.setSource(initialSource, finalWeights)).toBe(false);
    deformer.dispose(); deformer.dispose(); expect(f.owned.size).toBe(0);
  });

  it("rolls back failed uploads and keeps the previous source and weights active", () => {
    const f = fixture(), deformer = new GpuMorphDeformer(f.session), firstSource = source(), firstWeights = weights();
    deformer.setSource(firstSource, firstWeights);
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("standby write failed"); });
    expect(() => deformer.updateWeights(weights(1))).toThrow("standby write failed");
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    expect(deformer.encode({ beginComputePass: () => pass } as unknown as GPUCommandEncoder).weightsRevision).toBe(0);
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("source upload failed"); });
    expect(() => deformer.setSource(source(1), weights(0))).toThrow("source upload failed");
    expect(deformer.encode({ beginComputePass: () => pass } as unknown as GPUCommandEncoder).sourceRevision).toBe(0);
    expect(f.owned.size).toBe(6);
  });

  it("fails closed on malformed streams, revisions and device capacity", () => {
    expect(() => prepareMorphInput({ ...source(), normals: undefined }, weights())).toThrow("normal deltas require base normals");
    expect(() => prepareMorphInput({ ...source(), tangents: new Float32Array([1, 0, 0, 0]) }, weights())).toThrow("handedness");
    expect(() => prepareMorphInput(source(), weights(0, [NaN, 0]))).toThrow("not finite");
    const maximum = new Float32Array([3.4e38, 0, 0]);
    const overflowSource: GpuMorphSource = { revision: 0, positions: new Float32Array([0, 0, 0]), primitive: { ...primitive(), targets: [
      { index: 0, name: "overflow", positionDeltas: maximum },
    ] } };
    expect(() => prepareMorphInput(overflowSource, weights(0, [2]))).toThrow("overflow finite float32");
    expect(() => prepareMorphInput({ ...source(), primitive: { ...primitive(), targets: [
      { ...primitive().targets[0]!, index: 1 }, primitive().targets[1]!,
    ] } }, weights())).toThrow("stable target order");
    const f = fixture(); f.device.limits.maxStorageBufferBindingSize = 32; const deformer = new GpuMorphDeformer(f.session);
    expect(() => deformer.setSource(source(), weights())).toThrow("storage-buffer limit"); expect(f.buffers).toHaveLength(0);
    const dynamic = fixture(), dynamicDeformer = new GpuMorphDeformer(dynamic.session);
    dynamicDeformer.setSource(overflowSource, weights(0, [0])); const writeCount = dynamic.writes.length;
    expect(() => dynamicDeformer.updateWeights(weights(1, [2]))).toThrow("overflow finite float32");
    expect(dynamic.writes).toHaveLength(writeCount); dynamicDeformer.dispose(); deformer.dispose();
  });

  it("rejects silent revisions and releases all buffers after device loss", () => {
    const f = fixture(), deformer = new GpuMorphDeformer(f.session), initialSource = source(), initialWeights = weights();
    deformer.setSource(initialSource, initialWeights);
    expect(() => deformer.setSource({ ...initialSource }, initialWeights)).toThrow("without a revision");
    expect(() => deformer.updateWeights({ ...initialWeights })).toThrow("without a revision");
    f.raw.state = "lost";
    expect(() => deformer.encode({} as GPUCommandEncoder)).toThrow("not ready"); expect(f.owned.size).toBe(0);
  });
});
