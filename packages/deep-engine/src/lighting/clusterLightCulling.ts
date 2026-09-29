/// <reference types="@webgpu/types" />
/**
 * I 级 C2 集群光源剔除(light-centric,MegaLights/UE MegaLights 同族,opt-in 默认关)。
 *
 * 与 B1 clusterCompute(cluster-centric,每 workgroup 独占一簇、扫描全部灯,O(簇数×灯数))
 * 语义相同的输出、不同的成本模型:每灯只做一次视锥球投影(boundsForSphere),再原子追加到
 * 重叠簇,O(灯数×平均触达簇数)。万级灯下 B1 簇心扫描成本爆炸,C2 光心剔除保持近线性。
 *
 * 输出与 B1 同 ABI(ClusterParamsAbi v2 80B + ClusterHeaderAbi{offset,count} + 固定步长
 * u32 索引表 + overflow 计数),group-3 片段着色(deepClusterHeaders/deepClusterLightIndices)
 * 零着色器改动可换装。预算/溢出语义同 B1:count 钳到 maxLightsPerCluster,超出计 overflow。
 * opt-in 纪律:本模块不进 lighting/index.ts 出口、不改任何既有管线;仅在显式构造时生效,
 * resolveClusterLightCullingMode 缺省恒 "off"(fail-closed)。
 */
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { FORWARD_PLUS_CLUSTER_PARAMETER_BYTES } from "./clusterAbiWgsl.js";
import { clusterBoundsForSphere, normalizeClusterGrid, MAX_FORWARD_PLUS_LIGHTS_PER_CLUSTER } from "./clusterGrid.js";
import { CLUSTER_LIGHT_CULLING_PIPELINE_KEY, CLUSTER_LIGHT_CULLING_WGSL, CLUSTER_LIGHT_CULLING_WORKGROUP_SIZE } from "./clusterLightCullingWgsl.js";
import { packClusteredLights } from "./clusterPacking.js";
import { prioritizeLocalLights } from "./importanceBudget.js";
import type { CpuClusterAssignment, ClusteredLights, ClusterGridConfig, ClusterLightBounds, NormalizedClusterGrid } from "./types.js";

export { CLUSTER_LIGHT_CULLING_PIPELINE_KEY, CLUSTER_LIGHT_CULLING_WGSL, CLUSTER_LIGHT_CULLING_WORKGROUP_SIZE };

const HEADER_BYTES = 8, INDEX_BYTES = 4, UNUSED_LIGHT_INDEX = 0xffff_ffff;

/** C2 光源剔除模式:opt-in 默认关(fail-closed),显式传 true 才启用光心剔除路径。 */
export type ClusterLightCullingMode = "off" | "light-centric";

export function resolveClusterLightCullingMode(optIn?: boolean): ClusterLightCullingMode {
  return optIn === true ? "light-centric" : "off";
}

/** C2 剔除参数字(word)布局:与 B1 packParameters 同 ABI,仅 area 恒零(面积光不参与聚簇)。 */
export function packClusterLightCullingParameters(grid: NormalizedClusterGrid, localLightCount: number): ArrayBuffer {
  const buffer = new ArrayBuffer(FORWARD_PLUS_CLUSTER_PARAMETER_BYTES), uints = new Uint32Array(buffer), floats = new Float32Array(buffer);
  uints.set([grid.viewportWidth, grid.viewportHeight, grid.tileSizeX, grid.tileSizeY], 0);
  uints.set([grid.tilesX, grid.tilesY, grid.zSlices, localLightCount], 4);
  uints.set([grid.maxLightsPerCluster, grid.clusterCount, 0, 0], 8);
  floats.set([grid.near, grid.far, grid.tanHalfFovY, grid.aspect], 12);
  uints.set([0, 0, 0, 0], 16);
  return buffer;
}

/**
 * C2 光心剔除的 CPU 镜像(确定性灯序追加,即 GPU 原子序的理想化):每灯一次球投影后
 * 顺序追加进重叠簇。测试与真机对拍都以"每簇索引集合"与 B1 assignLightsToClusters
 * (簇心参考)比对——原子序不定,顺序不可作合同,集合才是。
 */
export function assignLightsToClustersLightCentric(config: ClusterGridConfig, lights: ClusteredLights,
  boundsFor: (grid: NormalizedClusterGrid, position: readonly [number, number, number], range: number) => ClusterLightBounds | undefined = clusterBoundsForSphere): CpuClusterAssignment {
  const grid = normalizeClusterGrid(config), packed = packClusteredLights(lights);
  const headers = new Uint32Array(grid.clusterCount * 2);
  const lightIndices = new Uint32Array(grid.clusterCount * grid.maxLightsPerCluster);
  lightIndices.fill(UNUSED_LIGHT_INDEX);
  for (let cluster = 0; cluster < grid.clusterCount; cluster++) headers[cluster * 2] = cluster * grid.maxLightsPerCluster;
  const counts = new Uint32Array(grid.clusterCount), xyCount = grid.tilesX * grid.tilesY;
  const localCount = packed.pointCount + packed.spotCount;
  let overflowCount = 0;
  for (let light = 0; light < localCount; light++) {
    const offset = light * 4;
    const bounds = boundsFor(grid, [packed.localBounds[offset]!, packed.localBounds[offset + 1]!,
      packed.localBounds[offset + 2]!], packed.localBounds[offset + 3]!);
    if (!bounds) continue;
    for (let slice = bounds.minSlice; slice <= bounds.maxSlice; slice++) {
      for (let tileY = bounds.minTileY; tileY <= bounds.maxTileY; tileY++) {
        for (let tileX = bounds.minTileX; tileX <= bounds.maxTileX; tileX++) {
          const cluster = slice * xyCount + tileY * grid.tilesX + tileX, rank = counts[cluster]!;
          counts[cluster] = rank + 1;
          if (rank < grid.maxLightsPerCluster) lightIndices[cluster * grid.maxLightsPerCluster + rank] = light;
          else overflowCount++;
        }
      }
    }
  }
  for (let cluster = 0; cluster < grid.clusterCount; cluster++) headers[cluster * 2 + 1] = Math.min(counts[cluster]!, grid.maxLightsPerCluster);
  return { grid, headers, lightIndices, overflowCount, localLightCount: localCount };
}

type LightingSession = Pick<DeviceSession, "device" | "state" | "own" | "release">;

export interface ClusterLightCullingResources {
  readonly pipelineKey: typeof CLUSTER_LIGHT_CULLING_PIPELINE_KEY;
  readonly localBoundsBuffer: GPUBuffer;
  readonly clusterParameterBuffer: GPUBuffer;
  readonly clusterHeaderBuffer: GPUBuffer;
  readonly clusterLightIndexBuffer: GPUBuffer;
  readonly overflowBuffer: GPUBuffer;
  readonly grid: NormalizedClusterGrid;
  readonly clusterHeaderByteLength: number;
  readonly clusterLightIndexByteLength: number;
  readonly selectedLocalLightCount: number;
  readonly droppedLocalLightCount: number;
  readonly resetWorkgroups: number;
  readonly cullWorkgroups: number;
  readonly finalizeWorkgroups: number;
  /** 显式请求时提供 CPU 参考(光心镜像);生产路径保持 GPU-only 不回读。 */
  readonly cpuReference?: CpuClusterAssignment;
}

export interface ClusterLightCullingPrepareOptions {
  /** MegaLights 式稳定重要度预算(importanceBudget);缺省保留全部灯。 */
  readonly maxLocalLights?: number;
  readonly cpuReference?: boolean;
}

interface Allocation {
  readonly localBoundsBuffer: GPUBuffer; readonly parameterBuffer: GPUBuffer;
  readonly clusterHeaderBuffer: GPUBuffer; readonly clusterLightIndexBuffer: GPUBuffer; readonly overflowBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
}
interface CullingCapacities { readonly boundsVec4s: number; readonly clusters: number; readonly maxPerCluster: number }

/** Owns the light-centric culling pipeline with rollback-safe, resizable cluster storage. */
export class ClusterLightCuller {
  private readonly layout: GPUBindGroupLayout;
  private readonly pipelines: Readonly<Record<"resetLists" | "cullLights" | "finalizeCounts", GPUComputePipeline>>;
  private resources: (Allocation & { readonly capacities: CullingCapacities }) | undefined;
  private prepared: ClusterLightCullingResources | undefined;
  private preparedInputs: { readonly bounds: Float32Array; readonly parameters: ArrayBuffer } | undefined;
  private assignedInputs: { readonly resources: Allocation; readonly bounds: Float32Array; readonly parameters: ArrayBuffer } | undefined;
  private uploaded: { readonly resources: Allocation; readonly bounds: Float32Array; readonly parameters: ArrayBuffer } | undefined;
  private disposed = false;

  constructor(private readonly session: LightingSession) {
    this.assertReady();
    const device = session.device, module = device.createShaderModule({ label: "Deep cluster light culling WGSL", code: CLUSTER_LIGHT_CULLING_WGSL });
    this.layout = device.createBindGroupLayout({ label: "Deep cluster light culling layout", entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ] });
    const pipelineLayout = device.createPipelineLayout({ label: "Deep cluster light culling pipeline layout", bindGroupLayouts: [this.layout] });
    this.pipelines = Object.freeze({
      resetLists: device.createComputePipeline({ label: "Deep cluster light culling reset", layout: pipelineLayout, compute: { module, entryPoint: "resetLists" } }),
      cullLights: device.createComputePipeline({ label: "Deep cluster light culling assign", layout: pipelineLayout, compute: { module, entryPoint: "cullLights" } }),
      finalizeCounts: device.createComputePipeline({ label: "Deep cluster light culling finalize", layout: pipelineLayout, compute: { module, entryPoint: "finalizeCounts" } }),
    });
  }

  prepare(config: ClusterGridConfig, lights: ClusteredLights, options: ClusterLightCullingPrepareOptions = {}): ClusterLightCullingResources {
    this.assertReady(); this.prepared = undefined;
    const boundedLights = options.maxLocalLights === undefined ? lights : prioritizeLocalLights(lights, options.maxLocalLights);
    const grid = normalizeClusterGrid(config);
    // 只取剔除所需的视锥球边界(与 B1 同一打包验证,超合同上限仍 fail-closed 抛错)。
    const packed = packClusteredLights(boundedLights);
    const localLightCount = packed.pointCount + packed.spotCount;
    const cpuReference = options.cpuReference ? assignLightsToClustersLightCentric(config, boundedLights) : undefined;
    const boundsVec4s = this.capacityPow2(localLightCount * 4, this.resources?.capacities.boundsVec4s);
    const clusters = this.capacityPow2(grid.clusterCount, this.resources?.capacities.clusters);
    const desired: CullingCapacities = { boundsVec4s, clusters, maxPerCluster: grid.maxLightsPerCluster };
    const previousResources = this.resources;
    const replace = !previousResources || previousResources.capacities.boundsVec4s !== desired.boundsVec4s
      || previousResources.capacities.clusters !== desired.clusters || previousResources.capacities.maxPerCluster !== desired.maxPerCluster;
    const candidate: Allocation = replace ? this.allocate(desired) : previousResources;
    try {
      this.write(candidate, packed.localBounds.subarray(0, localLightCount * 4), grid, localLightCount);
      this.assertReady();
    } catch (error) {
      if (replace) this.release(candidate);
      else this.uploaded = undefined;
      throw error;
    }
    if (replace) { this.resources = { ...candidate, capacities: desired }; if (previousResources) this.release(previousResources); }
    const maxGroups = this.session.device.limits.maxComputeWorkgroupsPerDimension;
    const result: ClusterLightCullingResources = Object.freeze({
      pipelineKey: CLUSTER_LIGHT_CULLING_PIPELINE_KEY,
      localBoundsBuffer: candidate.localBoundsBuffer, clusterParameterBuffer: candidate.parameterBuffer,
      clusterHeaderBuffer: candidate.clusterHeaderBuffer, clusterLightIndexBuffer: candidate.clusterLightIndexBuffer,
      overflowBuffer: candidate.overflowBuffer, grid,
      clusterHeaderByteLength: grid.clusterCount * HEADER_BYTES,
      clusterLightIndexByteLength: grid.clusterCount * grid.maxLightsPerCluster * INDEX_BYTES,
      selectedLocalLightCount: localLightCount,
      droppedLocalLightCount: (lights.points?.length ?? 0) + (lights.spots?.length ?? 0) - localLightCount,
      resetWorkgroups: Math.min(Math.ceil(grid.clusterCount / CLUSTER_LIGHT_CULLING_WORKGROUP_SIZE), maxGroups),
      cullWorkgroups: Math.min(Math.ceil(localLightCount / CLUSTER_LIGHT_CULLING_WORKGROUP_SIZE), maxGroups),
      finalizeWorkgroups: Math.min(Math.ceil(grid.clusterCount / CLUSTER_LIGHT_CULLING_WORKGROUP_SIZE), maxGroups),
      ...(cpuReference ? { cpuReference } : {}),
    });
    this.prepared = result;
    this.preparedInputs = { bounds: packed.localBounds.subarray(0, localLightCount * 4), parameters: packClusterLightCullingParameters(grid, localLightCount) };
    return result;
  }

  /**
   * 三个有序 compute pass:reset(清零/哨兵) → 光心原子追加 → 预算钳制。
   * 刻意不用同 pass 内多 dispatch:dispatch 间可见性存在实现分歧(实测本机真机全簇计数
   * 归零),pass 边界的内存序是 WebGPU 规范强保证。与 B1 同款脏检查:灯场与参数逐字
   * 未变时零重发(静态帧零额外成本);invalidateAssignment 后强制重建。
   */
  encode(encoder: GPUCommandEncoder): ClusterLightCullingResources {
    this.assertReady();
    const prepared = this.prepared, resources = this.resources, inputs = this.preparedInputs;
    if (!prepared || !resources || !inputs) throw new Error("Cluster light culling inputs must be prepared before encode.");
    if (!sameInputs(inputs, this.assignedInputs, resources)) {
      this.session.device.queue.writeBuffer(resources.overflowBuffer, 0, new Uint32Array([0]));
      const reset = encoder.beginComputePass({ label: "Deep cluster light culling reset" });
      reset.setBindGroup(0, resources.bindGroup); reset.setPipeline(this.pipelines.resetLists);
      reset.dispatchWorkgroups(prepared.resetWorkgroups); reset.end();
      const cull = encoder.beginComputePass({ label: "Deep cluster light culling assign" });
      cull.setBindGroup(0, resources.bindGroup); cull.setPipeline(this.pipelines.cullLights);
      cull.dispatchWorkgroups(prepared.cullWorkgroups); cull.end();
      const finalize = encoder.beginComputePass({ label: "Deep cluster light culling finalize" });
      finalize.setBindGroup(0, resources.bindGroup); finalize.setPipeline(this.pipelines.finalizeCounts);
      finalize.dispatchWorkgroups(prepared.finalizeWorkgroups); finalize.end();
      this.assignedInputs = { resources, bounds: inputs.bounds, parameters: inputs.parameters };
    }
    this.prepared = undefined; this.preparedInputs = undefined;
    return prepared;
  }

  /** Forces the next encode to rebuild cluster lists after a submission failure. */
  invalidateAssignment(): void { this.assignedInputs = undefined; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.prepared = undefined; this.preparedInputs = undefined;
    this.assignedInputs = undefined; this.uploaded = undefined;
    if (this.resources) { this.release(this.resources); this.resources = undefined; }
  }

  /** Power-of-two growth with B1-style hysteresis: shrink only when use drops to a quarter. */
  private capacityPow2(required: number, current?: number): number {
    let target = 1;
    while (target < required) target *= 2;
    if (!current || required > current || required * 4 <= current) return target;
    return current;
  }

  private allocate(capacities: CullingCapacities): Allocation {
    const owned: GPUBuffer[] = [], device = this.session.device;
    const allocate = (size: number, usage: GPUBufferUsageFlags, label: string): GPUBuffer => {
      const maximum = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
      if (!Number.isSafeInteger(size) || size < 4 || size > maximum) {
        throw new Error(`${label} requires ${size} bytes, exceeding device storage limit ${maximum}.`);
      }
      const buffer = this.session.own(device.createBuffer({ size, usage, label })); owned.push(buffer); return buffer;
    };
    try {
      const localBoundsBuffer = allocate(capacities.boundsVec4s * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep cluster light culling local bounds");
      const parameterBuffer = allocate(FORWARD_PLUS_CLUSTER_PARAMETER_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, "Deep cluster light culling parameters");
      const clusterHeaderBuffer = allocate(capacities.clusters * HEADER_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, "Deep cluster light culling headers");
      const clusterLightIndexBuffer = allocate(capacities.clusters * capacities.maxPerCluster * INDEX_BYTES, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, "Deep cluster light culling indices");
      const overflowBuffer = allocate(4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, "Deep cluster light culling overflow");
      const bindGroup = device.createBindGroup({ label: "Deep cluster light culling bindings", layout: this.layout,
        entries: [localBoundsBuffer, parameterBuffer, clusterHeaderBuffer, clusterLightIndexBuffer, overflowBuffer]
          .map((buffer, binding) => ({ binding, resource: { buffer } })) });
      return { localBoundsBuffer, parameterBuffer, clusterHeaderBuffer, clusterLightIndexBuffer, overflowBuffer, bindGroup };
    } catch (error) { for (const buffer of owned) this.session.release(buffer); throw error; }
  }

  private write(resources: Allocation, localBounds: Float32Array, grid: NormalizedClusterGrid, localLightCount: number): number {
    const queue = this.session.device.queue;
    const previous = this.uploaded?.resources === resources ? this.uploaded : undefined;
    const parameters = packClusterLightCullingParameters(grid, localLightCount);
    let count = 0;
    if (localBounds.byteLength && !sameFloats(localBounds, previous?.bounds)) {
      queue.writeBuffer(resources.localBoundsBuffer, 0, localBounds.buffer as ArrayBuffer, localBounds.byteOffset, localBounds.byteLength);
      count++;
    }
    if (!sameWords(parameters, previous?.parameters)) {
      queue.writeBuffer(resources.parameterBuffer, 0, parameters); count++;
    }
    this.uploaded = { resources, bounds: localBounds, parameters };
    return count;
  }

  private release(resources: Allocation): void {
    for (const buffer of [resources.localBoundsBuffer, resources.parameterBuffer, resources.clusterHeaderBuffer,
      resources.clusterLightIndexBuffer, resources.overflowBuffer]) this.session.release(buffer);
  }

  private assertReady(): void {
    if (this.disposed) throw new Error("Cluster light culler is disposed.");
    if (this.session.state !== "ready") throw new Error(`Cluster light culler cannot use a ${this.session.state} GPU session.`);
  }
}

/** 预算上限暴露(与 B1 同值):maxLightsPerCluster 的合同天花板。 */
export const CLUSTER_LIGHT_CULLING_MAX_LIGHTS_PER_CLUSTER = MAX_FORWARD_PLUS_LIGHTS_PER_CLUSTER;

function sameWords(current: ArrayBuffer, previous: ArrayBuffer | undefined): boolean {
  if (!previous || current.byteLength !== previous.byteLength) return false;
  const left = new Uint32Array(current), right = new Uint32Array(previous);
  return left.every((value, index) => value === right[index]);
}

function sameFloats(current: Float32Array, previous: Float32Array | undefined): boolean {
  return previous !== undefined && current.length === previous.length
    && current.every((value, index) => value === previous[index]);
}

function sameInputs(current: { readonly bounds: Float32Array; readonly parameters: ArrayBuffer },
  previous: { readonly resources: Allocation; readonly bounds: Float32Array; readonly parameters: ArrayBuffer } | undefined,
  resources: Allocation): boolean {
  return previous !== undefined && previous.resources === resources
    && sameFloats(current.bounds, previous.bounds) && sameWords(current.parameters, previous.parameters);
}
