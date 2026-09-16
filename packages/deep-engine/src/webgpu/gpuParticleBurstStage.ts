import type { DeviceSession } from "./deviceSession.js";
import {
  GPU_PARTICLE_BURST_UNIFORM_BYTES, packGpuParticleBurstFrame, resolveGpuParticleBurstOptions,
  type GpuParticleBurstEvent, type GpuParticleBurstEvidence, type GpuParticleBurstOptions,
  type PackedGpuParticleBurstFrame, type ResolvedGpuParticleBurstOptions,
} from "./gpuParticleBurstTypes.js";
import { GPU_PARTICLE_BURST_WGSL } from "./gpuParticleBurstWgsl.js";

interface WritableParticleSlot { readonly state: GPUBuffer; readonly counter: GPUBuffer }

/** Optional GPU-only event expansion stage owned by one GpuParticleRuntime. */
export class GpuParticleBurstStage {
  readonly options: ResolvedGpuParticleBurstOptions;
  private readonly eventBuffer: GPUBuffer;
  private readonly uniformBuffer: GPUBuffer;
  private readonly reservationBuffer: GPUBuffer;
  private readonly pipelines: readonly [GPUComputePipeline, GPUComputePipeline];
  private readonly bindings: readonly GPUBindGroup[];
  private released = false;

  constructor(private readonly session: DeviceSession, capacity: number,
    options: GpuParticleBurstOptions, slots: readonly WritableParticleSlot[]) {
    this.options = resolveGpuParticleBurstOptions(capacity, options);
    let eventBuffer: GPUBuffer | undefined, uniformBuffer: GPUBuffer | undefined,
      reservationBuffer: GPUBuffer | undefined;
    try {
      const device = session.device;
      const module = device.createShaderModule({ label: "Deep GPU particle burst WGSL",
        code: GPU_PARTICLE_BURST_WGSL });
      const layout = device.createBindGroupLayout({ label: "Deep GPU particle burst layout", entries: [
        storage(0), storage(1), storage(2, true),
        { binding: 3, visibility: GPUShaderStage.COMPUTE,
          buffer: { type: "uniform", minBindingSize: GPU_PARTICLE_BURST_UNIFORM_BYTES } },
        storage(4),
      ] });
      const pipelineLayout = device.createPipelineLayout({ label: "Deep GPU particle burst pipeline layout",
        bindGroupLayouts: [layout] });
      this.pipelines = Object.freeze([
        device.createComputePipeline({ label: "Deep particle burst reserve pipeline",
          layout: pipelineLayout, compute: { module, entryPoint: "reserveBursts" } }),
        device.createComputePipeline({ label: "Deep particle burst spawn pipeline",
          layout: pipelineLayout, compute: { module, entryPoint: "spawnBursts" } }),
      ]);
      eventBuffer = session.own(device.createBuffer({ label: "Deep particle burst events",
        size: this.options.eventBufferBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      uniformBuffer = session.own(device.createBuffer({ label: "Deep particle burst params",
        size: GPU_PARTICLE_BURST_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
      reservationBuffer = session.own(device.createBuffer({ label: "Deep particle burst reservation",
        size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }));
      this.eventBuffer = eventBuffer; this.uniformBuffer = uniformBuffer; this.reservationBuffer = reservationBuffer;
      this.bindings = Object.freeze(slots.map((slot, index) => device.createBindGroup({
        label: `Deep particle burst output ${index}`, layout, entries: [
          slot.state, slot.counter, this.eventBuffer, this.uniformBuffer, this.reservationBuffer,
        ].map((buffer, binding) => ({ binding, resource: { buffer } })),
      })));
    } catch (error) {
      if (reservationBuffer) session.release(reservationBuffer);
      if (uniformBuffer) session.release(uniformBuffer); if (eventBuffer) session.release(eventBuffer);
      throw error;
    }
  }

  prepare(events: readonly GpuParticleBurstEvent[], frame: number, capacity: number): PackedGpuParticleBurstFrame {
    return packGpuParticleBurstFrame(events, frame, capacity, this.options);
  }
  upload(packet: PackedGpuParticleBurstFrame): void {
    if (packet.evidence.submittedEventCount === 0) return;
    this.session.device.queue.writeBuffer(this.eventBuffer, 0, packet.eventBytes);
    this.session.device.queue.writeBuffer(this.uniformBuffer, 0, packet.uniformBytes);
  }
  encode(pass: GPUComputePassEncoder, target: number, packet: PackedGpuParticleBurstFrame): boolean {
    if (packet.evidence.submittedEventCount === 0) return false;
    pass.setPipeline(this.pipelines[0]); pass.setBindGroup(0, this.bindings[target]!); pass.dispatchWorkgroups(1);
    pass.setPipeline(this.pipelines[1]);
    pass.dispatchWorkgroups(packet.dispatchX, packet.dispatchY);
    return true;
  }
  evidence(packet: PackedGpuParticleBurstFrame): GpuParticleBurstEvidence { return packet.evidence; }
  dispose(): void {
    if (this.released) return; this.released = true;
    this.session.release(this.reservationBuffer); this.session.release(this.uniformBuffer);
    this.session.release(this.eventBuffer);
  }
}

function storage(binding: number, readOnly = false): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE,
    buffer: { type: readOnly ? "read-only-storage" : "storage" } };
}
