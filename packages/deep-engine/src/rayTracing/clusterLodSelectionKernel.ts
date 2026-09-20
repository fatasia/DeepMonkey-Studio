/**
 * Cluster LOD GPU 屏幕误差选层 kernel 发射（波次3）：`select_cluster_lod`。
 * [追平-Nanite] 逐 cluster LOD 的 GPU 腿：compute 每 cluster 节点一线程，读 cluster 表 +
 * 相机 uniform，输出选中 LOD 索引数组（selection 槽位 = 选中层级或 REFINE_SENTINEL）。
 *
 * == 语义合同 ==
 * 1. 选层公式与 CPU 参考（clusterLodSelection.clusterScreenError）逐项对应：
 *    depth = max(dot(center − camPosition, forward), MIN_VIEW_DEPTH)，
 *    screenError = errorScalar × viewportHeightPixels / (2 × depth × tanHalfFovY)，
 *    selected = triangleCount > 0 且 screenError ≤ pixelThreshold。f32 与 JS f64 的舍入差
 *    由消费方纪律吸收：kernel 输出只作 GPU 侧初选，前沿闭合（选中且 parent 未选中才绘制）
 *    由 indirect 命令生成方按 clusterLodSelection 头注释的前沿规则应用，阈值边界
 *    （screenError == pixelThreshold）两侧语义一致（同用 ≤）。
 * 2. fail-closed：screenError 非有限或为负（越界相机/损坏 bounds 逃过 CPU 校验）时
 *    atomicAdd 全局哨兵 selectionFaults、本槽位强制 REFINE_SENTINEL；执行器（后续接线，
 *    参照 rayTraceExecutor 的 error-scope 纪律）见到非零哨兵即整批拒绝，绝不静默降级。
 *    无 WebGPU 环境（探测失败）必须走 CPU 参考并显式标注，禁止冒充 GPU 结果。
 * 3. 越界 lane（nodeIndex ≥ nodeCount）在读写前返回，不触 buffer。
 * 4. 布局：buffer 字节映射见 clusterLodSelection.ts 头注释（ClusterLodNode stride 64B、
 *    相机 uniform 48B 纯 vec4f 满足 uniform 对齐合同）。
 * 5. webgpu/ 接线点（本切片不改 webgpu/）：indirect 命令生成（meshletIndirectExecutor
 *    的 writeCommands 前置阶段）消费 selection 数组——按层从粗到细扫描，绘制节点 = 选中
 *    且 parent 未选中；各层 index buffer 取 bake 的 levelGeometry[level]，三角形区间 =
 *    节点 (firstTriangle, triangleCount)（层内局部基址，见打包布局注释）。
 */

import { CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD, CLUSTER_LOD_MIN_VIEW_DEPTH, CLUSTER_LOD_REFINE_SENTINEL,
  CLUSTER_LOD_SELECTION_WORKGROUP_SIZE } from "./clusterLodSelection.js";

export const CLUSTER_LOD_SELECTION_ENTRY_POINT = "select_cluster_lod";

/** WGSL binding 槽位合同（后续执行器的 bindGroup 顺序必须逐项对应）。 */
export const CLUSTER_LOD_SELECTION_BINDINGS = Object.freeze([
  { binding: 0, name: "clusterNodes", type: "read-only-storage" },
  { binding: 1, name: "selection", type: "storage" },
  { binding: 2, name: "selectionFaults", type: "storage" },
  { binding: 3, name: "params", type: "uniform" },
] as const);

/** 发射内核源码；常量自 clusterLodSelection 单一来源插值（改常量即改内核，禁止双写）。 */
export function emitClusterLodSelectionWgsl(): string {
  const workgroup = CLUSTER_LOD_SELECTION_WORKGROUP_SIZE;
  const sentinel = CLUSTER_LOD_REFINE_SENTINEL;
  const minDepth = CLUSTER_LOD_MIN_VIEW_DEPTH;
  const defaultThreshold = CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD;
  return /* wgsl */ `// Cluster LOD screen-error selection kernel (wave 3). Byte layout contract: clusterLodSelection.ts.
// Selection formula arbitrates against clusterLodSelection.clusterScreenError (CPU reference).
const REFINE_SENTINEL: u32 = ${sentinel}u;
const MIN_VIEW_DEPTH: f32 = ${minDepth};
const DEFAULT_PIXEL_THRESHOLD: f32 = ${defaultThreshold}.0;

struct ClusterLodNode {
  boundsMin: vec4f,
  boundsMax: vec4f,
  errorScalar: f32,
  lodLevel: u32,
  clusterIndex: u32,
  firstTriangle: u32,
  triangleCount: u32,
  pad0: u32,
  pad1: u32,
  pad2: u32,
}
struct Params {
  camPositionTanHalf: vec4f,
  forwardThreshold: vec4f,
  viewportNodeCount: vec4f,
}

@group(0) @binding(0) var<storage, read> clusterNodes: array<ClusterLodNode>;
@group(0) @binding(1) var<storage, read_write> selection: array<u32>;
@group(0) @binding(2) var<storage, read_write> selectionFaults: atomic<u32>;
@group(0) @binding(3) var<uniform> params: Params;

@compute @workgroup_size(${workgroup})
fn ${CLUSTER_LOD_SELECTION_ENTRY_POINT}(@builtin(global_invocation_id) gid: vec3u) {
  let nodeIndex = gid.x;
  if (nodeIndex >= u32(params.viewportNodeCount.y)) { return; }
  let node = clusterNodes[nodeIndex];
  let center = (node.boundsMin.xyz + node.boundsMax.xyz) * 0.5;
  let depth = max(dot(center - params.camPositionTanHalf.xyz, params.forwardThreshold.xyz), MIN_VIEW_DEPTH);
  let screenError = node.errorScalar * params.viewportNodeCount.x / (2.0 * depth * params.camPositionTanHalf.w);
  var chosen: u32 = REFINE_SENTINEL;
  if (node.triangleCount > 0u && screenError <= params.forwardThreshold.w) {
    chosen = node.lodLevel;
  }
  if (!(screenError >= 0.0)) {
    // Fail-closed: non-finite/negative screen error poisons the batch via the sentinel.
    atomicAdd(&selectionFaults, 1u);
    chosen = REFINE_SENTINEL;
  }
  selection[nodeIndex] = chosen;
}
`;
}
