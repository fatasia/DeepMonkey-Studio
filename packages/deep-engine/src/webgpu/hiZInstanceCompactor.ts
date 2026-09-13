/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import { GPU_CULL_INDIRECT_STRIDE, GPU_CULL_INSTANCE_STRIDE,
  GPU_CULL_PREVIOUS_TRANSFORM_STRIDE } from "./gpuFrustumCulling.js";
import { HI_Z_OCCLUSION_MAX_INSTANCES, type HiZOcclusionIndirectResult } from "./hiZOcclusionCulling.js";
import { HI_Z_INSTANCE_COMPACTION_WGSL, HI_Z_INSTANCE_COMPACTION_WORKGROUP_SIZE } from "./hiZInstanceCompactorWgsl.js";

export interface HiZInstanceCompactionInput {
  /** Original PBR instance stream; only the first `count` rows are addressable. */
  readonly instances: GPUBuffer;
  /** Previous-submitted-frame model rows aligned one-to-one with `instances`. */
  readonly previousTransforms: GPUBuffer;
  readonly count: number;
  /** Logical allocation capacity of both source streams. */
  readonly capacity: number;
  readonly visibility: HiZOcclusionIndirectResult;
}

export interface HiZInstanceCompactionResult {
  readonly inputCount: number;
  readonly capacity: number;
  readonly instances: GPUBuffer;
  readonly previousTransforms: GPUBuffer;
  /** Borrowed from `visibility`; its instance count addresses the compacted streams. */
  readonly indirect: GPUBuffer;
  readonly visibleCount: GPUBuffer;
}

interface CompactionResources {
  readonly capacity: number;
  readonly instances: GPUBuffer;
  readonly previousTransforms: GPUBuffer;
  readonly sourceInstances: GPUBuffer;
  readonly sourcePrevious: GPUBuffer;
  readonly sourceCount: number;
  readonly visibleIndices: GPUBuffer;
  readonly visibleCount: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
}

/** Converts Hi-Z index indirection into the two contiguous PBR instance vertex streams. */
export class HiZInstanceCompactor {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private resources: CompactionResources | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession) {
    this.assertSessionReady();
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep Hi-Z instance compaction WGSL", code: HI_Z_INSTANCE_COMPACTION_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep Hi-Z instance compaction layout", entries: [
      ...[0, 1, 2, 3].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage" as const } })),
      ...[4, 5].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" as const } })),
    ] });
    this.pipeline = device.createComputePipeline({ label: "Deep Hi-Z instance compaction pipeline",
      layout: device.createPipelineLayout({ label: "Deep Hi-Z instance compaction pipeline layout", bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "compact" } });
  }

  encode(encoder: GPUCommandEncoder, input: HiZInstanceCompactionInput): HiZInstanceCompactionResult {
    this.assertReady();
    validateInput(this.session.device, input);
    const previous = this.resources;
    const desiredCapacity = input.visibility.capacity;
    const reusable = previous !== undefined && previous.capacity >= input.count
      && desiredCapacity * 4 >= previous.capacity;
    let candidate: CompactionResources | undefined;
    let allocated = false;
    try {
      if (reusable) {
        candidate = sameBindings(previous, input) ? previous : this.rebind(previous, input);
      } else {
        candidate = this.allocate(desiredCapacity, input);
        allocated = true;
      }
      const pass = encoder.beginComputePass({ label: "Deep Hi-Z instance compaction" });
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, candidate.bindGroup);
      pass.dispatchWorkgroups(Math.ceil(input.count / HI_Z_INSTANCE_COMPACTION_WORKGROUP_SIZE));
      pass.end();
      this.resources = candidate;
      if (previous && previous.instances !== candidate.instances) this.release(previous);
      return Object.freeze({ inputCount: input.count, capacity: candidate.capacity,
        instances: candidate.instances, previousTransforms: candidate.previousTransforms,
        indirect: input.visibility.indirect, visibleCount: input.visibility.visibleCount });
    } catch (error) {
      if (allocated && candidate) this.release(candidate);
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resources) this.release(this.resources);
    this.resources = undefined;
  }

  private allocate(capacity: number, input: HiZInstanceCompactionInput): CompactionResources {
    const created: GPUBuffer[] = [], device = this.session.device;
    const allocate = (label: string, size: number): GPUBuffer => {
      const value = this.session.own(device.createBuffer({ label, size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC }));
      created.push(value);
      return value;
    };
    try {
      const instances = allocate("Deep Hi-Z compacted instances", capacity * GPU_CULL_INSTANCE_STRIDE);
      const previousTransforms = allocate("Deep Hi-Z compacted previous transforms",
        capacity * GPU_CULL_PREVIOUS_TRANSFORM_STRIDE);
      return this.bind({ capacity, instances, previousTransforms }, input);
    } catch (error) {
      for (const value of created) this.session.release(value);
      throw error;
    }
  }

  private rebind(resources: CompactionResources, input: HiZInstanceCompactionInput): CompactionResources {
    return this.bind(resources, input);
  }

  private bind(owned: Pick<CompactionResources, "capacity" | "instances" | "previousTransforms">,
    input: HiZInstanceCompactionInput): CompactionResources {
    const borrowed = [input.instances, input.previousTransforms, input.visibility.visibleIndices,
      input.visibility.visibleCount] as const;
    const sizes = [input.count * GPU_CULL_INSTANCE_STRIDE, input.count * GPU_CULL_PREVIOUS_TRANSFORM_STRIDE,
      input.visibility.capacity * 4, 4] as const;
    const entries: GPUBindGroupEntry[] = [
      ...borrowed.map((buffer, binding) => ({ binding, resource: { buffer, size: sizes[binding]! } })),
      { binding: 4, resource: { buffer: owned.instances } },
      { binding: 5, resource: { buffer: owned.previousTransforms } },
    ];
    const bindGroup = this.session.device.createBindGroup({ label: "Deep Hi-Z instance compaction bindings",
      layout: this.layout, entries });
    return { ...owned, sourceInstances: input.instances, sourcePrevious: input.previousTransforms,
      sourceCount: input.count, visibleIndices: input.visibility.visibleIndices,
      visibleCount: input.visibility.visibleCount, bindGroup };
  }

  private assertSessionReady(): void {
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for Hi-Z instance compaction.");
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Hi-Z instance compactor is disposed.");
    if (this.session.state !== "ready") {
      if (this.resources) this.release(this.resources);
      this.resources = undefined;
      throw new Error("GPU session is not ready for Hi-Z instance compaction.");
    }
  }

  private release(resources: CompactionResources): void {
    this.session.release(resources.instances);
    this.session.release(resources.previousTransforms);
  }
}

function sameBindings(resources: CompactionResources, input: HiZInstanceCompactionInput): boolean {
  return resources.sourceInstances === input.instances && resources.sourcePrevious === input.previousTransforms
    && resources.sourceCount === input.count && resources.visibleIndices === input.visibility.visibleIndices
    && resources.visibleCount === input.visibility.visibleCount;
}

function validateInput(device: GPUDevice, input: HiZInstanceCompactionInput): void {
  if (!Number.isInteger(input.count) || input.count < 1 || input.count > HI_Z_OCCLUSION_MAX_INSTANCES
    || !Number.isInteger(input.capacity) || input.capacity < input.count || input.capacity > HI_Z_OCCLUSION_MAX_INSTANCES) {
    throw new Error("Invalid Hi-Z instance compaction count or capacity.");
  }
  const visibility = input.visibility;
  if (visibility.inputCount !== input.count || !Number.isInteger(visibility.capacity)
    || visibility.capacity < input.count || visibility.capacity > HI_Z_OCCLUSION_MAX_INSTANCES) {
    throw new Error("Hi-Z visibility does not match the instance compaction range.");
  }
  validateBuffer(input.instances, input.capacity * GPU_CULL_INSTANCE_STRIDE, GPUBufferUsage.STORAGE, "instance source");
  validateBuffer(input.previousTransforms, input.capacity * GPU_CULL_PREVIOUS_TRANSFORM_STRIDE,
    GPUBufferUsage.STORAGE, "previous-transform source");
  validateBuffer(visibility.visibleIndices, visibility.capacity * 4, GPUBufferUsage.STORAGE, "visible indices");
  validateBuffer(visibility.visibleCount, 4, GPUBufferUsage.STORAGE, "visible count");
  validateBuffer(visibility.indirect, GPU_CULL_INDIRECT_STRIDE, GPUBufferUsage.INDIRECT, "indirect arguments");
  const limit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
  if (visibility.capacity * GPU_CULL_INSTANCE_STRIDE > limit
    || visibility.capacity * GPU_CULL_PREVIOUS_TRANSFORM_STRIDE > limit) {
    throw new Error("Hi-Z instance compaction output exceeds device storage-buffer limits.");
  }
  if (Math.ceil(input.count / HI_Z_INSTANCE_COMPACTION_WORKGROUP_SIZE)
    > device.limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("Hi-Z instance compaction dispatch exceeds device limits.");
  }
}

function validateBuffer(buffer: GPUBuffer, size: number, usage: GPUBufferUsageFlags, label: string): void {
  if (!buffer || buffer.size < size || (buffer.usage & usage) === 0 || buffer.mapState !== "unmapped") {
    throw new Error(`Incompatible Hi-Z instance compaction ${label} buffer.`);
  }
}

export { HI_Z_INSTANCE_COMPACTION_WGSL, HI_Z_INSTANCE_COMPACTION_WORKGROUP_SIZE } from "./hiZInstanceCompactorWgsl.js";
