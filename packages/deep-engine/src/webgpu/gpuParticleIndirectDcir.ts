import { emitKernelWgsl, KernelBuilder } from "../shaderCompute/index.js";
import type { DcirKernel } from "../shaderCompute/types.js";

/** DCIR-owned buffer-only kernel that publishes the compacted particle count to drawIndirect. */
export function buildGpuParticleIndirectKernel(): DcirKernel {
  const nodes = new KernelBuilder();
  const gid = nodes.push({ id: "gid", type: "vec2u", op: "global-invocation-id" });
  const invocation = nodes.push({ id: "invocation", type: "u32", op: "component", input: gid, component: 0 });
  const zero = nodes.push({ id: "zero", type: "u32", op: "literal", value: 0 });
  const guard = nodes.push({ id: "firstInvocation", type: "bool", op: "ieq", inputs: [invocation, zero] });
  const count = nodes.push({ id: "count", type: "u32", op: "atomic-load", buffer: "counter", index: zero });
  const capacity = nodes.push({ id: "capacity", type: "u32", op: "kernel-uniform", uniform: "capacity" });
  const boundedCount = nodes.push({ id: "boundedCount", type: "u32", op: "imin", inputs: [count, capacity] });
  const instanceCountIndex = nodes.push({ id: "instanceCountIndex", type: "u32", op: "literal", value: 1 });
  nodes.push({ id: "publishCount", type: "u32", op: "buffer-store", buffer: "indirect",
    index: instanceCountIndex, value: boundedCount });
  return {
    name: "write_particle_indirect",
    workgroupSize: [1, 1],
    // Match the first 16 bytes of GpuParticle FrameParams so the existing production bind group is reused.
    uniforms: [
      { name: "deltaTime", type: "f32" }, { name: "drag", type: "f32" },
      { name: "capacity", type: "u32" }, { name: "padding", type: "u32" },
    ],
    uniformBinding: 5,
    buffers: [
      { name: "counter", elementType: "u32", access: "read_write", atomic: true, binding: 3 },
      { name: "indirect", elementType: "u32", access: "read_write", binding: 4 },
    ],
    nodes: nodes.nodes(), guard,
  };
}

export const GPU_PARTICLE_INDIRECT_DCIR = emitKernelWgsl(buildGpuParticleIndirectKernel());
