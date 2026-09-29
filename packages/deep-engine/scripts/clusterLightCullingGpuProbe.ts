/// <reference types="@webgpu/types" />
// I 级 C2 集群光源剔除真机正确性 probe(headless Chrome WebGPU):
// 光心剔除 GPU 输出 ↔ CPU 光心镜像(集合等价) ↔ B1 簇心参考(集合等价),四档灯量
// + 溢出腿 + 空场腿;B1 GPU 簇心分配在 N=16 档做同缓冲 ABI 逐字对拍。
// runner:scripts/clusterLightCullingGpuTest.mjs;证据:test-output/deep-core/C2/。
import { normalizeClusterGrid } from "../src/lighting/clusterGrid.js";
import { packClusteredLights } from "../src/lighting/clusterPacking.js";
import { assignLightsToClustersLightCentric, ClusterLightCuller, CLUSTER_LIGHT_CULLING_WGSL, type ClusterLightCullingResources } from "../src/lighting/clusterLightCulling.js";
import { ForwardPlusClusterAssigner } from "../src/lighting/clusterCompute.js";
import { DeviceSession } from "../src/webgpu/deviceSession.js";
import type { ClusterGridConfig, ClusteredLights } from "../src/lighting/types.js";
import { BENCH_GRID, OVERFLOW_GRID, seededLights, clusterBoundsForSphereF32 } from "./clusterLightCullingProbeScene.js";
import { runClusterLightCullingBenchmark } from "./clusterLightCullingBenchmarkProbe.js";
import type { ClusterLightCullingBenchmarkResult } from "./clusterLightCullingBenchmarkProbe.js";
import { runClusterLightCullingFurnace } from "./clusterLightCullingFurnaceProbe.js";
import type { ClusterLightCullingFurnaceResult } from "./clusterLightCullingFurnaceProbe.js";

export interface CountMismatchSample {
  readonly cluster: number;
  readonly gpuCount: number;
  readonly cpuCount: number;
  readonly gpuOnly: readonly number[];
  readonly mirrorOnly: readonly number[];
}
export interface CorrectnessLeg {
  readonly lightCount: number;
  readonly gridClusters: number;
  readonly headerCountsMatchCpu: boolean;
  readonly indexSetsMatchCpu: boolean;
  readonly overflowMatchCpu: boolean;
  readonly gpuOverflow: number;
  readonly countMismatchSamples?: readonly CountMismatchSample[];
  readonly gpuNonZeroClusters?: number;
  readonly cpuNonZeroClusters?: number;
  /** 溢出簇集合分歧规模(诊断):gpu\cpu 与 cpu(预算内)\gpu 的成员数合计。 */
  readonly overflowSetDiff?: { readonly gpuOutsideCpu: number; readonly cpuMissingFromGpu: number; readonly overflowClusters: number };
}
export interface ClusterLightCullingCorrectnessResult {
  readonly action: "cluster-light-culling-correctness";
  readonly legs: readonly CorrectnessLeg[];
  readonly overflowLeg: CorrectnessLeg;
  readonly emptyLeg: CorrectnessLeg;
  readonly b1GpuExactAt16: boolean;
  readonly success: boolean;
}

/**
 * 集合合同(以不截断完整覆盖集为基准,light-centric f32 镜像逐灯判定):
 * 非溢出簇(完整集 ≤ 预算)GPU 集合必须全等;溢出簇的保留下标是原子调度序依赖的
 * (与 MegaLights 同族语义),合同退化为「GPU 恰好保留 maxPerCluster 个且全部 ⊆ 完整集」
 * ——不丢不越界,保留哪些由调度序决定,不作合同。
 */
function setsMatchFull(gpu: { headers: Uint32Array; indices: Uint32Array },
  full: ReadonlyArray<readonly number[]>, maxPerCluster: number): { match: boolean; gpuOutsideFull: number } {
  let gpuOutsideFull = 0;
  for (let cluster = 0; cluster < gpu.headers.length / 2; cluster++) {
    const gpuCount = gpu.headers[cluster * 2 + 1]!;
    const gpuSet = new Set(gpu.indices.subarray(cluster * maxPerCluster, cluster * maxPerCluster + gpuCount));
    const complete = full[cluster] ?? [];
    if (complete.length <= maxPerCluster) {
      if (gpuSet.size !== complete.length) return { match: false, gpuOutsideFull };
      for (const value of gpuSet) if (!complete.includes(value)) return { match: false, gpuOutsideFull };
    } else {
      if (gpuCount !== maxPerCluster) return { match: false, gpuOutsideFull };
      for (const value of gpuSet) if (!complete.includes(value)) gpuOutsideFull++;
    }
  }
  return { match: true, gpuOutsideFull };
}

function headerCountsMatch(gpu: Uint32Array, cpu: Uint32Array): boolean {
  return gpu.every((value, index) => value === cpu[index]);
}

async function readBack(device: GPUDevice, culler: ClusterLightCuller, resources: ClusterLightCullingResources,
  owned: GPUBuffer[]): Promise<{ headers: Uint32Array; indices: Uint32Array; overflow: number }> {
  const header = device.createBuffer({ label: "C2 probe header readback", size: resources.clusterHeaderByteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const index = device.createBuffer({ label: "C2 probe index readback", size: resources.clusterLightIndexByteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const overflow = device.createBuffer({ label: "C2 probe overflow readback", size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  owned.push(header, index, overflow);
  const encoder = device.createCommandEncoder({ label: "C2 probe readback" });
  culler.encode(encoder);
  encoder.copyBufferToBuffer(resources.clusterHeaderBuffer, 0, header, 0, resources.clusterHeaderByteLength);
  encoder.copyBufferToBuffer(resources.clusterLightIndexBuffer, 0, index, 0, resources.clusterLightIndexByteLength);
  encoder.copyBufferToBuffer(resources.overflowBuffer, 0, overflow, 0, 4);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  await Promise.all([header.mapAsync(GPUMapMode.READ), index.mapAsync(GPUMapMode.READ), overflow.mapAsync(GPUMapMode.READ)]);
  const headers = new Uint32Array(header.getMappedRange().slice(0));
  const indices = new Uint32Array(index.getMappedRange().slice(0));
  const overflowValue = new Uint32Array(overflow.getMappedRange().slice(0))[0] ?? 0;
  header.unmap(); index.unmap(); overflow.unmap();
  return { headers, indices, overflow: overflowValue };
}

/** 不截断完整覆盖集(light-centric f32 镜像):每簇所有按 WGSL 同精度边界覆盖它的灯。 */
function fullCoverageSets(grid: ClusterGridConfig, lights: ClusteredLights): ReadonlyArray<readonly number[]> {
  const normalized = normalizeClusterGrid(grid);
  const packed = packClusteredLights(lights);
  const buckets: number[][] = Array.from({ length: normalized.clusterCount }, () => []);
  const xyCount = normalized.tilesX * normalized.tilesY;
  const total = packed.pointCount + packed.spotCount;
  for (let light = 0; light < total; light++) {
    const bounds = clusterBoundsForSphereF32(normalized,
      [packed.localBounds[light * 4]!, packed.localBounds[light * 4 + 1]!, packed.localBounds[light * 4 + 2]!],
      packed.localBounds[light * 4 + 3]!);
    if (!bounds) continue;
    for (let slice = bounds.minSlice; slice <= bounds.maxSlice; slice++) {
      for (let tileY = bounds.minTileY; tileY <= bounds.maxTileY; tileY++) {
        for (let tileX = bounds.minTileX; tileX <= bounds.maxTileX; tileX++) {
          buckets[slice * xyCount + tileY * normalized.tilesX + tileX]!.push(light);
        }
      }
    }
  }
  return buckets;
}

async function correctnessLeg(device: GPUDevice, session: DeviceSession, grid: ClusterGridConfig,
  lights: ClusteredLights): Promise<CorrectnessLeg> {
  const owned: GPUBuffer[] = [];
  const culler = new ClusterLightCuller(session);
  try {
    const cpuMirror = assignLightsToClustersLightCentric(grid, lights, clusterBoundsForSphereF32);
    const full = fullCoverageSets(grid, lights);
    const resources = culler.prepare(grid, lights);
    const gpu = await readBack(device, culler, resources, owned);
    const maxPerCluster = resources.grid.maxLightsPerCluster;
    const verdict = setsMatchFull(gpu, full, maxPerCluster);
    const samples: CountMismatchSample[] = [];
    let gpuNonZero = 0, cpuNonZero = 0;
    for (let cluster = 0; cluster < resources.grid.clusterCount; cluster++) {
      const gpuCount = gpu.headers[cluster * 2 + 1]!, cpuCount = cpuMirror.headers[cluster * 2 + 1]!;
      if (gpuCount > 0) gpuNonZero++;
      if (cpuCount > 0) cpuNonZero++;
      if (gpuCount !== cpuCount && samples.length < 4) {
        const base = cluster * maxPerCluster;
        samples.push({ cluster, gpuCount, cpuCount,
          gpuOnly: [...gpu.indices.subarray(base, base + gpuCount)].filter(value => !full[cluster]?.includes(value)),
          mirrorOnly: [...cpuMirror.lightIndices.subarray(base, base + cpuCount)].filter(value => !gpu.indices.subarray(base, base + gpuCount).includes(value)) });
      }
    }
    return {
      lightCount: resources.selectedLocalLightCount,
      gridClusters: resources.grid.clusterCount,
      headerCountsMatchCpu: headerCountsMatch(gpu.headers, cpuMirror.headers),
      indexSetsMatchCpu: verdict.match,
      overflowMatchCpu: gpu.overflow === cpuMirror.overflowCount,
      gpuOverflow: gpu.overflow,
      gpuNonZeroClusters: gpuNonZero, cpuNonZeroClusters: cpuNonZero,
      ...(verdict.gpuOutsideFull > 0 ? { overflowSetDiff: { gpuOutsideCpu: verdict.gpuOutsideFull, cpuMissingFromGpu: 0, overflowClusters: 0 } } : {}),
      ...(samples.length ? { countMismatchSamples: samples } : {}),
    };
  } finally {
    culler.dispose();
    for (const buffer of owned) buffer.destroy();
  }
}

export async function probeAdapterInfo(): Promise<string> {
  if (!navigator.gpu) return "navigator.gpu unavailable";
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return "requestAdapter null";
  return JSON.stringify(adapter.info ?? {});
}

/** WGSL 编译诊断:返回 culling 与 probe 着色两个模块的 compilationInfo 消息(真机排障用)。 */
export async function runClusterLightCullingShaderDiagnostics(): Promise<unknown> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const device = await adapter.requestDevice();
  const messages: unknown[] = [];
  device.addEventListener?.("uncapturederror", event => messages.push(String((event as GPUUncapturedErrorEvent).error.message)));
  const diagnose = async (label: string, code: string) => {
    const module = device.createShaderModule({ label, code });
    const info = await module.getCompilationInfo();
    return { label, messages: info.messages.map(message => ({ type: message.type, line: message.lineNum, text: message.message })) };
  };
  const { PROBE_SHADING_WGSL } = await import("./clusterLightCullingBenchmarkWgsl.js");
  return { modules: await Promise.all([
    diagnose("clusterLightCulling", CLUSTER_LIGHT_CULLING_WGSL), diagnose("probeShading", PROBE_SHADING_WGSL)]),
    uncaptured: messages };
}

export async function runClusterLightCullingCorrectness(): Promise<ClusterLightCullingCorrectnessResult> {
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const canvas = document.createElement("canvas");
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal);
  try {
    const legs: CorrectnessLeg[] = [];
    for (const count of [16, 100, 1000, 10000]) {
      legs.push(await correctnessLeg(session.device, session, BENCH_GRID, { points: seededLights(count) }));
    }
    const overflowLights = { points: Array.from({ length: 20 }, () =>
      ({ positionView: [0, 0, -2] as [number, number, number], range: 100, color: [1, 1, 1] as const, intensity: 1 })) };
    const overflowLeg = await correctnessLeg(session.device, session, OVERFLOW_GRID, overflowLights);
    const emptyLeg = await correctnessLeg(session.device, session, OVERFLOW_GRID, {});
    const b1GpuExactAt16 = await b1GpuParityLeg(session);
    const success = legs.every(leg => leg.headerCountsMatchCpu && leg.indexSetsMatchCpu && leg.overflowMatchCpu)
      && overflowLeg.indexSetsMatchCpu && overflowLeg.overflowMatchCpu && overflowLeg.gpuOverflow > 0
      && emptyLeg.indexSetsMatchCpu && emptyLeg.gpuOverflow === 0 && b1GpuExactAt16;
    return { action: "cluster-light-culling-correctness", legs, overflowLeg, emptyLeg, b1GpuExactAt16, success };
  } finally { session.dispose(); }
}

/** B1 GPU 簇心分配(确定性序)与 CPU 参考逐字对拍——换装消费端的双向 ABI 锚点。 */
async function b1GpuParityLeg(session: DeviceSession): Promise<boolean> {
  const device = session.device, assigner = new ForwardPlusClusterAssigner(session), owned: GPUBuffer[] = [];
  try {
    const lights = { points: seededLights(16) };
    const resources = assigner.prepare(OVERFLOW_GRID, lights, { cpuReference: true });
    const header = device.createBuffer({ label: "B1 parity header readback", size: resources.clusterHeaderByteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const index = device.createBuffer({ label: "B1 parity index readback", size: resources.clusterLightIndexByteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    owned.push(header, index);
    const encoder = device.createCommandEncoder({ label: "B1 parity" });
    assigner.encode(encoder);
    encoder.copyBufferToBuffer(resources.clusterHeaderBuffer, 0, header, 0, resources.clusterHeaderByteLength);
    encoder.copyBufferToBuffer(resources.clusterLightIndexBuffer, 0, index, 0, resources.clusterLightIndexByteLength);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await Promise.all([header.mapAsync(GPUMapMode.READ), index.mapAsync(GPUMapMode.READ)]);
    const headers = new Uint32Array(header.getMappedRange().slice(0));
    const indices = new Uint32Array(index.getMappedRange().slice(0));
    header.unmap(); index.unmap();
    const reference = resources.cpuReference!;
    return headers.every((value, i) => value === reference.headers[i])
      && indices.every((value, i) => value === reference.lightIndices[i]);
  } finally { assigner.dispose(); for (const buffer of owned) buffer.destroy(); }
}

export { runClusterLightCullingBenchmark, runClusterLightCullingFurnace };
export type { ClusterLightCullingBenchmarkResult, ClusterLightCullingFurnaceResult };
