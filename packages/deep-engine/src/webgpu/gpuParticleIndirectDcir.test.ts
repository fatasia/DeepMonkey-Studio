import { describe, expect, it } from "vitest";
import { emitKernelWgsl, validateKernel } from "../shaderCompute/index.js";
import { buildGpuParticleIndirectKernel, GPU_PARTICLE_INDIRECT_DCIR } from "./gpuParticleIndirectDcir.js";

describe("GPU particle indirect DCIR consumer", () => {
  it("emits a texture-free buffer ABI with stable resource bindings", () => {
    expect(validateKernel(buildGpuParticleIndirectKernel())).toEqual([]);
    expect(GPU_PARTICLE_INDIRECT_DCIR.bindings).toEqual([
      { binding: 5, kind: "uniform", name: "uniforms" },
      { binding: 3, kind: "storage-buffer", name: "counter" },
      { binding: 4, kind: "storage-buffer", name: "indirect" },
    ]);
    expect(GPU_PARTICLE_INDIRECT_DCIR.code).not.toMatch(/texture_2d|texture_storage|textureStore/);
    expect(GPU_PARTICLE_INDIRECT_DCIR.code).toContain("deltaTime: f32,\n  drag: f32,\n  capacity: u32,\n  padding: u32,");
    expect(GPU_PARTICLE_INDIRECT_DCIR.code).not.toContain("fn deepPcg");
    expect(GPU_PARTICLE_INDIRECT_DCIR.code).toContain("var<storage, read_write> deep_counter: array<atomic<u32>>;");
    expect(GPU_PARTICLE_INDIRECT_DCIR.code).toContain("atomicLoad(&deep_counter[n_zero])");
    expect(GPU_PARTICLE_INDIRECT_DCIR.code.indexOf("if (!(n_firstInvocation)) { return; }")).toBeLessThan(
      GPU_PARTICLE_INDIRECT_DCIR.code.indexOf("deep_indirect[n_instanceCountIndex] = n_boundedCount;"));
  });

  it("is byte-stable across repeated compilation", () => {
    const next = emitKernelWgsl(buildGpuParticleIndirectKernel());
    expect(next).toEqual(GPU_PARTICLE_INDIRECT_DCIR);
  });

  it("rejects non-atomic counters and colliding host bindings", () => {
    const kernel = buildGpuParticleIndirectKernel();
    expect(validateKernel({ ...kernel, buffers: kernel.buffers!.map((buffer) =>
      buffer.name === "counter" ? { ...buffer, atomic: false } : buffer) })
      .some((issue) => issue.code === "buffer-not-atomic")).toBe(true);
    expect(validateKernel({ ...kernel, buffers: kernel.buffers!.map((buffer) =>
      buffer.name === "counter" ? { ...buffer, binding: 5 } : buffer) })
      .some((issue) => issue.code === "duplicate-binding")).toBe(true);
  });
});
