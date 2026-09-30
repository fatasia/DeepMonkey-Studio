import type { DeviceSession } from "./deviceSession.js";
import { GPU_PARTICLE_FRAME_UNIFORM_BYTES, GPU_PARTICLE_WORKGROUP_SIZE } from "./gpuParticleTypes.js";
import { GPU_PARTICLE_FLOW_ENTRY, GPU_PARTICLE_FLOW_FIELD_WGSL, GPU_PARTICLE_FLOW_UNIFORM_BYTES } from "./gpuParticleFlowFieldWgsl.js";

interface FlowSlot { readonly state: GPUBuffer; readonly counter: GPUBuffer; readonly indirect: GPUBuffer }
/** Borrows existing particle slots; the only owned allocation is one 32-byte uniform. */
export class GpuParticleFlowFieldStage {
  private readonly uniform: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private readonly groups: readonly GPUBindGroup[];
  private readonly device: GPUDevice;
  private disposed = false;
  constructor(private readonly session: DeviceSession, frameUniform: GPUBuffer, slots: readonly FlowSlot[]) {
    const device = session.device; this.device = device;
    if (device.limits.maxUniformBuffersPerShaderStage < 2) throw new Error("Particle flow requires two compute uniforms.");
    let uniform: GPUBuffer | undefined;
    try {
      const layout = device.createBindGroupLayout({ label: "Deep particle flow layout", entries: [
        ...Array.from({ length: 5 }, (_, binding): GPUBindGroupLayoutEntry => ({ binding,
          visibility: GPUShaderStage.COMPUTE, buffer: { type: binding === 0 ? "read-only-storage" : "storage" } })),
        ...[GPU_PARTICLE_FRAME_UNIFORM_BYTES, GPU_PARTICLE_FLOW_UNIFORM_BYTES].map((size, index): GPUBindGroupLayoutEntry => ({
          binding: index + 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", minBindingSize: size } })),
      ] });
      const module = device.createShaderModule({ label: "Deep particle flow WGSL", code: GPU_PARTICLE_FLOW_FIELD_WGSL });
      this.pipeline = device.createComputePipeline({ label: "Deep particle flow simulation pipeline",
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }), compute: { module, entryPoint: GPU_PARTICLE_FLOW_ENTRY } });
      uniform = session.own(device.createBuffer({ label: "Deep particle flow uniform", size: GPU_PARTICLE_FLOW_UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
      this.uniform = uniform;
      this.groups = Object.freeze(slots.map((source, index) => {
        const target = slots[index === 0 ? 1 : 0]!;
        return device.createBindGroup({ label: `Deep particle flow ${index}->${index === 0 ? 1 : 0}`, layout,
          entries: [source.state, source.counter, target.state, target.counter, target.indirect, frameUniform, this.uniform]
            .map((buffer, binding) => ({ binding, resource: { buffer } })) });
      }));
    } catch (error) { if (uniform) session.release(uniform); throw error; }
  }
  upload(bytes: ArrayBuffer): void {
    this.assertReady(); this.device.queue.writeBuffer(this.uniform, 0, bytes);
  }
  encode(pass: GPUComputePassEncoder, input: number, capacity: number): void {
    this.assertReady(); pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.groups[input]!);
    pass.dispatchWorkgroups(Math.ceil(capacity / GPU_PARTICLE_WORKGROUP_SIZE));
  }
  dispose(): void { if (!this.disposed) { this.disposed = true; this.session.release(this.uniform); } }
  private assertReady(): void {
    if (this.disposed || this.session.state !== "ready" || this.session.device !== this.device) throw new Error("Particle flow device epoch is no longer current.");
  }
}
