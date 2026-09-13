import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { GpuSkinner, cpuSkinVertices, prepareSkinningInput } from "./gpuSkinning.js";
import type { SkinningPalette, SkinningSource } from "./gpuSkinningTypes.js";
import { GPU_SKINNING_WGSL } from "./gpuSkinningWgsl.js";

const matrix = (translation = 0, scaleX = 1) => new Float32Array([
  scaleX, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, translation, 0, 0, 1,
]);
const source = (revision = 0): SkinningSource => ({ revision, positions: new Float32Array([1, 0, 0]),
  normals: new Float32Array([1, 0, 0]), joints: new Uint16Array([0, 1, 0, 0]), weights: new Float32Array([1, 1, 0, 0]) });
const palette = (revision = 0, translations = [0, 2]): SkinningPalette => ({ revision,
  matrices: new Float32Array(translations.flatMap((value) => [...matrix(value)])) });

interface FakeBuffer extends GPUBuffer { readonly destroy: ReturnType<typeof vi.fn> }
function fixture() {
  const owned = new Set<FakeBuffer>(), buffers: FakeBuffer[] = [], writes: Array<{ target: GPUBuffer; data: ArrayBuffer | ArrayBufferView }> = [];
  const device = {
    queue: { writeBuffer: vi.fn((target: GPUBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView) => writes.push({ target, data })) },
    createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})), createPipelineLayout: vi.fn(() => ({})),
    createComputePipeline: vi.fn(() => ({ label: "pipeline" })), createBindGroup: vi.fn(({ entries }) => ({ entries })),
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

describe("GPU skinning", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-gpu-skinning.wgsl", "--input-kind", "wgsl"], { input: GPU_SKINNING_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("normalizes four weights and matches linear-blend CPU reference", () => {
    const prepared = prepareSkinningInput(source(), palette());
    const packed = new Float32Array(prepared.vertices);
    expect([...packed.slice(12, 16)]).toEqual([0.5, 0.5, 0, 0]);
    const output = cpuSkinVertices(prepared);
    expect([...output.slice(0, 4)]).toEqual([2, 0, 0, 1]);
    expect([...output.slice(4, 8)]).toEqual([1, 0, 0, 0]);
  });

  it("derives inverse-transpose normal rows for non-uniform joint scale", () => {
    const input = prepareSkinningInput({ ...source(), joints: new Uint16Array([0, 0, 0, 0]), weights: new Float32Array([1, 0, 0, 0]),
      normals: new Float32Array([1, 1, 0]) }, { revision: 0, matrices: matrix(0, 2) });
    const output = cpuSkinVertices(input);
    expect(output[4]).toBeCloseTo(0.4472135, 5); expect(output[5]).toBeCloseTo(0.8944271, 5);
  });

  it("allocates one source and atomically alternates reusable palette buffers", () => {
    const f = fixture(), skinner = new GpuSkinner(f.session), initialSource = source();
    expect(skinner.setSource(initialSource, palette())).toBe(true); expect(f.buffers).toHaveLength(5);
    const firstBinding = f.device.createBindGroup.mock.calls.at(-1)![0].entries[1].resource.buffer;
    expect(skinner.updatePalette(palette(1, [1, 3]))).toBe(true);
    const secondBinding = f.device.createBindGroup.mock.calls.at(-1)![0].entries[1].resource.buffer;
    expect(secondBinding).not.toBe(firstBinding);
    const finalPalette = palette(2, [2, 4]);
    expect(skinner.updatePalette(finalPalette)).toBe(true);
    expect(f.device.createBindGroup.mock.calls.at(-1)![0].entries[1].resource.buffer).toBe(firstBinding);
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    const encoder = { beginComputePass: vi.fn(() => pass) } as unknown as GPUCommandEncoder;
    expect(skinner.encode(encoder)).toMatchObject({ vertexCount: 1, outputStride: 32, sourceRevision: 0, paletteRevision: 2 });
    expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(1);
    expect(skinner.setSource(initialSource, finalPalette)).toBe(false);
    skinner.dispose(); skinner.dispose(); expect(f.owned.size).toBe(0);
  });

  it("keeps the active palette after a standby write failure and rejects silent revisions", () => {
    const f = fixture(), skinner = new GpuSkinner(f.session), initialSource = source(), initialPalette = palette();
    skinner.setSource(initialSource, initialPalette);
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("palette write failed"); });
    expect(() => skinner.updatePalette(palette(1))).toThrow("palette write failed");
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    expect(skinner.encode({ beginComputePass: () => pass } as unknown as GPUCommandEncoder).paletteRevision).toBe(0);
    expect(() => skinner.setSource({ ...initialSource }, initialPalette)).toThrow("without a revision");
    expect(() => skinner.updatePalette({ ...initialPalette })).toThrow("without a revision");
  });

  it("fails closed on invalid attributes, joints, matrices and device loss", () => {
    expect(() => prepareSkinningInput({ ...source(), weights: new Float32Array([0, 0, 0, 0]) }, palette())).toThrow("zero total weight");
    expect(() => prepareSkinningInput({ ...source(), joints: new Uint16Array([2, 0, 0, 0]) }, palette())).toThrow("out of range");
    expect(() => prepareSkinningInput({ ...source(), positions: new Float32Array([NaN, 0, 0]) }, palette())).toThrow("non-finite");
    expect(() => prepareSkinningInput({ ...source(), joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) },
      { revision: 0, matrices: new Float32Array(16) })).toThrow("singular");
    const f = fixture(), skinner = new GpuSkinner(f.session); skinner.setSource(source(), palette());
    f.raw.state = "lost";
    expect(() => skinner.encode({} as GPUCommandEncoder)).toThrow("not ready"); expect(f.owned.size).toBe(0);
  });
});
