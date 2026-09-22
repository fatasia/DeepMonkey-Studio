/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { FORWARD_PLUS_CLUSTER_PARAMETER_BYTES } from "./clusterAbiWgsl.js";
import { assignLightsToClusters, normalizeClusterGrid } from "./clusterGrid.js";
import { packIesShading } from "./iesShading.js";
import { prioritizeLocalLights } from "./importanceBudget.js";
import { DIRECTIONAL_LIGHT_STRIDE, LOCAL_LIGHT_BOUNDS_STRIDE, packClusteredLights, POINT_LIGHT_STRIDE, SPOT_LIGHT_STRIDE } from "./clusterPacking.js";
import { FORWARD_PLUS_CLUSTER_ASSIGN_WGSL } from "./clusterComputeWgsl.js";
import type { ClusterGridConfig, ClusteredLights, CpuClusterAssignment, NormalizedClusterGrid, PackedClusteredLights } from "./types.js";

export const FORWARD_PLUS_CLUSTER_PIPELINE_KEY = "deep.forward-plus.cluster-assign.v1";
const HEADER_BYTES = 8, INDEX_BYTES = 4, IES_VEC4_BYTES = 16;

type LightingSession = Pick<DeviceSession, "device" | "state" | "own" | "release">;
interface Capacities { directional: number; point: number; spot: number; local: number; clusters: number; maxPerCluster: number; iesVec4s: number }
interface Allocation extends Capacities {
  directionalBuffer: GPUBuffer; pointBuffer: GPUBuffer; spotBuffer: GPUBuffer; localBoundsBuffer: GPUBuffer;
  parameterBuffer: GPUBuffer; clusterHeaderBuffer: GPUBuffer; clusterLightIndexBuffer: GPUBuffer; overflowBuffer: GPUBuffer;
  iesShadingBuffer: GPUBuffer; bindGroup: GPUBindGroup;
}
interface UploadedInputs {
  readonly resources: Allocation;
  readonly directional: Float32Array;
  readonly points: Float32Array;
  readonly spots: Float32Array;
  readonly localBounds: Float32Array;
  readonly iesShading: Float32Array;
  readonly parameters: ArrayBuffer;
}
interface ClusterAssignmentInputs {
  readonly resources: Allocation;
  readonly points: Float32Array;
  readonly spots: Float32Array;
  readonly localBounds: Float32Array;
  readonly parameters: ArrayBuffer;
}

export interface ForwardPlusClusterResources {
  readonly pipelineKey: typeof FORWARD_PLUS_CLUSTER_PIPELINE_KEY;
  readonly directionalLightBuffer: GPUBuffer;
  readonly pointLightBuffer: GPUBuffer;
  readonly spotLightBuffer: GPUBuffer;
  readonly localBoundsBuffer: GPUBuffer;
  readonly clusterParameterBuffer: GPUBuffer;
  readonly clusterHeaderBuffer: GPUBuffer;
  readonly clusterLightIndexBuffer: GPUBuffer;
  readonly overflowBuffer: GPUBuffer;
  /** E02 IES 光域网数据（iesShading.ts 打包）；非 IES 场景仍存在（最小 -1 参数行）。 */
  readonly iesShadingBuffer: GPUBuffer;
  readonly iesShadingVec4Count: number;
  readonly grid: NormalizedClusterGrid;
  /** Present only when explicitly requested for validation/readback; production preparation stays GPU-only. */
  readonly cpuReference?: CpuClusterAssignment;
  readonly directionalCount: number;
  readonly pointCount: number;
  readonly spotCount: number;
  /** Number of persistent light/grid input buffers updated by this prepare call; overflow reset is excluded. */
  readonly uploadedInputBufferCount: number;
  readonly clusterHeaderByteLength: number;
  readonly clusterLightIndexByteLength: number;
  /** Number of local lights retained after the optional MegaLights-style budget. */
  readonly selectedLocalLightCount: number;
  readonly droppedLocalLightCount: number;
}

export interface ForwardPlusClusterPrepareOptions {
  readonly cpuReference?: boolean;
  /** Stable importance budget for point + spot lights. Omit to retain all lights. */
  readonly maxLocalLights?: number;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function capacity(required: number, current?: number): number {
  const target = nextPowerOfTwo(Math.max(1, required));
  if (!current || required > current || required * 4 <= current) return target;
  return current;
}

function desiredCapacities(packed: PackedClusteredLights, grid: NormalizedClusterGrid, iesVec4Count: number, current?: Allocation): Capacities {
  return {
    directional: capacity(packed.directionalCount, current?.directional), point: capacity(packed.pointCount, current?.point),
    spot: capacity(packed.spotCount, current?.spot), local: capacity(packed.pointCount + packed.spotCount, current?.local),
    clusters: capacity(grid.clusterCount, current?.clusters), maxPerCluster: grid.maxLightsPerCluster,
    iesVec4s: capacity(iesVec4Count, current?.iesVec4s),
  };
}

function sameCapacities(allocation: Allocation, desired: Capacities): boolean {
  return allocation.directional === desired.directional && allocation.point === desired.point && allocation.spot === desired.spot
    && allocation.local === desired.local && allocation.clusters === desired.clusters && allocation.maxPerCluster === desired.maxPerCluster
    && allocation.iesVec4s === desired.iesVec4s;
}

function packParameters(grid: NormalizedClusterGrid, packed: PackedClusteredLights): ArrayBuffer {
  const buffer = new ArrayBuffer(FORWARD_PLUS_CLUSTER_PARAMETER_BYTES), uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  uints.set([grid.viewportWidth, grid.viewportHeight, grid.tileSizeX, grid.tileSizeY], 0);
  uints.set([grid.tilesX, grid.tilesY, grid.zSlices, packed.pointCount + packed.spotCount], 4);
  uints.set([grid.maxLightsPerCluster, grid.clusterCount, packed.directionalCount, packed.pointCount], 8);
  floats.set([grid.near, grid.far, grid.tanHalfFovY, grid.aspect], 12);
  return buffer;
}

/** Owns one stable Forward+ pipeline and resizable, rollback-safe light/cluster storage. */
export class ForwardPlusClusterAssigner {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipeline: GPUComputePipeline;
  private resources: Allocation | undefined;
  private prepared: ForwardPlusClusterResources | undefined;
  private preparedAssignment: ClusterAssignmentInputs | undefined;
  private assigned: ClusterAssignmentInputs | undefined;
  private uploaded: UploadedInputs | undefined;
  private disposed = false;

  constructor(private readonly session: LightingSession) {
    this.assertReady();
    const device = session.device, module = device.createShaderModule({ label: "Deep Forward+ cluster assignment WGSL", code: FORWARD_PLUS_CLUSTER_ASSIGN_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep Forward+ cluster assignment layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ label: "Deep Forward+ cluster pipeline layout", bindGroupLayouts: [this.layout] });
    this.pipeline = device.createComputePipeline({ label: "Deep Forward+ cluster assignment pipeline", layout: pipelineLayout,
      compute: { module, entryPoint: "assignClusters" } });
  }

  prepare(config: ClusterGridConfig, lights: ClusteredLights, options: ForwardPlusClusterPrepareOptions = {}): ForwardPlusClusterResources {
    this.assertReady(); this.prepared = undefined; this.preparedAssignment = undefined;
    const boundedLights = options.maxLocalLights === undefined ? lights : prioritizeLocalLights(lights, options.maxLocalLights);
    const grid = normalizeClusterGrid(config), packed = packClusteredLights(boundedLights);
    // E02：与 spot storage buffer 同源灯序打包（索引对齐是着色器正确性的前提）。
    const iesShading = packIesShading(boundedLights.spots ?? [], boundedLights.lightProfiles);
    const cpuReference = options.cpuReference ? assignLightsToClusters(config, boundedLights) : undefined;
    const desired = desiredCapacities(packed, grid, iesShading.vec4Count, this.resources);
    const candidate = this.resources && sameCapacities(this.resources, desired) ? this.resources : this.allocate(desired);
    const replace = candidate !== this.resources;
    let uploadedInputBufferCount = 0;
    try {
      uploadedInputBufferCount = this.write(candidate, packed, iesShading.data, grid);
      this.assertReady();
    } catch (error) {
      if (replace) this.release(candidate);
      else this.uploaded = undefined;
      throw error;
    }
    if (replace) { const previous = this.resources; this.resources = candidate; if (previous) this.release(previous); }
    const result: ForwardPlusClusterResources = Object.freeze({
      pipelineKey: FORWARD_PLUS_CLUSTER_PIPELINE_KEY,
      directionalLightBuffer: candidate.directionalBuffer, pointLightBuffer: candidate.pointBuffer, spotLightBuffer: candidate.spotBuffer,
      localBoundsBuffer: candidate.localBoundsBuffer, clusterHeaderBuffer: candidate.clusterHeaderBuffer,
      clusterParameterBuffer: candidate.parameterBuffer,
      clusterLightIndexBuffer: candidate.clusterLightIndexBuffer, overflowBuffer: candidate.overflowBuffer,
      iesShadingBuffer: candidate.iesShadingBuffer, iesShadingVec4Count: iesShading.vec4Count,
      grid, ...(cpuReference ? { cpuReference } : {}), directionalCount: packed.directionalCount, pointCount: packed.pointCount, spotCount: packed.spotCount,
      uploadedInputBufferCount,
      clusterHeaderByteLength: grid.clusterCount * HEADER_BYTES, clusterLightIndexByteLength: grid.clusterCount * grid.maxLightsPerCluster * INDEX_BYTES,
      selectedLocalLightCount: packed.pointCount + packed.spotCount,
      droppedLocalLightCount: (lights.points?.length ?? 0) + (lights.spots?.length ?? 0) - packed.pointCount - packed.spotCount,
    });
    this.prepared = result;
    this.preparedAssignment = { resources: candidate, points: packed.points, spots: packed.spots,
      localBounds: packed.localBounds, parameters: packParameters(grid, packed) };
    return result;
  }

  encode(encoder: GPUCommandEncoder): ForwardPlusClusterResources {
    this.assertReady();
    const prepared = this.prepared, resources = this.resources, assignment = this.preparedAssignment;
    if (!prepared || !resources || !assignment) throw new Error("Forward+ cluster inputs must be prepared before encode.");
    if (!sameAssignment(assignment, this.assigned)) {
      const maxGroups = this.session.device.limits.maxComputeWorkgroupsPerDimension;
      const groups = Math.min(prepared.grid.clusterCount, maxGroups);
      this.session.device.queue.writeBuffer(resources.overflowBuffer, 0, new Uint32Array([0]));
      const pass = encoder.beginComputePass({ label: "Deep Forward+ cluster assignment" });
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, resources.bindGroup); pass.dispatchWorkgroups(groups); pass.end();
      this.assigned = assignment;
    }
    this.prepared = undefined; this.preparedAssignment = undefined; return prepared;
  }

  /** Forces the next frame to rebuild cluster lists after an encoder or submission failure. */
  invalidateAssignment(): void {
    this.prepared = undefined; this.preparedAssignment = undefined; this.assigned = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.prepared = undefined; this.preparedAssignment = undefined; this.assigned = undefined;
    this.uploaded = undefined;
    if (this.resources) { this.release(this.resources); this.resources = undefined; }
  }

  private allocate(capacities: Capacities): Allocation {
    const owned: GPUBuffer[] = [], device = this.session.device;
    const allocate = (size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer => {
      this.validateBufferSize(size, label);
      const buffer = this.session.own(device.createBuffer({ size, usage, label })); owned.push(buffer); return buffer;
    };
    try {
      const directionalBuffer = allocate(capacities.directional * DIRECTIONAL_LIGHT_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep Forward+ directional lights");
      const pointBuffer = allocate(capacities.point * POINT_LIGHT_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep Forward+ point lights");
      const spotBuffer = allocate(capacities.spot * SPOT_LIGHT_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep Forward+ spot lights");
      const localBoundsBuffer = allocate(capacities.local * LOCAL_LIGHT_BOUNDS_STRIDE, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep Forward+ local light bounds");
      const parameterBuffer = allocate(FORWARD_PLUS_CLUSTER_PARAMETER_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep Forward+ cluster parameters");
      const clusterHeaderBuffer = allocate(capacities.clusters * HEADER_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, "Deep Forward+ cluster headers");
      const clusterLightIndexBuffer = allocate(capacities.clusters * capacities.maxPerCluster * INDEX_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, "Deep Forward+ cluster light indices");
      const overflowBuffer = allocate(4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "Deep Forward+ overflow counter");
      const iesShadingBuffer = allocate(capacities.iesVec4s * IES_VEC4_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep Forward+ IES shading tables");
      const bindGroup = device.createBindGroup({ label: "Deep Forward+ cluster bindings", layout: this.layout,
        entries: [localBoundsBuffer, parameterBuffer, clusterHeaderBuffer, clusterLightIndexBuffer, overflowBuffer]
          .map((buffer, binding) => ({ binding, resource: { buffer } })) });
      return { ...capacities, directionalBuffer, pointBuffer, spotBuffer, localBoundsBuffer, parameterBuffer,
        clusterHeaderBuffer, clusterLightIndexBuffer, overflowBuffer, iesShadingBuffer, bindGroup };
    } catch (error) { for (const buffer of owned) this.session.release(buffer); throw error; }
  }

  private write(resources: Allocation, packed: PackedClusteredLights, iesShading: Float32Array, grid: NormalizedClusterGrid): number {
    const queue = this.session.device.queue, previous = this.uploaded?.resources === resources ? this.uploaded : undefined;
    const parameters = packParameters(grid, packed);
    let count = 0;
    const upload = (buffer: GPUBuffer, values: Float32Array, prior: Float32Array | undefined): void => {
      if (!values.byteLength || sameFloats(values, prior)) return;
      queue.writeBuffer(buffer, 0, values.buffer as ArrayBuffer); count++;
    };
    upload(resources.directionalBuffer, packed.directional, previous?.directional);
    upload(resources.pointBuffer, packed.points, previous?.points);
    upload(resources.spotBuffer, packed.spots, previous?.spots);
    upload(resources.localBoundsBuffer, packed.localBounds, previous?.localBounds);
    upload(resources.iesShadingBuffer, iesShading, previous?.iesShading);
    if (!sameWords(parameters, previous?.parameters)) {
      queue.writeBuffer(resources.parameterBuffer, 0, parameters); count++;
    }
    this.uploaded = { resources, directional: packed.directional, points: packed.points,
      spots: packed.spots, localBounds: packed.localBounds, iesShading, parameters };
    return count;
  }

  private validateBufferSize(size: number, label: string): void {
    const limits = this.session.device.limits;
    const maximum = Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize);
    if (!Number.isSafeInteger(size) || size < 4 || size > maximum) throw new Error(`${label} requires ${size} bytes, exceeding device storage limit ${maximum}.`);
  }

  private release(resources: Allocation): void {
    for (const buffer of [resources.directionalBuffer, resources.pointBuffer, resources.spotBuffer, resources.localBoundsBuffer,
      resources.parameterBuffer, resources.clusterHeaderBuffer, resources.clusterLightIndexBuffer, resources.overflowBuffer,
      resources.iesShadingBuffer]) this.session.release(buffer);
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Forward+ cluster assigner is disposed.");
    if (this.session.state !== "ready") throw new Error(`Forward+ cluster assigner cannot use a ${this.session.state} GPU session.`);
  }
}

function sameFloats(current: Float32Array, previous: Float32Array | undefined): boolean {
  return previous !== undefined && current.length === previous.length
    && current.every((value, index) => value === previous[index]);
}

function sameWords(current: ArrayBuffer, previous: ArrayBuffer | undefined): boolean {
  if (!previous || current.byteLength !== previous.byteLength) return false;
  const left = new Uint32Array(current), right = new Uint32Array(previous);
  return left.every((value, index) => value === right[index]);
}

function sameAssignment(current: ClusterAssignmentInputs, previous: ClusterAssignmentInputs | undefined): boolean {
  return previous !== undefined && current.resources === previous.resources
    && sameFloats(current.points, previous.points) && sameFloats(current.spots, previous.spots)
    && sameFloats(current.localBounds, previous.localBounds) && sameWords(current.parameters, previous.parameters);
}
