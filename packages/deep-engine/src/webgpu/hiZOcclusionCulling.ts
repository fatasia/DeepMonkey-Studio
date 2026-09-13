/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import { GPU_CULL_INDIRECT_STRIDE } from "./gpuFrustumCulling.js";
import type { HiZResult } from "./hiZPyramid.js";
import {
  HI_Z_OCCLUSION_MIN_INSTANCES,
  HI_Z_OCCLUSION_UNIFORM_SIZE,
  HI_Z_OCCLUSION_WORKGROUP_SIZE,
  type HiZOcclusionIndirectResult,
  type HiZOcclusionInput,
  type HiZOcclusionLastFrame,
  type HiZOcclusionOptions,
  type HiZOcclusionResources,
  type HiZOcclusionResult,
  type HiZOcclusionView,
} from "./hiZOcclusionTypes.js";
import {
  nextHiZOcclusionCapacity,
  packHiZOcclusionIndirect,
  validateHiZOcclusionRequest,
  type ValidatedHiZOcclusionRequest,
} from "./hiZOcclusionValidation.js";
import { HI_Z_OCCLUSION_WGSL } from "./hiZOcclusionWgsl.js";

export { hiZOcclusionMip, hiZOcclusionVisible, projectHiZOcclusionAabb } from "./hiZOcclusionProjection.js";
export type { HiZOcclusionProjection } from "./hiZOcclusionProjection.js";
export { HI_Z_OCCLUSION_MAX_INSTANCES, HI_Z_OCCLUSION_MIN_INSTANCES,
  HI_Z_OCCLUSION_WORKGROUP_SIZE } from "./hiZOcclusionTypes.js";
export type { HiZOcclusionDirectResult, HiZOcclusionIndirectResult, HiZOcclusionInput,
  HiZOcclusionOptions, HiZOcclusionResult, HiZOcclusionView } from "./hiZOcclusionTypes.js";
export { HI_Z_OCCLUSION_WGSL } from "./hiZOcclusionWgsl.js";

/** Independent Hi-Z occlusion culler. The renderer must explicitly consume its visible-index indirection. */
export class HiZOcclusionCuller {
  private readonly layout: GPUBindGroupLayout;
  private readonly cullPipeline: GPUComputePipeline;
  private readonly indirectPipeline: GPUComputePipeline;
  private resources: HiZOcclusionResources | undefined;
  private last: HiZOcclusionLastFrame | undefined;
  private disposed = false;

  constructor(private readonly session: DeviceSession) {
    this.assertSessionReady();
    const device = session.device, module = device.createShaderModule({ label: "Deep Hi-Z occlusion WGSL", code: HI_Z_OCCLUSION_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep Hi-Z occlusion layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
      ...[3, 4, 5, 6].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } })),
      { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ label: "Deep Hi-Z occlusion pipeline layout", bindGroupLayouts: [this.layout] });
    this.cullPipeline = device.createComputePipeline({ label: "Deep Hi-Z occlusion pipeline", layout: pipelineLayout,
      compute: { module, entryPoint: "cull" } });
    this.indirectPipeline = device.createComputePipeline({ label: "Deep Hi-Z occlusion indirect pipeline", layout: pipelineLayout,
      compute: { module, entryPoint: "writeIndirect" } });
  }

  encode(encoder: GPUCommandEncoder, input: HiZOcclusionInput, view: HiZOcclusionView,
    options: HiZOcclusionOptions = {}): HiZOcclusionResult {
    this.assertReady();
    const request = validateHiZOcclusionRequest(this.session.device, input, view, options);
    this.validateRevisions(input, view);
    if (input.count < HI_Z_OCCLUSION_MIN_INSTANCES) return this.direct(input.count);
    if (this.last && exactFrame(this.last, input, view, request)) return Object.freeze({ ...this.last.result, updated: false });
    const previous = this.resources, capacity = nextHiZOcclusionCapacity(input.count);
    const reusable = previous !== undefined && previous.capacity >= input.count && capacity * 4 >= previous.capacity;
    let candidate: HiZOcclusionResources | undefined;
    try {
      candidate = reusable ? previous : this.allocate(capacity, input, view.hiz);
      if (reusable && needsBinding(candidate, input, view.hiz)) candidate = this.rebind(candidate, input, view.hiz);
      const historyReset = shouldResetHistory(this.last, input, view, request);
      this.writeFrame(candidate, input, view, request);
      encoder.clearBuffer(candidate.visibleCount);
      if (historyReset) encoder.clearBuffer(candidate.history);
      this.encodePass(encoder, candidate, input.count);
      const result: HiZOcclusionIndirectResult = Object.freeze({ mode: "indirect", inputCount: input.count,
        capacity: candidate.capacity, visibleIndices: candidate.visibleIndices, visibleCount: candidate.visibleCount,
        indirect: candidate.indirect, historyReset, updated: true });
      this.resources = candidate;
      if (previous && previous.visibleIndices !== candidate.visibleIndices) this.release(previous);
      this.last = captureFrame(input, view, request, result);
      return result;
    } catch (error) {
      if (candidate && !reusable) this.release(candidate);
      if (previous) this.release(previous);
      this.resources = undefined; this.last = undefined;
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; if (this.resources) this.release(this.resources);
    this.resources = undefined; this.last = undefined;
  }

  private direct(inputCount: number): HiZOcclusionResult {
    if (this.resources) this.release(this.resources);
    this.resources = undefined; this.last = undefined;
    return Object.freeze({ mode: "direct", inputCount, updated: false });
  }

  private allocate(capacity: number, input: HiZOcclusionInput, hiz: HiZResult): HiZOcclusionResources {
    const device = this.session.device, created: GPUBuffer[] = [];
    const buffer = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const value = this.session.own(device.createBuffer({ label, size, usage })); created.push(value); return value;
    };
    try {
      const base = { capacity,
        visibleIndices: buffer("Deep Hi-Z visible indices", capacity * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
        visibleCount: buffer("Deep Hi-Z visible count", 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC),
        indirect: buffer("Deep Hi-Z indirect arguments", GPU_CULL_INDIRECT_STRIDE,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.INDIRECT),
        history: buffer("Deep Hi-Z visibility history", capacity * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST),
        uniform: buffer("Deep Hi-Z occlusion view", HI_Z_OCCLUSION_UNIFORM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      };
      return { ...base, inputInstances: input.instances, inputBounds: input.bounds, hizTexture: hiz.texture,
        hizMipLevelCount: hiz.mipLevelCount, ...this.createBinding(base, input, hiz) };
    } catch (error) { for (const value of created) this.session.release(value); throw error; }
  }

  private rebind(resources: HiZOcclusionResources, input: HiZOcclusionInput, hiz: HiZResult): HiZOcclusionResources {
    return { ...resources, inputInstances: input.instances, inputBounds: input.bounds,
      hizTexture: hiz.texture, hizMipLevelCount: hiz.mipLevelCount, ...this.createBinding(resources, input, hiz) };
  }

  private createBinding(resources: Pick<HiZOcclusionResources, "visibleIndices" | "visibleCount" | "indirect" | "history" | "uniform">,
    input: HiZOcclusionInput, hiz: HiZResult): Pick<HiZOcclusionResources, "hizView" | "bindGroup"> {
    const hizView = hiz.texture.createView({ label: "Deep Hi-Z occlusion pyramid view", format: "r32float", dimension: "2d",
      baseMipLevel: 0, mipLevelCount: hiz.mipLevelCount, baseArrayLayer: 0, arrayLayerCount: 1 });
    const buffers = [input.instances, input.bounds, resources.visibleIndices, resources.visibleCount,
      resources.indirect, resources.history, resources.uniform];
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: buffers[0]! } }, { binding: 1, resource: { buffer: buffers[1]! } },
      { binding: 2, resource: hizView }, ...buffers.slice(2).map((buffer, index) => ({ binding: index + 3, resource: { buffer } })),
    ];
    return { hizView, bindGroup: this.session.device.createBindGroup({ label: "Deep Hi-Z occlusion bindings", layout: this.layout, entries }) };
  }

  private writeFrame(resources: HiZOcclusionResources, input: HiZOcclusionInput, view: HiZOcclusionView,
    request: ValidatedHiZOcclusionRequest): void {
    const uniform = new ArrayBuffer(HI_Z_OCCLUSION_UNIFORM_SIZE), floats = new Float32Array(uniform), uints = new Uint32Array(uniform);
    floats.set(view.viewProjection, 0); floats.set([...view.cameraPosition, 1], 16); floats.set([view.viewport[0], view.viewport[1], 0, 0], 20);
    uints.set([input.count, resources.capacity, view.hiz.mipLevelCount,
      (view.reversedZ ? 1 : 0) | (request.temporal ? 2 : 0)], 24);
    floats.set([request.depthBias, request.nearClipEpsilon, 0, 0], 28);
    this.session.device.queue.writeBuffer(resources.uniform, 0, uniform);
    this.session.device.queue.writeBuffer(resources.indirect, 0, packHiZOcclusionIndirect(request.indexArgs));
  }

  private encodePass(encoder: GPUCommandEncoder, resources: HiZOcclusionResources, count: number): void {
    const pass = encoder.beginComputePass({ label: "Deep Hi-Z occlusion" });
    pass.setBindGroup(0, resources.bindGroup); pass.setPipeline(this.cullPipeline);
    pass.dispatchWorkgroups(Math.ceil(count / HI_Z_OCCLUSION_WORKGROUP_SIZE));
    pass.setPipeline(this.indirectPipeline); pass.dispatchWorkgroups(1); pass.end();
  }

  private validateRevisions(input: HiZOcclusionInput, view: HiZOcclusionView): void {
    if (this.last && input.revision < this.last.inputRevision) throw new Error("Stale Hi-Z occlusion input revision.");
    if (this.last && input.revision === this.last.inputRevision
      && (input.instances !== this.last.instances || input.bounds !== this.last.bounds || input.count !== this.last.inputCount)) {
      throw new Error("Hi-Z occlusion input changed without a revision.");
    }
    if (this.last && view.hiz.sourceRevision < this.last.hizRevision) throw new Error("Stale Hi-Z pyramid revision.");
    if (this.last && view.hiz.sourceRevision === this.last.hizRevision && view.hiz.texture !== this.last.hizTexture) {
      throw new Error("Hi-Z pyramid changed without a revision.");
    }
  }

  private release(resources: HiZOcclusionResources): void {
    this.session.release(resources.visibleIndices); this.session.release(resources.visibleCount);
    this.session.release(resources.indirect); this.session.release(resources.history); this.session.release(resources.uniform);
  }

  private assertSessionReady(): void {
    if (this.session.state !== "ready") throw new Error("GPU session is not ready for Hi-Z occlusion.");
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Hi-Z occlusion culler is disposed.");
    if (this.session.state !== "ready") {
      if (this.resources) this.release(this.resources);
      this.resources = undefined; this.last = undefined;
      throw new Error("GPU session is not ready for Hi-Z occlusion.");
    }
  }
}

function needsBinding(resources: HiZOcclusionResources, input: HiZOcclusionInput, hiz: HiZResult): boolean {
  return resources.inputInstances !== input.instances || resources.inputBounds !== input.bounds
    || resources.hizTexture !== hiz.texture || resources.hizMipLevelCount !== hiz.mipLevelCount;
}

function shouldResetHistory(last: HiZOcclusionLastFrame | undefined, input: HiZOcclusionInput,
  view: HiZOcclusionView, request: ValidatedHiZOcclusionRequest): boolean {
  return !request.temporal || request.cameraCut || !last || last.instances !== input.instances || last.bounds !== input.bounds
    || last.inputCount !== input.count || last.hizTexture !== view.hiz.texture
    || matrixDelta(last.viewProjection, view.viewProjection) > request.cameraJumpThreshold;
}

function captureFrame(input: HiZOcclusionInput, view: HiZOcclusionView, request: ValidatedHiZOcclusionRequest,
  result: HiZOcclusionIndirectResult): HiZOcclusionLastFrame {
  return { inputRevision: input.revision, inputCount: input.count, instances: input.instances, bounds: input.bounds,
    hizTexture: view.hiz.texture, hizRevision: view.hiz.sourceRevision, hizMipLevelCount: view.hiz.mipLevelCount,
    viewProjection: Array.from(view.viewProjection), cameraPosition: [...view.cameraPosition], viewport: [...view.viewport],
    reversedZ: view.reversedZ, temporal: request.temporal, depthBias: request.depthBias,
    nearClipEpsilon: request.nearClipEpsilon, indexArgs: request.indexArgs, result };
}

function exactFrame(last: HiZOcclusionLastFrame, input: HiZOcclusionInput, view: HiZOcclusionView,
  request: ValidatedHiZOcclusionRequest): boolean {
  return last.inputRevision === input.revision && last.inputCount === input.count && last.instances === input.instances && last.bounds === input.bounds
    && last.hizTexture === view.hiz.texture && last.hizRevision === view.hiz.sourceRevision && last.hizMipLevelCount === view.hiz.mipLevelCount
    && last.reversedZ === view.reversedZ && last.temporal === request.temporal && !request.cameraCut
    && last.depthBias === request.depthBias && last.nearClipEpsilon === request.nearClipEpsilon
    && last.cameraPosition.every((value, index) => value === view.cameraPosition[index])
    && last.viewport.every((value, index) => value === view.viewport[index])
    && last.indexArgs.every((value, index) => value === request.indexArgs[index]) && matrixDelta(last.viewProjection, view.viewProjection) === 0;
}

function matrixDelta(previous: ArrayLike<number>, current: ArrayLike<number>): number {
  let largest = 0;
  for (let index = 0; index < current.length; index++) largest = Math.max(largest, Math.abs(current[index]! - previous[index]!));
  return largest;
}
