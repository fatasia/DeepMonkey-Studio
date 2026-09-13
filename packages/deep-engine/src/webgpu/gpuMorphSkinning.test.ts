import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MorphPrimitiveSource } from "../morph/types.js";
import type { DeviceSession } from "./deviceSession.js";
import type { GpuMorphSource, GpuMorphWeights } from "./gpuMorphTypes.js";
import { GpuMorphSkinner, cpuDeformMorphSkinVertices, prepareMorphSkinningInput } from "./gpuMorphSkinning.js";
import type { MorphSkinningDynamics, MorphSkinningSources } from "./gpuMorphSkinningTypes.js";
import { GPU_MORPH_SKINNING_WGSL } from "./gpuMorphSkinningWgsl.js";
import type { SkinningPalette, SkinningSource } from "./gpuSkinningTypes.js";

const primitive = (): MorphPrimitiveSource => ({ id: "fused:0", sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1, targets: [
  { index: 0, name: "raise", positionDeltas: new Float32Array([2, 0, 0]), normalDeltas: new Float32Array([0, 1, 0]),
    tangentDeltas: new Float32Array([0, 1, 0]) },
  { index: 1, name: "slide", positionDeltas: new Float32Array([0, 4, 0]) },
] });
const matrix = (scaleX = 2, scaleY = 2, scaleZ = 2, translation = 10) => new Float32Array([
  scaleX, 0, 0, 0, 0, scaleY, 0, 0, 0, 0, scaleZ, 0, translation, 0, 0, 1,
]);
function sources(morphRevision = 0, skinRevision = 0): MorphSkinningSources {
  const positions = new Float32Array([1, 0, 0]), normals = new Float32Array([0, 0, 1]);
  const morph: GpuMorphSource = { revision: morphRevision, primitive: primitive(), positions: positions.slice(), normals: normals.slice(),
    tangents: new Float32Array([1, 0, 0, -1]) };
  const skinning: SkinningSource = { revision: skinRevision, positions: positions.slice(), normals: normals.slice(),
    joints: new Uint16Array([0, 0, 0, 0]), weights: new Float32Array([1, 0, 0, 0]) };
  return { morph, skinning };
}
const morphWeights = (revision = 0, values = [0.5, 0.25]): GpuMorphWeights => ({ revision, values: new Float32Array(values) });
const palette = (revision = 0, value = matrix()): SkinningPalette => ({ revision, matrices: value });
const dynamics = (weightRevision = 0, paletteRevision = 0): MorphSkinningDynamics => ({
  morphWeights: morphWeights(weightRevision), palette: palette(paletteRevision),
});

interface FakeBuffer extends GPUBuffer { readonly destroy: ReturnType<typeof vi.fn> }
function fixture() {
  const owned = new Set<FakeBuffer>(), buffers: FakeBuffer[] = [], writes: Array<{ target: GPUBuffer; data: ArrayBuffer | ArrayBufferView }> = [];
  const write = (target: GPUBuffer, _offset: number, data: ArrayBuffer | ArrayBufferView) => { writes.push({ target, data }); };
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30, maxComputeWorkgroupsPerDimension: 65_535 },
    queue: { writeBuffer: vi.fn(write) }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(({ entries }) => ({ entries })),
    createBuffer: vi.fn(({ size, usage, label }: GPUBufferDescriptor) => {
      const value = { size, usage, label, mapState: "unmapped", destroy: vi.fn() } as unknown as FakeBuffer; buffers.push(value); return value;
    }),
  };
  const session = { state: "ready", device, own<T extends FakeBuffer>(item: T) { owned.add(item); return item; },
    release(item: FakeBuffer) { if (owned.delete(item)) item.destroy(); } };
  return { session: session as unknown as DeviceSession, raw: session, device, owned, buffers, writes, write };
}

beforeEach(() => { vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, VERTEX: 8, UNIFORM: 16 }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("fused GPU morph skinning", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga parsing and semantic validation", () => {
    const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
      ["--stdin-file-path", "deep-gpu-morph-skinning.wgsl", "--input-kind", "wgsl"],
      { input: GPU_MORPH_SKINNING_WGSL, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("matches morph-then-skin POSITION/NORMAL/TANGENT reference", () => {
    const value = sources(), state = dynamics(), prepared = prepareMorphSkinningInput(value.morph, value.skinning, state.morphWeights, state.palette);
    const output = cpuDeformMorphSkinVertices(prepared);
    expect([...output.slice(0, 4)]).toEqual([14, 2, 0, 1]);
    expect(output[4]).toBeCloseTo(0); expect(output[5]).toBeCloseTo(0.4472136); expect(output[6]).toBeCloseTo(0.8944272);
    expect(output[8]).toBeCloseTo(0.9128709); expect(output[9]).toBeCloseTo(0.3651484); expect(output[10]).toBeCloseTo(-0.1825742);
    expect(output[11]).toBe(-1); expect(prepared.influences.byteLength).toBe(32);
  });

  it("flips tangent handedness for reflected skin transforms", () => {
    const value = sources(), state = { morphWeights: morphWeights(0, [0, 0]), palette: palette(0, matrix(-1, 1, 1, 0)) };
    const output = cpuDeformMorphSkinVertices(prepareMorphSkinningInput(value.morph, value.skinning, state.morphWeights, state.palette));
    expect([...output.slice(0, 4)]).toEqual([-1, 0, 0, 1]); expect([...output.slice(8, 12)]).toEqual([-1, 0, 0, 1]);
  });

  it("uses one dispatch and reuses both dynamic double buffers", () => {
    const f = fixture(), deformer = new GpuMorphSkinner(f.session), initialSources = sources(), initialDynamics = dynamics();
    expect(deformer.setSource(initialSources, initialDynamics)).toBe(true); expect(f.buffers).toHaveLength(9);
    const firstBinding = f.device.createBindGroup.mock.calls.at(-1)![0].entries;
    const updated: MorphSkinningDynamics = { morphWeights: morphWeights(1, [0, 1]), palette: palette(1, matrix(1, 1, 1, 0)) };
    expect(deformer.updateDynamics(updated)).toBe(true); expect(f.owned.size).toBe(9);
    const secondBinding = f.device.createBindGroup.mock.calls.at(-1)![0].entries;
    expect(secondBinding[2].resource.buffer).not.toBe(firstBinding[2].resource.buffer);
    expect(secondBinding[4].resource.buffer).not.toBe(firstBinding[4].resource.buffer);
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    expect(deformer.encode({ beginComputePass: () => pass } as unknown as GPUCommandEncoder)).toMatchObject({
      outputStride: 48, morphWeightsRevision: 1, paletteRevision: 1,
    });
    expect(pass.dispatchWorkgroups).toHaveBeenCalledOnce(); expect(deformer.setSource(initialSources, updated)).toBe(false);
    deformer.dispose(); expect(f.owned.size).toBe(0);
  });

  it("keeps both active dynamics when a joint upload or binding fails", () => {
    const f = fixture(), deformer = new GpuMorphSkinner(f.session), initialSources = sources(), initialDynamics = dynamics();
    deformer.setSource(initialSources, initialDynamics);
    f.device.queue.writeBuffer.mockImplementationOnce(f.write).mockImplementationOnce(() => { throw new Error("palette write failed"); });
    expect(() => deformer.updateDynamics({ morphWeights: morphWeights(1), palette: palette(1) })).toThrow("palette write failed");
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
    expect(deformer.encode({ beginComputePass: () => pass } as unknown as GPUCommandEncoder)).toMatchObject({
      morphWeightsRevision: 0, paletteRevision: 0,
    });
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("binding failed"); });
    expect(() => deformer.updateDynamics({ morphWeights: morphWeights(1), palette: palette(1) })).toThrow("binding failed");
    expect(deformer.encode({ beginComputePass: () => pass } as unknown as GPUCommandEncoder).paletteRevision).toBe(0);
  });

  it("rolls back source upload and fails closed on mismatched ABI and silent revisions", () => {
    const f = fixture(), deformer = new GpuMorphSkinner(f.session), initialSources = sources(), initialDynamics = dynamics();
    deformer.setSource(initialSources, initialDynamics);
    const mismatch = sources(); mismatch.skinning.positions[0] = 2;
    expect(() => prepareMorphSkinningInput(mismatch.morph, mismatch.skinning, initialDynamics.morphWeights, initialDynamics.palette)).toThrow("positions do not match");
    expect(() => deformer.setSource({ ...initialSources, morph: { ...initialSources.morph } }, initialDynamics)).toThrow("without a revision");
    expect(() => deformer.updateDynamics({ ...initialDynamics, morphWeights: { ...initialDynamics.morphWeights } })).toThrow("without a revision");
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("source upload failed"); });
    expect(() => deformer.setSource(sources(1, 1), dynamics())).toThrow("source upload failed"); expect(f.owned.size).toBe(9);
  });

  it("checks device capacity and releases resources on device loss", () => {
    const limited = fixture(); limited.device.limits.maxStorageBufferBindingSize = 16;
    const rejected = new GpuMorphSkinner(limited.session), value = sources();
    expect(() => rejected.setSource(value, dynamics())).toThrow("device limits"); expect(limited.buffers).toHaveLength(0);
    const f = fixture(), deformer = new GpuMorphSkinner(f.session); deformer.setSource(sources(), dynamics()); f.raw.state = "lost";
    expect(() => deformer.encode({} as GPUCommandEncoder)).toThrow("not ready"); expect(f.owned.size).toBe(0);
  });
});
