import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { GpuSkinner } from "./gpuSkinning.js";
import { GpuMorphDeformer } from "./gpuMorphDeformation.js";
import { GpuMorphSkinner } from "./gpuMorphSkinning.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, VERTEX: 8, UNIFORM: 16 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(kind: "skin" | "morph" | "fused") {
  const buffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [], owned = new Set<object>();
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30, maxComputeWorkgroupsPerDimension: 65_535 },
    queue: { writeBuffer: vi.fn() }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn(() => { const buffer = { destroy: vi.fn() }; buffers.push(buffer); return buffer; }),
  };
  const raw = { state: "ready", device, own<T extends object>(buffer: T) { owned.add(buffer); return buffer; },
    release(buffer: { destroy(): void }) { if (owned.delete(buffer)) buffer.destroy(); } };
  const session = raw as unknown as DeviceSession;
  const renderer = kind === "skin" ? new GpuSkinner(session) : kind === "morph" ? new GpuMorphDeformer(session) : new GpuMorphSkinner(session);
  const set = (revision: number) => {
    const positions = new Float32Array([0, 0, 0]), normals = new Float32Array([0, 0, 1]);
    const skinning = { revision, positions, normals, joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) };
    const morph = { revision, positions, normals, primitive: { id: "morph", sourceMeshIndex: 0, sourcePrimitiveIndex: 0,
      vertexCount: 1, targets: [{ index: 0, name: "target", positionDeltas: new Float32Array([1, 0, 0]) }] } };
    const palette = { revision, matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
    const weights = { revision, values: new Float32Array([0.5]) };
    if (renderer instanceof GpuSkinner) return renderer.setSource(skinning, palette);
    if (renderer instanceof GpuMorphDeformer) return renderer.setSource(morph, weights);
    return renderer.setSource({ morph, skinning }, { morphWeights: weights, palette });
  };
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const encoder = { beginComputePass: vi.fn(() => pass) } as unknown as GPUCommandEncoder;
  const encode = () => renderer.encode(encoder);
  return { raw, device, renderer, set, encode, pass, buffers, owned };
}

function failures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
}

describe.each(["skin", "morph", "fused"] as const)("%s resource ownership failures", kind => {
  it("preserves old active output and triggering error while rolling back all candidate buffers", () => {
    const f = fixture(kind); f.set(0);
    const original = f.encode().output, oldCount = f.buffers.length;
    const trigger = new Error("binding failed"), cleanup = new Error("rollback destroy failed");
    f.device.createBindGroup.mockImplementationOnce(() => {
      f.buffers[oldCount]!.destroy.mockImplementation(() => { throw cleanup; });
      throw trigger;
    });
    let caught: unknown;
    try { f.set(1); } catch (error) { caught = error; }
    expect(failures(caught)).toEqual([trigger, cleanup]);
    expect(f.encode().output).toBe(original);
    expect(f.owned.size).toBe(oldCount);
    expect(f.buffers.slice(oldCount).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.buffers.slice(0, oldCount).every(buffer => buffer.destroy.mock.calls.length === 0)).toBe(true);
  });

  it("keeps the newly published output alive if retiring old buffers fails", () => {
    const f = fixture(kind); f.set(0);
    const previous = f.encode().output, oldCount = f.buffers.length;
    f.buffers[0]!.destroy.mockImplementation(() => { throw new Error("retirement failed"); });
    expect(() => f.set(1)).toThrow(AggregateError);
    const current = f.encode().output;
    expect(current).not.toBe(previous); expect(f.renderer.vertexCount).toBe(1);
    expect(f.buffers.slice(0, oldCount).every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.buffers.slice(oldCount).every(buffer => buffer.destroy.mock.calls.length === 0)).toBe(true);
    expect(f.owned.size).toBe(oldCount);
    f.renderer.dispose(); expect(f.owned.size).toBe(0);
  });

  it.each(["dispose", "lost"] as const)("detaches before %s cleanup and attempts every buffer exactly once", mode => {
    const f = fixture(kind); f.set(0);
    f.buffers[0]!.destroy.mockImplementation(() => {
      expect(f.renderer.vertexCount).toBe(0);
      throw new Error("destroy failed");
    });
    if (mode === "lost") f.raw.state = "lost";
    expect(() => mode === "dispose" ? f.renderer.dispose() : f.encode()).toThrow(AggregateError);
    expect(f.renderer.vertexCount).toBe(0); expect(f.owned.size).toBe(0);
    expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(() => f.encode()).toThrow(mode === "dispose" ? "disposed" : "not ready");
    f.renderer.dispose();
    expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });

  it.each(["setPipeline", "setBindGroup", "dispatchWorkgroups"] as const)("ends the pass if %s throws, retaining both encode and end errors", step => {
    const f = fixture(kind); f.set(0);
    const trigger = new Error(step), cleanup = new Error("end failed");
    f.pass[step].mockImplementation(() => { throw trigger; });
    f.pass.end.mockImplementation(() => { throw cleanup; });
    let caught: unknown;
    try { f.encode(); } catch (error) { caught = error; }
    expect(failures(caught)).toEqual([trigger, cleanup]);
    expect(f.pass.end).toHaveBeenCalledTimes(1);
    expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 0)).toBe(true);
  });
});
