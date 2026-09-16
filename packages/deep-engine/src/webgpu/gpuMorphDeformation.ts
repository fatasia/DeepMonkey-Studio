/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import type { DeformationStaticUpload } from "./deformationStaticSources.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";
import { assertMorphWeightRange, packMorphWeights, prepareMorphInput } from "./gpuMorphPacking.js";
import type { GpuMorphResult, GpuMorphSource, GpuMorphWeights, PreparedMorphInput } from "./gpuMorphTypes.js";
import { GPU_MORPH_VERTEX_STRIDE, GPU_MORPH_WGSL, GPU_MORPH_WORKGROUP_SIZE } from "./gpuMorphWgsl.js";

interface MorphResources {
  readonly sourceBuffer: GPUBuffer;
  readonly deltaBuffer: GPUBuffer;
  readonly outputBuffer: GPUBuffer;
  readonly weightBuffers: readonly [GPUBuffer, GPUBuffer];
  readonly uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  activeWeights: 0 | 1;
  readonly vertexCount: number;
  readonly targetCount: number;
  readonly flags: number;
  readonly maximumBaseMagnitude: number;
  readonly maximumDeltaMagnitude: number;
  readonly source: GpuMorphSource;
  weights: GpuMorphWeights;
}

/** Applies glTF-compatible morph targets in a compute pass with atomic, reusable weight updates. */
export class GpuMorphDeformer {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private resources: MorphResources | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession, private readonly staticUpload?: DeformationStaticUpload) {
    if (staticUpload && staticUpload.session !== session) throw new Error("Morph static lease belongs to another device epoch.");
    if (session.state !== "ready") throw new Error("GPU session is not ready for morph deformation.");
    const device = session.device, module = device.createShaderModule({ label: "Deep GPU morph WGSL", code: GPU_MORPH_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep GPU morph layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ] });
    this.pipeline = device.createComputePipeline({ label: "Deep GPU morph pipeline",
      layout: device.createPipelineLayout({ label: "Deep GPU morph pipeline layout", bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: "deformMorphVertices" } });
  }

  get vertexCount(): number { return this.resources?.vertexCount ?? 0; }
  get targetCount(): number { return this.resources?.targetCount ?? 0; }

  setSource(source: GpuMorphSource, weights: GpuMorphWeights): boolean {
    this.assertReady();
    const current = this.resources;
    if (current && this.staticUpload && source.revision !== current.source.revision) throw new Error("Shared morph source lease cannot change revision.");
    if (current && source.revision < current.source.revision) throw new Error("Stale morph source revision.");
    if (current && source.revision === current.source.revision) {
      if (source !== current.source) throw new Error("Morph source changed without a revision.");
      return this.updateWeights(weights);
    }
    const prepared = prepareMorphInput(source, weights), device = this.session.device;
    validateDeviceCapacity(device, prepared);
    const created: GPUBuffer[] = [];
    const allocate = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const buffer = this.session.own(device.createBuffer({ label, size, usage })); created.push(buffer); return buffer;
    };
    let candidate: MorphResources;
    try {
      const sourceBuffer = this.staticUpload?.upload("Deep morph source", prepared.vertices)
        ?? allocate("Deep morph source", prepared.vertices.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const deltaBuffer = this.staticUpload?.upload("Deep morph targets", prepared.deltas)
        ?? allocate("Deep morph targets", prepared.deltas.byteLength, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
      const outputBuffer = allocate("Deep morphed vertices", prepared.vertexCount * GPU_MORPH_VERTEX_STRIDE,
        GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC);
      const weightBuffers = [0, 1].map((index) => allocate(`Deep morph weights ${index}`, prepared.weights.byteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST)) as [GPUBuffer, GPUBuffer];
      const uniformBuffer = allocate("Deep morph parameters", 16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
      if (!this.staticUpload) { device.queue.writeBuffer(sourceBuffer, 0, prepared.vertices);
        device.queue.writeBuffer(deltaBuffer, 0, prepared.deltas); }
      device.queue.writeBuffer(weightBuffers[0], 0, prepared.weights);
      device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([prepared.vertexCount, prepared.targetCount, prepared.flags, 0]));
      const bindGroup = this.binding(sourceBuffer, deltaBuffer, weightBuffers[0], outputBuffer, uniformBuffer);
      candidate = { sourceBuffer, deltaBuffer, outputBuffer, weightBuffers, uniformBuffer, bindGroup, activeWeights: 0,
        vertexCount: prepared.vertexCount, targetCount: prepared.targetCount, flags: prepared.flags,
        maximumBaseMagnitude: prepared.maximumBaseMagnitude, maximumDeltaMagnitude: prepared.maximumDeltaMagnitude, source, weights };
    } catch (error) {
      failWithResourceCleanup(error, "Morph preparation failed.", created.map(buffer => () => this.session.release(buffer)));
    }
    this.resources = candidate;
    if (current) this.release(current);
    return true;
  }

  updateWeights(weights: GpuMorphWeights): boolean {
    this.assertReady(); const resources = this.resources;
    if (!resources) throw new Error("Morph source is not prepared.");
    if (weights.revision < resources.weights.revision) throw new Error("Stale morph weights revision.");
    if (weights.revision === resources.weights.revision) {
      if (weights !== resources.weights) throw new Error("Morph weights changed without a revision.");
      return false;
    }
    const packed = packMorphWeights(weights, resources.targetCount), next = resources.activeWeights === 0 ? 1 : 0;
    assertMorphWeightRange(packed, resources.maximumBaseMagnitude, resources.maximumDeltaMagnitude);
    this.session.device.queue.writeBuffer(resources.weightBuffers[next], 0, packed);
    const bindGroup = this.binding(resources.sourceBuffer, resources.deltaBuffer, resources.weightBuffers[next],
      resources.outputBuffer, resources.uniformBuffer);
    resources.bindGroup = bindGroup; resources.activeWeights = next; resources.weights = weights;
    return true;
  }

  encode(encoder: GPUCommandEncoder): GpuMorphResult {
    this.assertReady(); const resources = this.resources;
    if (!resources) throw new Error("Morph source is not prepared.");
    const pass = encoder.beginComputePass({ label: "Deep GPU morph deformation" });
    let failure: { error: unknown } | undefined;
    try {
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, resources.bindGroup);
      pass.dispatchWorkgroups(Math.ceil(resources.vertexCount / GPU_MORPH_WORKGROUP_SIZE));
    } catch (error) { failure = { error }; }
    finally {
      if (failure) failWithResourceCleanup(failure.error, "Morph encode failed.", [() => pass.end()]);
      pass.end();
    }
    return Object.freeze({ output: resources.outputBuffer, vertexCount: resources.vertexCount, outputStride: GPU_MORPH_VERTEX_STRIDE,
      hasNormals: (resources.flags & 1) !== 0, hasTangents: (resources.flags & 2) !== 0,
      sourceRevision: resources.source.revision, weightsRevision: resources.weights.revision });
  }

  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    const resources = this.resources; this.resources = undefined;
    if (resources) this.release(resources);
  }

  private binding(source: GPUBuffer, deltas: GPUBuffer, weights: GPUBuffer, output: GPUBuffer, uniform: GPUBuffer): GPUBindGroup {
    return this.session.device.createBindGroup({ label: "Deep GPU morph bindings", layout: this.layout, entries: [
      { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: deltas } },
      { binding: 2, resource: { buffer: weights } }, { binding: 3, resource: { buffer: output } },
      { binding: 4, resource: { buffer: uniform } },
    ] });
  }
  private assertReady(): void {
    if (this.disposed) throw new Error("GPU morph deformer is disposed.");
    if (this.session.state !== "ready") {
      const resources = this.resources; this.resources = undefined;
      failWithResourceCleanup(new Error("GPU session is not ready for morph deformation."), "Morph device cleanup failed.",
        resources ? [() => this.release(resources)] : []);
    }
  }
  private release(resources: MorphResources): void {
    runResourceCleanup("Morph resource cleanup failed.", [...(this.staticUpload ? [] : [resources.sourceBuffer, resources.deltaBuffer]), resources.outputBuffer,
      ...resources.weightBuffers, resources.uniformBuffer].map(buffer => () => this.session.release(buffer)));
  }
}

function validateDeviceCapacity(device: GPUDevice, prepared: PreparedMorphInput): void {
  const limits = device.limits, storageLimit = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
  const largest = Math.max(prepared.vertices.byteLength, prepared.deltas.byteLength,
    prepared.vertexCount * GPU_MORPH_VERTEX_STRIDE, prepared.weights.byteLength);
  if (largest > storageLimit) throw new Error("Morph buffers exceed the device storage-buffer limit.");
  if (Math.ceil(prepared.vertexCount / GPU_MORPH_WORKGROUP_SIZE) > limits.maxComputeWorkgroupsPerDimension) {
    throw new Error("Morph dispatch exceeds the device workgroup limit.");
  }
}

export { assertMorphWeightRange, cpuDeformMorphVertices, packMorphWeights, prepareMorphInput } from "./gpuMorphPacking.js";
export { GPU_MORPH_DELTA_STRIDE, GPU_MORPH_FLAG_NORMAL, GPU_MORPH_FLAG_TANGENT, GPU_MORPH_VERTEX_STRIDE,
  GPU_MORPH_WGSL, GPU_MORPH_WORKGROUP_SIZE } from "./gpuMorphWgsl.js";
export type { GpuMorphResult, GpuMorphSource, GpuMorphWeights, PreparedMorphInput } from "./gpuMorphTypes.js";
