/// <reference types="@webgpu/types" />
import type { DeviceSession } from "./deviceSession.js";
import type { HiZResult } from "./hiZPyramid.js";
import { MESHLET_CULL_WGSL, MESHLET_CULL_WORKGROUP_SIZE } from "./meshletCullingWgsl.js";
import { nextMeshletCapacity, validateMeshletCull, type ValidatedMeshletCull } from "./meshletCullingValidation.js";
import {
  MESHLET_CULL_MIN_COUNT,
  MESHLET_CULL_UNIFORM_SIZE,
  MESHLET_PLANNER_RECORD_STRIDE,
  type MeshletCullingGpuResult,
  type MeshletCullingInput,
  type MeshletCullingOptions,
  type MeshletCullingResult,
  type MeshletCullingView,
} from "./meshletCullingTypes.js";

interface MeshletCullResources {
  readonly capacity: number;
  readonly flags: GPUBuffer;
  readonly localPrefix: GPUBuffer;
  readonly blockOffsets: GPUBuffer;
  readonly visibleIndices: GPUBuffer;
  readonly visibleRecords: GPUBuffer;
  readonly visibleCount: GPUBuffer;
  readonly uniform: GPUBuffer;
  inputDescriptors: GPUBuffer;
  inputBounds: GPUBuffer;
  hizTexture: GPUTexture | undefined;
  hizMipLevelCount: number;
  hizView: GPUTextureView;
  bindGroup: GPUBindGroup;
}

interface RevisionIdentity {
  readonly revision: number;
  readonly count: number;
  readonly descriptors: GPUBuffer;
  readonly bounds: GPUBuffer;
}

interface HiZIdentity { readonly revision: number; readonly texture: GPUTexture }

interface LastMeshletCull {
  readonly input: RevisionIdentity;
  readonly request: ValidatedMeshletCull;
  readonly result: MeshletCullingGpuResult;
}

/** Independent, stable-order GPU culler for the Deep meshlet ABI. */
export class MeshletCuller {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelines: readonly GPUComputePipeline[];
  private readonly fallbackTexture: GPUTexture;
  private readonly fallbackView: GPUTextureView;
  private resources: MeshletCullResources | undefined;
  private inputIdentity: RevisionIdentity | undefined;
  private hizIdentity: HiZIdentity | undefined;
  private last: LastMeshletCull | undefined;
  private fallbackAlive = true;
  private disposed = false;

  constructor(private readonly session: DeviceSession) {
    if (session.state !== "ready") throw new Error("GPU session is not ready for meshlet culling.");
    const device = session.device;
    const module = device.createShaderModule({ label: "Deep meshlet culling WGSL", code: MESHLET_CULL_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep meshlet culling layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "unfilterable-float", viewDimension: "2d", multisampled: false } },
      ...[3, 4, 5, 6, 7, 8].map(binding => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" as const } })),
      { binding: 9, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ label: "Deep meshlet culling pipeline layout", bindGroupLayouts: [this.layout] });
    this.pipelines = ["classify", "scanLocal", "scanBlocks", "compact"].map(entryPoint => device.createComputePipeline({
      label: `Deep meshlet ${entryPoint} pipeline`, layout: pipelineLayout, compute: { module, entryPoint },
    }));
    let fallback: GPUTexture | undefined;
    try {
      fallback = session.own(device.createTexture({ label: "Deep meshlet no-Hi-Z fallback", size: [1, 1, 1],
        format: "r32float", usage: GPUTextureUsage.TEXTURE_BINDING }));
      this.fallbackTexture = fallback;
      this.fallbackView = fallback.createView({ label: "Deep meshlet no-Hi-Z fallback view" });
    } catch (error) {
      if (fallback) session.release(fallback);
      throw error;
    }
  }

  encode(encoder: GPUCommandEncoder, input: MeshletCullingInput, view: MeshletCullingView,
    options: MeshletCullingOptions = {}): MeshletCullingResult {
    this.assertReady();
    const request = validateMeshletCull(this.session.device, input, view, options);
    this.validateRevisions(input, request.hiz);
    if (input.count < MESHLET_CULL_MIN_COUNT) {
      this.releaseOutputs(); this.last = undefined;
      this.commitIdentities(input, request.hiz);
      return Object.freeze({ mode: "direct", inputCount: input.count, updated: false });
    }
    if (this.last && exactRequest(this.last, input, request)) return Object.freeze({ ...this.last.result, updated: false });

    const previous = this.resources;
    const reusable = previous !== undefined && previous.capacity >= input.count && request.capacity * 4 >= previous.capacity;
    let candidate: MeshletCullResources | undefined;
    try {
      candidate = reusable ? previous : this.allocate(request.capacity, input, request.hiz);
      if (reusable && needsBinding(candidate, input, request.hiz)) candidate = this.rebind(candidate, input, request.hiz);
      this.writeUniform(candidate.uniform, input.count, request);
      const pass = encoder.beginComputePass({ label: "Deep stable meshlet culling" });
      pass.setBindGroup(0, candidate.bindGroup);
      pass.setPipeline(this.pipelines[0]!); pass.dispatchWorkgroups(request.workgroups);
      pass.setPipeline(this.pipelines[1]!); pass.dispatchWorkgroups(request.workgroups);
      pass.setPipeline(this.pipelines[2]!); pass.dispatchWorkgroups(1);
      pass.setPipeline(this.pipelines[3]!); pass.dispatchWorkgroups(request.workgroups);
      pass.end();
      const result: MeshletCullingGpuResult = Object.freeze({ mode: "gpu", inputCount: input.count,
        capacity: candidate.capacity, visibleIndices: candidate.visibleIndices, visibleCount: candidate.visibleCount,
        visibleRecords: candidate.visibleRecords, recordStride: MESHLET_PLANNER_RECORD_STRIDE,
        hizTested: Boolean(request.hiz), normalConeTested: request.normalCone, updated: true });
      this.resources = candidate;
      if (previous && previous.visibleIndices !== candidate.visibleIndices) this.release(previous);
      this.commitIdentities(input, request.hiz);
      this.last = { input: identity(input), request, result };
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
    this.disposed = true; this.releaseOutputs(); this.releaseFallback();
    this.last = undefined; this.inputIdentity = undefined; this.hizIdentity = undefined;
  }

  private allocate(capacity: number, input: MeshletCullingInput, hiz: HiZResult | undefined): MeshletCullResources {
    const created: GPUBuffer[] = [], device = this.session.device;
    const buffer = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
      const resource = this.session.own(device.createBuffer({ label, size, usage })); created.push(resource); return resource;
    };
    try {
      const base = {
        capacity,
        flags: buffer("Deep meshlet visibility flags", capacity * 4, GPUBufferUsage.STORAGE),
        localPrefix: buffer("Deep meshlet local prefix", capacity * 4, GPUBufferUsage.STORAGE),
        blockOffsets: buffer("Deep meshlet block offsets", Math.ceil(capacity / MESHLET_CULL_WORKGROUP_SIZE) * 4, GPUBufferUsage.STORAGE),
        visibleIndices: buffer("Deep visible meshlet indices", capacity * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
        visibleRecords: buffer("Deep visible meshlet planner records", capacity * MESHLET_PLANNER_RECORD_STRIDE,
          GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
        visibleCount: buffer("Deep visible meshlet count", 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC),
        uniform: buffer("Deep meshlet culling view", MESHLET_CULL_UNIFORM_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
      };
      const binding = this.createBinding(base, input, hiz);
      return { ...base, inputDescriptors: input.descriptors, inputBounds: input.bounds,
        hizTexture: hiz?.texture, hizMipLevelCount: hiz?.mipLevelCount ?? 1, ...binding };
    } catch (error) {
      for (const resource of created) this.session.release(resource);
      throw error;
    }
  }

  private rebind(resources: MeshletCullResources, input: MeshletCullingInput, hiz: HiZResult | undefined): MeshletCullResources {
    const binding = this.createBinding(resources, input, hiz);
    return { ...resources, inputDescriptors: input.descriptors, inputBounds: input.bounds,
      hizTexture: hiz?.texture, hizMipLevelCount: hiz?.mipLevelCount ?? 1, ...binding };
  }

  private createBinding(resources: Pick<MeshletCullResources, "flags" | "localPrefix" | "blockOffsets" | "visibleIndices" | "visibleRecords" | "visibleCount" | "uniform">,
    input: MeshletCullingInput, hiz: HiZResult | undefined): Pick<MeshletCullResources, "hizView" | "bindGroup"> {
    const hizView = hiz ? hiz.texture.createView({ label: "Deep meshlet Hi-Z view", format: "r32float", dimension: "2d",
      baseMipLevel: 0, mipLevelCount: hiz.mipLevelCount, baseArrayLayer: 0, arrayLayerCount: 1 }) : this.fallbackView;
    const buffers = [input.descriptors, input.bounds, resources.flags, resources.localPrefix, resources.blockOffsets,
      resources.visibleIndices, resources.visibleRecords, resources.visibleCount, resources.uniform];
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: buffers[0]! } }, { binding: 1, resource: { buffer: buffers[1]! } },
      { binding: 2, resource: hizView },
      ...buffers.slice(2).map((buffer, offset) => ({ binding: offset + 3, resource: { buffer } })),
    ];
    return { hizView, bindGroup: this.session.device.createBindGroup({ label: "Deep meshlet culling bindings", layout: this.layout, entries }) };
  }

  private writeUniform(buffer: GPUBuffer, count: number, request: ValidatedMeshletCull): void {
    const data = new ArrayBuffer(MESHLET_CULL_UNIFORM_SIZE), floats = new Float32Array(data), uints = new Uint32Array(data);
    floats.set(request.viewProjection, 0); floats.set(request.worldFromObject, 16); floats.set(request.coneCamera, 32);
    floats.set([...request.cameraPosition, 1], 36); floats.set(request.frustum, 40); floats.set([...request.viewport, 0, 0], 64);
    uints.set([count, request.capacity, request.hiz?.mipLevelCount ?? 1,
      (request.reversedZ ? 1 : 0) | (request.hiz ? 2 : 0) | (request.normalCone ? 4 : 0)], 68);
    floats.set([request.depthBias, request.nearClipEpsilon, request.coneEpsilon, request.coneRadiusError], 72);
    this.session.device.queue.writeBuffer(buffer, 0, data);
  }

  private validateRevisions(input: MeshletCullingInput, hiz: HiZResult | undefined): void {
    if (this.inputIdentity && input.revision < this.inputIdentity.revision) throw new Error("Stale meshlet input revision.");
    if (this.inputIdentity && input.revision === this.inputIdentity.revision
      && (input.count !== this.inputIdentity.count || input.descriptors !== this.inputIdentity.descriptors || input.bounds !== this.inputIdentity.bounds)) {
      throw new Error("Meshlet input changed without a revision.");
    }
    if (hiz && this.hizIdentity && hiz.sourceRevision < this.hizIdentity.revision) throw new Error("Stale meshlet Hi-Z revision.");
    if (hiz && this.hizIdentity && hiz.sourceRevision === this.hizIdentity.revision && hiz.texture !== this.hizIdentity.texture) {
      throw new Error("Meshlet Hi-Z texture changed without a revision.");
    }
  }

  private commitIdentities(input: MeshletCullingInput, hiz: HiZResult | undefined): void {
    this.inputIdentity = identity(input);
    if (hiz) this.hizIdentity = { revision: hiz.sourceRevision, texture: hiz.texture };
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Meshlet culler is disposed.");
    if (this.session.state !== "ready") {
      this.releaseOutputs(); this.releaseFallback(); this.last = undefined;
      throw new Error("GPU session is not ready for meshlet culling.");
    }
  }

  private releaseOutputs(): void { if (this.resources) this.release(this.resources); this.resources = undefined; }
  private release(resources: MeshletCullResources): void {
    for (const resource of [resources.flags, resources.localPrefix, resources.blockOffsets, resources.visibleIndices,
      resources.visibleRecords, resources.visibleCount, resources.uniform]) this.session.release(resource);
  }
  private releaseFallback(): void {
    if (!this.fallbackAlive) return;
    this.fallbackAlive = false; this.session.release(this.fallbackTexture);
  }
}

function identity(input: MeshletCullingInput): RevisionIdentity {
  return { revision: input.revision, count: input.count, descriptors: input.descriptors, bounds: input.bounds };
}

function needsBinding(resources: MeshletCullResources, input: MeshletCullingInput, hiz: HiZResult | undefined): boolean {
  return resources.inputDescriptors !== input.descriptors || resources.inputBounds !== input.bounds
    || resources.hizTexture !== hiz?.texture || resources.hizMipLevelCount !== (hiz?.mipLevelCount ?? 1);
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function exactRequest(last: LastMeshletCull, input: MeshletCullingInput, request: ValidatedMeshletCull): boolean {
  const before = last.request;
  return last.input.revision === input.revision && last.input.count === input.count
    && last.input.descriptors === input.descriptors && last.input.bounds === input.bounds
    && before.hiz?.texture === request.hiz?.texture && before.hiz?.sourceRevision === request.hiz?.sourceRevision
    && before.hiz?.mipLevelCount === request.hiz?.mipLevelCount && before.reversedZ === request.reversedZ
    && before.normalCone === request.normalCone && before.depthBias === request.depthBias
    && before.nearClipEpsilon === request.nearClipEpsilon && before.coneEpsilon === request.coneEpsilon
    && sameNumbers(before.viewProjection, request.viewProjection) && sameNumbers(before.worldFromObject, request.worldFromObject)
    && sameNumbers(before.cameraPosition, request.cameraPosition) && sameNumbers(before.frustum, request.frustum)
    && sameNumbers(before.viewport, request.viewport);
}

export function meshletNormalConeVisible(sphere: readonly number[], cone: readonly number[], worldAxis: readonly number[],
  camera: readonly number[], epsilon = 1e-5): boolean {
  if (sphere.length !== 4 || cone.length !== 4 || worldAxis.length !== 3 || camera.length !== 3
    || ![...sphere, ...cone, ...worldAxis, ...camera, epsilon].every(Number.isFinite) || sphere[3]! < 0
    || cone[3]! < 0 || cone[3]! > 1 || epsilon < 0) return true;
  const axisLength = Math.hypot(...worldAxis), dx = camera[0]! - sphere[0]!, dy = camera[1]! - sphere[1]!, dz = camera[2]! - sphere[2]!;
  const distance = Math.hypot(dx, dy, dz);
  if (axisLength <= 1e-8 || distance <= sphere[3]! || distance <= 1e-8) return true;
  const spatialSin = Math.min(1, sphere[3]! / distance), spatialCos = Math.sqrt(Math.max(0, 1 - spatialSin ** 2));
  if (cone[3]! <= spatialSin) return true;
  const coneSin = Math.sqrt(Math.max(0, 1 - cone[3]! ** 2)), totalSin = coneSin * spatialCos + cone[3]! * spatialSin;
  if (totalSin >= 1) return true;
  const dot = (worldAxis[0]! * dx + worldAxis[1]! * dy + worldAxis[2]! * dz) / axisLength / distance;
  return dot > -totalSin - epsilon;
}

export { MESHLET_CULL_WGSL, MESHLET_CULL_WORKGROUP_SIZE, nextMeshletCapacity };
export { meshletHiZClipTestable, meshletHiZVisible } from "./meshletCullingReference.js";
export * from "./meshletCullingTypes.js";
