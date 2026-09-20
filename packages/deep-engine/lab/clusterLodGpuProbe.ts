/// <reference types="@webgpu/types" />
/**
 * Cluster LOD 选层 kernel 真机探针（波次5；由 scripts/clusterLodGpuTest.mjs 驱动，headless Chrome + WebGPU）。
 * 模式沿用 rayTraceGpuProbe：Node 侧与浏览器共用同一 bundle——案例生成、bake、打包、CPU 参考、
 * 前沿/indirect 计划派生只此一份（防口径分叉）。浏览器腿走完整 API 路径：packClusterLodNodes /
 * packClusterLodCamera → createBuffer/bindGroup → select_cluster_lod dispatch → 读回 selection+faults。
 * 数值仲裁在 Node 侧：逐槽位与 CPU 参考（selectClusterLod）精确对拍（u32 相等）+ 近细远粗 +
 * 混合前沿 + 阈值单调 + 阈值边界余量门槛（≥5%，远超 f32 舍入；GPU 读回槽位喂
 * planClusterLodIndirect 派生绘制清单，间接合同同机受检）。
 * 案例几何为 32×16 走廊（8 条带状 L0 cluster）：bake 朴素父子链接产出「金字塔区 l2→l1→c0..c3 +
 * 自由叶区 c4..c7」，自由区保持 L0、金字塔区随阈值 0→1→2 粗化，给出真正的混合层级前沿。
 * nodeCount=10 < workgroup 64：每次 dispatch 有 54 个越界 lane，顺带受检 kernel 的越界守卫。
 */

import { bakeClusterLodDag } from "../src/rayTracing/clusterLodBake.js";
import { clusterScreenError, packClusterLodCamera, packClusterLodNodes, selectClusterLod,
  CLUSTER_LOD_SELECTION_WORKGROUP_SIZE, type ClusterLodCamera } from "../src/rayTracing/clusterLodSelection.js";
import { emitClusterLodSelectionWgsl, CLUSTER_LOD_SELECTION_ENTRY_POINT,
} from "../src/rayTracing/clusterLodSelectionKernel.js";
import { planClusterLodIndirect, type ClusterLodLevelGeometrySummary } from "../src/rayTracing/clusterLodIndirectPlan.js";
import type { ClusterLodDagDescriptor } from "../src/rayTracing/clusterLodDag.js";

export { packClusterLodNodes, packClusterLodCamera, selectClusterLod, clusterScreenError,
  CLUSTER_LOD_SELECTION_WORKGROUP_SIZE } from "../src/rayTracing/clusterLodSelection.js";
export { planClusterLodIndirect, deriveClusterLodFrontier } from "../src/rayTracing/clusterLodIndirectPlan.js";
export { emitClusterLodSelectionWgsl, CLUSTER_LOD_SELECTION_ENTRY_POINT } from "../src/rayTracing/clusterLodSelectionKernel.js";

export interface ClusterLodCaseExpectation {
  readonly label: string;
  /** 期望前沿绘制 [nodeId, level]（从粗到细）；与 planClusterLodIndirect(GPU 读回槽位) 的 draws 对拍。 */
  readonly expectedDraws?: readonly (readonly [string, number])[];
  /** 期望最大前沿层级（近细 = 0，远粗 = 最粗层）。 */
  readonly expectedMaxFrontierLevel?: number;
  /** 期望全部槽位过阈（远距场景：slots ≠ frontier 的证据）。 */
  readonly expectedAllSlotsSelected?: boolean;
}

export interface ClusterLodCaseSpec {
  readonly name: string;
  readonly note: string;
  readonly dag: ClusterLodDagDescriptor;
  readonly levels: readonly ClusterLodLevelGeometrySummary[];
  readonly cameras: readonly { readonly label: string; readonly camera: ClusterLodCamera }[];
  /** 与 cameras 一一对应的期望（monotoneSweep 案例无逐机位期望，由 runner 跨机位仲裁）。 */
  readonly expectations: readonly ClusterLodCaseExpectation[];
  readonly monotoneSweep?: boolean;
}

function corridorMesh(): { vertices: Float32Array; indices: Uint32Array } {
  const nx = 32, ny = 16, strideX = nx + 1;
  const vertices = new Float32Array(strideX * (ny + 1) * 3);
  for (let y = 0; y <= ny; y++) for (let x = 0; x <= nx; x++) {
    vertices.set([x, y, Math.sin(x * 0.35 + y * 0.9)], (y * strideX + x) * 3);
  }
  const indices: number[] = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const a = y * strideX + x, b = a + 1, c = a + strideX, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { vertices, indices: Uint32Array.from(indices) };
}

function cameraAt(position: readonly [number, number, number], forward: readonly [number, number, number],
  pixelThreshold = 1): ClusterLodCamera {
  return { position, forward, viewportHeightPixels: 1080, tanHalfFovY: Math.tan(Math.PI / 6), pixelThreshold };
}

interface CorridorFixture {
  readonly baked: ReturnType<typeof bakeClusterLodDag>;
  readonly refineThreshold: number;
  readonly midThreshold: number;
  readonly coarseThreshold: number;
}

/** 走廊夹具：阈值自实际屏幕误差派生（对 bake 数值漂移稳健），保证与边界余量 ≥ 8%。 */
function corridorFixture(): CorridorFixture {
  const mesh = corridorMesh();
  const baked = bakeClusterLodDag({ geometryId: "cluster-lod-gpu-corridor", vertices: mesh.vertices,
    indices: mesh.indices, level0ClusterSize: 128, levelCount: 3 });
  const base = cameraAt([16, -2, 0.5], [0, 1, 0]);
  const errPx = (id: string): number =>
    clusterScreenError(baked.dag.nodes.find(node => node.id === id)!, base);
  const l1 = errPx("l1-c0"), root = errPx("l2-c0");
  return { baked, refineThreshold: l1 * 0.6, midThreshold: l1 * 1.08, coarseThreshold: root * 1.2 };
}

function summaries(baked: ReturnType<typeof bakeClusterLodDag>): ClusterLodLevelGeometrySummary[] {
  return baked.levelGeometry.map(geometry => ({
    vertexCount: geometry.vertices.length / 3, indexCount: geometry.indices.length }));
}

const FREE_LEAVES: readonly (readonly [string, number])[] =
  [["l0-c4", 0], ["l0-c5", 0], ["l0-c6", 0], ["l0-c7", 0]];

/** 确定性案例集：近距全细 / 远距全粗 / 混合前沿 / 阈值单调扫描。 */
export function buildClusterLodCases(): readonly ClusterLodCaseSpec[] {
  const { baked, refineThreshold, midThreshold, coarseThreshold } = corridorFixture();
  const levels = summaries(baked);
  const note = `${baked.dag.nodes.length} 节点金字塔区+自由叶区；阈值派生自 bake 误差投影（余量≥8%）`;
  return [
    { name: "lod-near-fine", note: `近距（视轴 40）全下钻：前沿 = 全部 8 个 L0 cluster。${note}`,
      dag: baked.dag, levels,
      cameras: [{ label: "near", camera: cameraAt([16, 8, 40], [0, 0, -1]) }],
      expectations: [{ label: "near",
        expectedDraws: [["l0-c0", 0], ["l0-c1", 0], ["l0-c2", 0], ["l0-c3", 0],
          ["l0-c4", 0], ["l0-c5", 0], ["l0-c6", 0], ["l0-c7", 0]],
        expectedMaxFrontierLevel: 0 }] },
    { name: "lod-far-coarse", note: `远距（视轴 2e5）金字塔区停在 L2 根，自由叶区保持 L0；槽位全过阈 ≠ 前沿。${note}`,
      dag: baked.dag, levels,
      cameras: [{ label: "far", camera: cameraAt([16, 8, 200000], [0, 0, -1]) }],
      expectations: [{ label: "far", expectedDraws: [["l2-c0", 2], ...FREE_LEAVES],
        expectedMaxFrontierLevel: 2, expectedAllSlotsSelected: true }] },
    { name: "lod-mixed-frontier", note: `中距混合前沿：l1 过阈、根未过阈 → 同帧 L1 + 4×L0。${note}`,
      dag: baked.dag, levels,
      cameras: [{ label: "mid", camera: { ...cameraAt([16, -2, 0.5], [0, 1, 0]), pixelThreshold: midThreshold } }],
      expectations: [{ label: "mid", expectedDraws: [["l1-c0", 1], ...FREE_LEAVES],
        expectedMaxFrontierLevel: 1 }] },
    { name: "lod-threshold-monotone", note: `同机位阈值扫描 ${refineThreshold.toFixed(1)}→${midThreshold.toFixed(1)}→${coarseThreshold.toFixed(1)} px：槽位逐节点单调、前沿最大层级 0→1→2。${note}`,
      dag: baked.dag, levels, monotoneSweep: true,
      cameras: [
        { label: "sweep-fine", camera: { ...cameraAt([16, -2, 0.5], [0, 1, 0]), pixelThreshold: refineThreshold } },
        { label: "sweep-mid", camera: { ...cameraAt([16, -2, 0.5], [0, 1, 0]), pixelThreshold: midThreshold } },
        { label: "sweep-coarse", camera: { ...cameraAt([16, -2, 0.5], [0, 1, 0]), pixelThreshold: coarseThreshold } },
      ],
      expectations: [
        { label: "sweep-fine", expectedMaxFrontierLevel: 0 },
        { label: "sweep-mid", expectedMaxFrontierLevel: 1 },
        { label: "sweep-coarse", expectedMaxFrontierLevel: 2 }] },
  ];
}

export interface ClusterLodCaseRequest {
  readonly name: string;
  readonly nodeCount: number;
  readonly nodesBase64: string;
  /** 每机位一份 48B 相机 uniform（打包顺序 = spec.cameras 顺序）。 */
  readonly paramsBase64: readonly string[];
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

/** 案例规格 → 传输载荷（Node 侧打包，浏览器侧只写 buffer）。 */
export function buildClusterLodRequests(specs: readonly ClusterLodCaseSpec[]): readonly ClusterLodCaseRequest[] {
  return specs.map((spec) => ({
    name: spec.name, nodeCount: spec.dag.nodes.length,
    nodesBase64: toBase64(new Uint8Array(packClusterLodNodes(spec.dag))),
    paramsBase64: spec.cameras.map(({ camera }) =>
      toBase64(new Uint8Array(packClusterLodCamera(camera, spec.dag.nodes.length)))),
  }));
}

export interface ClusterLodCameraResult {
  readonly selectionBase64: string;
  readonly faults: number;
  /** 诊断：读回前 8 个槽位原始值。 */
  readonly firstRawSlots: readonly number[];
}

export interface ClusterLodProbeResult {
  readonly adapter: Readonly<Record<string, string | number>>;
  readonly features: readonly string[];
  readonly cases: Readonly<Record<string, readonly ClusterLodCameraResult[]>>;
  readonly validationMessages: readonly string[];
  readonly errors: readonly string[];
}

const base64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
const USAGE_STORAGE = 0x80, USAGE_COPY_DST = 0x8, USAGE_COPY_SRC = 0x4, USAGE_MAP_READ = 0x1, USAGE_UNIFORM = 0x40;
const MAP_MODE_READ = 0x1;

async function readBack(device: GPUDevice, buffer: GPUBuffer): Promise<ArrayBuffer> {
  await buffer.mapAsync(MAP_MODE_READ);
  try {
    return new Uint8Array(buffer.getMappedRange() as ArrayBuffer).slice().buffer;
  } finally {
    buffer.unmap();
  }
}

/** 浏览器腿：真实 WebGPU 设备上按完整 API 路径 dispatch select_cluster_lod 并读回。 */
export async function runClusterLodGpuProbe(requests: readonly ClusterLodCaseRequest[]): Promise<ClusterLodProbeResult> {
  const errors: string[] = [];
  const cases: Record<string, readonly ClusterLodCameraResult[]> = {};
  if (!navigator.gpu) throw new Error("navigator.gpu unavailable.");
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("requestAdapter returned null.");
  const device = await adapter.requestDevice({ label: "cluster-lod-gpu-probe" });
  device.addEventListener?.("uncapturederror", (event) => {
    errors.push(`uncaptured: ${(event as GPUUncapturedErrorEvent).error.message}`);
  });
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  let validationMessages: string[] = [];
  try {
    const module = device.createShaderModule({ label: "cluster-lod-selection", code: emitClusterLodSelectionWgsl() });
    validationMessages = (await module.getCompilationInfo()).messages
      .filter(message => message.type !== "info")
      .map(message => `${message.type}:${message.lineNum}:${message.message}`);
    const pipeline = device.createComputePipeline({ label: "cluster-lod-selection", layout: "auto",
      compute: { module, entryPoint: CLUSTER_LOD_SELECTION_ENTRY_POINT } });
    for (const request of requests) {
      const nodesBytes = base64ToBytes(request.nodesBase64);
      const results: ClusterLodCameraResult[] = [];
      for (const paramsBase64 of request.paramsBase64) {
        const paramsBytes = base64ToBytes(paramsBase64);
        const nodes = device.createBuffer({ label: "lod-nodes", size: nodesBytes.byteLength,
          usage: USAGE_STORAGE | USAGE_COPY_DST });
        const selection = device.createBuffer({ label: "lod-selection", size: request.nodeCount * 4,
          usage: USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC });
        const faults = device.createBuffer({ label: "lod-faults", size: 4,
          usage: USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC });
        const params = device.createBuffer({ label: "lod-params", size: paramsBytes.byteLength,
          usage: USAGE_UNIFORM | USAGE_COPY_DST });
        const selectionReadback = device.createBuffer({ label: "lod-selection-readback",
          size: request.nodeCount * 4, usage: USAGE_COPY_DST | USAGE_MAP_READ });
        const faultsReadback = device.createBuffer({ label: "lod-faults-readback", size: 4,
          usage: USAGE_COPY_DST | USAGE_MAP_READ });
        try {
          // 同步设备操作段整体包 validation error scope：真机 binding/usage 错误显式抛错，
          // 绝不让失效命令缓冲读回全零被误读成“全哨兵”（沿用 rayTraceExecutor 纪律）。
          device.pushErrorScope("validation");
          const q = device.queue;
          q.writeBuffer(nodes, 0, nodesBytes.buffer, nodesBytes.byteOffset, nodesBytes.byteLength);
          q.writeBuffer(faults, 0, new Uint32Array([0]));
          q.writeBuffer(params, 0, paramsBytes.buffer, paramsBytes.byteOffset, paramsBytes.byteLength);
          const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
            entries: [nodes, selection, faults, params].map((buffer, binding) => ({ binding, resource: { buffer } })) });
          const encoder = device.createCommandEncoder({ label: "cluster-lod-selection" });
          const pass = encoder.beginComputePass({ label: "cluster-lod-selection" });
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(request.nodeCount / CLUSTER_LOD_SELECTION_WORKGROUP_SIZE), 1, 1);
          pass.end();
          encoder.copyBufferToBuffer(selection, 0, selectionReadback, 0, request.nodeCount * 4);
          encoder.copyBufferToBuffer(faults, 0, faultsReadback, 0, 4);
          device.queue.submit([encoder.finish()]);
          const validationError = await device.popErrorScope();
          if (validationError) throw new Error(`Cluster LOD selection GPU validation failed: ${validationError.message}`);
          const [selectionBytes, faultsBytes] = await Promise.all([
            readBack(device, selectionReadback), readBack(device, faultsReadback)]);
          const words = new Uint32Array(selectionBytes);
          results.push({
            selectionBase64: toBase64(new Uint8Array(selectionBytes)),
            faults: new Uint32Array(faultsBytes)[0]!,
            firstRawSlots: [...words.subarray(0, Math.min(8, words.length))],
          });
        } finally {
          for (const buffer of [nodes, selection, faults, params, selectionReadback, faultsReadback]) buffer.destroy();
        }
      }
      cases[request.name] = results;
    }
  } finally {
    device.destroy();
  }
  return {
    adapter: { vendor: info?.vendor ?? "", architecture: info?.architecture ?? "", device: info?.device ?? "",
      description: info?.description ?? "" },
    features: [...adapter.features].sort(),
    cases, validationMessages, errors,
  };
}
