/**
 * Cluster LOD DAG 的 GPU 屏幕误差选层合同 + CPU 参考选层（波次3，[追平-Nanite] 核心件）。
 * 消费 bake DAG（clusterLodBake.ts 产物，clusterLodDag.ts 合同）；输出供 indirect 命令
 * 生成（webgpu/meshletIndirectExecutor 接线点，见 clusterLodSelectionKernel.ts 头注释）消费。
 *
 * == 选层规则（CPU 参考与 WGSL kernel 逐式对应，单一定义在本文件） ==
 * 视轴深度   depth        = max(dot(boundsCenter − camPosition, viewForward), MIN_VIEW_DEPTH)
 *                          （相机背后/贴面的 cluster 被钳到极小深度 → 屏幕误差放大 → 保守下钻）
 * 屏幕误差   screenError  = errorScalar × viewportHeightPixels / (2 × depth × tanHalfFovY)
 * 选中判定   selected     = triangleCount > 0 且 screenError ≤ pixelThreshold
 * 输出槽位   selection[i] = selected ? lodLevel : REFINE_SENTINEL（"选中 LOD 索引数组"）
 * 前沿规则   绘制节点 i 当且仅当 selected(i) 且（i 是根 或 parent(i) 未选中）；
 *            误差沿 DAG 向下单调不增（parent.error ≥ child.error，选层前置校验 fail-closed）
 *            ⇒ parent 未选中时其子树内恰有一层选中 ⇒ 前沿对叶子区域恰好一次覆盖。
 *            kernel 逐节点独立判定（无 parent 指针）；前沿闭合由 indirect 命令生成方
 *            按层从粗到细扫描应用，CPU 参考的 frontier 遍历是其仲裁基准。
 *
 * == ClusterLodNode 字节映射合同（stride 64B = 16 words，与 bake DAG 逐字段对应） ==
 * WGSL struct 对齐 16B（vec4f 成员），stride 64B 满足 array<ClusterLodNode> 步长合同；
 * f32 槽与 u32 槽共用同一 buffer 双视图写入（模式同 rayTraceLayout.ts）：
 *
 *   byte  0..15  boundsMin: vec4f = (minX, minY, minZ, 0)        ← w 为 pad
 *   byte 16..31  boundsMax: vec4f = (maxX, maxY, maxZ, 0)        ← w 为 pad
 *   byte 32..35  errorScalar: f32  bake 误差标量原值（合同：单调不增向下）
 *   byte 36..39  lodLevel:   u32   0 = 叶层 meshlet cluster，越大越粗
 *   byte 40..43  clusterIndex: u32 该节点在自身层内的 cluster 序号（层内稳定身份）
 *   byte 44..47  firstTriangle: u32 层几何（levelGeometry[level].indices）层内局部基址
 *   byte 48..51  triangleCount: u32 0 = 空 cluster，恒不选中
 *   byte 52..63  pad0..pad2: u32   恒 0
 *
 * == 相机 uniform 字节映射（48B = 12 words = 3×vec4f，纯 vec4f 保证 uniform 16B 对齐） ==
 *   byte  0..15  camPositionTanHalf: vec4f = (px, py, pz, tan(fovY/2))
 *   byte 16..31  forwardThreshold:   vec4f = (fx, fy, fz, pixelThreshold)，forward 须归一
 *   byte 32..43  viewportNodeCount:  vec4f = (viewportHeightPixels, nodeCount, 0, 0)
 *                nodeCount 以 f32 携带：≤ maxBatchRays = 2^20 < 2^24，f32 精确，kernel 内 u32() 还原。
 */

import type { ClusterLodDagDescriptor, ClusterLodNodeDescriptor } from "./clusterLodDag.js";
import { RAY_BACKEND_LIMITS } from "./rayBackendTypes.js";

/** ClusterLodNode storage stride：64 字节 = 16 words。 */
export const CLUSTER_LOD_NODE_STRIDE_BYTES = 64;
export const CLUSTER_LOD_NODE_STRIDE_WORDS = 16;
/** 下钻哨兵：selection 槽位值 = 未选中（投影屏幕误差超阈值或空 cluster）。 */
export const CLUSTER_LOD_REFINE_SENTINEL = 0xffff_ffff;
/** kernel workgroup 尺寸（x 维，每 lane 一 cluster 节点）。 */
export const CLUSTER_LOD_SELECTION_WORKGROUP_SIZE = 64;
/** 相机 uniform 字节数：3×vec4f。 */
export const CLUSTER_LOD_CAMERA_UNIFORM_BYTES = 48;
/** 默认屏幕误差阈值：1 像素（Nanite 式感知阈值；调用方可覆盖）。 */
export const CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD = 1;
/** 视轴深度下限：防除零；背后/贴面 cluster 保守放大屏幕误差强制下钻。 */
export const CLUSTER_LOD_MIN_VIEW_DEPTH = 1e-6;

// —— ClusterLodNode 槽位偏移（words，相对节点基址） ——
export const CLUSTER_LOD_NODE_WORD = Object.freeze({
  boundsMinX: 0, boundsMinY: 1, boundsMinZ: 2, boundsMinPad: 3,
  boundsMaxX: 4, boundsMaxY: 5, boundsMaxZ: 6, boundsMaxPad: 7,
  errorScalar: 8, lodLevel: 9, clusterIndex: 10, firstTriangle: 11, triangleCount: 12,
  pad0: 13, pad1: 14, pad2: 15,
} as const);

// —— 相机 uniform 槽位偏移（words） ——
export const CLUSTER_LOD_CAMERA_WORD = Object.freeze({
  camPosX: 0, camPosY: 1, camPosZ: 2, tanHalfFovY: 3,
  forwardX: 4, forwardY: 5, forwardZ: 6, pixelThreshold: 7,
  viewportHeightPixels: 8, nodeCount: 9, pad0: 10, pad1: 11,
} as const);

/** 选层相机：位置 + 视轴（须归一）+ 视口高度像素 + 垂直半视角正切 + 像素阈值。 */
export interface ClusterLodCamera {
  readonly position: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly viewportHeightPixels: number;
  readonly tanHalfFovY: number;
  readonly pixelThreshold: number;
}

/** bake DAG → storage buffer 字节（见头注释映射；节点槽位顺序 = dag.nodes 顺序）。 */
export function packClusterLodNodes(dag: ClusterLodDagDescriptor): ArrayBuffer {
  if (dag.nodes.length > RAY_BACKEND_LIMITS.maxBatchRays) {
    throw new Error(`Cluster LOD node table exceeds maxBatchRays budget (${RAY_BACKEND_LIMITS.maxBatchRays}).`);
  }
  const buffer = new ArrayBuffer(dag.nodes.length * CLUSTER_LOD_NODE_STRIDE_BYTES);
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  const w = CLUSTER_LOD_NODE_WORD;
  const perLevel = new Map<number, number>();
  for (const [index, node] of dag.nodes.entries()) {
    const base = index * CLUSTER_LOD_NODE_STRIDE_WORDS;
    floats[base + w.boundsMinX] = node.boundsMin[0];
    floats[base + w.boundsMinY] = node.boundsMin[1];
    floats[base + w.boundsMinZ] = node.boundsMin[2];
    floats[base + w.boundsMinPad] = 0;
    floats[base + w.boundsMaxX] = node.boundsMax[0];
    floats[base + w.boundsMaxY] = node.boundsMax[1];
    floats[base + w.boundsMaxZ] = node.boundsMax[2];
    floats[base + w.boundsMaxPad] = 0;
    floats[base + w.errorScalar] = node.error;
    words[base + w.lodLevel] = node.level;
    const clusterIndex = perLevel.get(node.level) ?? 0;
    perLevel.set(node.level, clusterIndex + 1);
    words[base + w.clusterIndex] = clusterIndex;
    words[base + w.firstTriangle] = node.firstTriangle;
    words[base + w.triangleCount] = node.triangleCount;
    words[base + w.pad0] = 0;
    words[base + w.pad1] = 0;
    words[base + w.pad2] = 0;
  }
  return buffer;
}

export interface SerializedClusterLodNode {
  readonly errorScalar: number;
  readonly lodLevel: number;
  readonly clusterIndex: number;
  readonly firstTriangle: number;
  readonly triangleCount: number;
  readonly minX: number; readonly minY: number; readonly minZ: number;
  readonly maxX: number; readonly maxY: number; readonly maxZ: number;
}

/** 反序列化（roundtrip/对拍验证用；与 packClusterLodNodes 严格互逆）。 */
export function unpackClusterLodNodes(buffer: ArrayBuffer): readonly SerializedClusterLodNode[] {
  if (buffer.byteLength % CLUSTER_LOD_NODE_STRIDE_BYTES !== 0) {
    throw new Error(`Cluster LOD node buffer must be a multiple of ${CLUSTER_LOD_NODE_STRIDE_BYTES} bytes.`);
  }
  const floats = new Float32Array(buffer);
  const words = new Uint32Array(buffer);
  const w = CLUSTER_LOD_NODE_WORD;
  const nodes: SerializedClusterLodNode[] = [];
  for (let base = 0; base < words.length; base += CLUSTER_LOD_NODE_STRIDE_WORDS) {
    nodes.push({
      errorScalar: floats[base + w.errorScalar]!,
      lodLevel: words[base + w.lodLevel]!,
      clusterIndex: words[base + w.clusterIndex]!,
      firstTriangle: words[base + w.firstTriangle]!,
      triangleCount: words[base + w.triangleCount]!,
      minX: floats[base + w.boundsMinX]!, minY: floats[base + w.boundsMinY]!, minZ: floats[base + w.boundsMinZ]!,
      maxX: floats[base + w.boundsMaxX]!, maxY: floats[base + w.boundsMaxY]!, maxZ: floats[base + w.boundsMaxZ]!,
    });
  }
  return nodes;
}

/** 相机 + 节点数 → 48B uniform 字节（fail-closed：任何非有限/非正字段抛错）。 */
export function packClusterLodCamera(camera: ClusterLodCamera, nodeCount: number): ArrayBuffer {
  validateCamera(camera);
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 0 || nodeCount > RAY_BACKEND_LIMITS.maxBatchRays) {
    throw new Error("Cluster LOD camera nodeCount must be a safe integer within maxBatchRays.");
  }
  const buffer = new ArrayBuffer(CLUSTER_LOD_CAMERA_UNIFORM_BYTES);
  const floats = new Float32Array(buffer);
  const w = CLUSTER_LOD_CAMERA_WORD;
  floats[w.camPosX] = camera.position[0];
  floats[w.camPosY] = camera.position[1];
  floats[w.camPosZ] = camera.position[2];
  floats[w.tanHalfFovY] = camera.tanHalfFovY;
  floats[w.forwardX] = camera.forward[0];
  floats[w.forwardY] = camera.forward[1];
  floats[w.forwardZ] = camera.forward[2];
  floats[w.pixelThreshold] = camera.pixelThreshold;
  floats[w.viewportHeightPixels] = camera.viewportHeightPixels;
  floats[w.nodeCount] = nodeCount;
  floats[w.pad0] = 0;
  floats[w.pad1] = 0;
  return buffer;
}

function validateCamera(camera: ClusterLodCamera): void {
  const finite = (value: number): boolean => Number.isFinite(value);
  if (camera.position.length !== 3 || !camera.position.every(finite)) {
    throw new Error("Cluster LOD camera position must be 3 finite numbers.");
  }
  if (camera.forward.length !== 3 || !camera.forward.every(finite)) {
    throw new Error("Cluster LOD camera forward must be 3 finite numbers.");
  }
  const length = Math.hypot(camera.forward[0], camera.forward[1], camera.forward[2]);
  if (!(length > 0)) throw new Error("Cluster LOD camera forward must be nonzero.");
  if (!finite(camera.viewportHeightPixels) || camera.viewportHeightPixels <= 0) {
    throw new Error("Cluster LOD camera viewportHeightPixels must be finite and positive.");
  }
  if (!finite(camera.tanHalfFovY) || camera.tanHalfFovY <= 0) {
    throw new Error("Cluster LOD camera tanHalfFovY must be finite and positive.");
  }
  if (!finite(camera.pixelThreshold) || camera.pixelThreshold <= 0) {
    throw new Error("Cluster LOD camera pixelThreshold must be finite and positive.");
  }
}

/** 单节点投影屏幕误差（像素）。与 WGSL kernel 的表达式逐项对应，禁止单侧改动。 */
export function clusterScreenError(node: Pick<ClusterLodNodeDescriptor, "boundsMin" | "boundsMax" | "error">,
  camera: ClusterLodCamera): number {
  const centerX = (node.boundsMin[0] + node.boundsMax[0]) * 0.5;
  const centerY = (node.boundsMin[1] + node.boundsMax[1]) * 0.5;
  const centerZ = (node.boundsMin[2] + node.boundsMax[2]) * 0.5;
  const axisDepth = (centerX - camera.position[0]) * camera.forward[0]
    + (centerY - camera.position[1]) * camera.forward[1]
    + (centerZ - camera.position[2]) * camera.forward[2];
  const depth = Math.max(axisDepth, CLUSTER_LOD_MIN_VIEW_DEPTH);
  return node.error * camera.viewportHeightPixels / (2 * depth * camera.tanHalfFovY);
}

export interface ClusterLodSelection {
  /** 每 cluster 节点槽位（= dag.nodes 顺序）：选中 LOD 层级索引，或 REFINE_SENTINEL。 */
  readonly selection: Uint32Array;
  /** 每节点投影屏幕误差（像素），诊断/对拍证据；Float32Array 存储（f32 量化，对拍用 Math.fround）。 */
  readonly screenErrors: Float32Array;
  /** 绘制前沿（仲裁基准）：从根下钻、首个选中或叶子节点；对叶子区域恰好一次覆盖。 */
  readonly frontier: readonly string[];
}

/**
 * CPU 参考选层（GPU kernel 的仲裁基准）。fail-closed：相机非法、误差/包围盒非有限、
 * DAG 误差单调前提被破坏一律抛错，绝不静默降级。
 */
export function selectClusterLod(dag: ClusterLodDagDescriptor, camera: ClusterLodCamera): ClusterLodSelection {
  validateCamera(camera);
  const byId = new Map(dag.nodes.map(node => [node.id, node] as const));
  const indexOf = new Map(dag.nodes.map((node, index) => [node.id, index] as const));
  const selection = new Uint32Array(dag.nodes.length);
  const screenErrors = new Float32Array(dag.nodes.length);
  for (const [index, node] of dag.nodes.entries()) {
    if (!Number.isFinite(node.error) || node.error < 0) {
      throw new Error(`Cluster LOD node ${node.id} error must be finite and nonnegative.`);
    }
    if (!node.boundsMin.every(Number.isFinite) || !node.boundsMax.every(Number.isFinite)) {
      throw new Error(`Cluster LOD node ${node.id} bounds must be finite.`);
    }
    for (const child of node.children) {
      const childNode = byId.get(child);
      if (childNode === undefined) throw new Error(`Cluster LOD node ${node.id} references unknown child ${child}.`);
      if (childNode.error > node.error) {
        throw new Error(`Cluster LOD error monotonicity violated at ${node.id} -> ${child}: parent error must dominate.`);
      }
    }
    screenErrors[index] = clusterScreenError(node, camera);
    const selected = node.triangleCount > 0 && screenErrors[index]! <= camera.pixelThreshold;
    selection[index] = selected ? node.level : CLUSTER_LOD_REFINE_SENTINEL;
  }
  const isChild = new Set(dag.nodes.flatMap(node => node.children));
  const frontier: string[] = [];
  const visit = (node: ClusterLodNodeDescriptor): void => {
    const index = indexOf.get(node.id)!;
    if (selection[index] !== CLUSTER_LOD_REFINE_SENTINEL || node.children.length === 0) {
      frontier.push(node.id);
      return;
    }
    for (const child of node.children) visit(byId.get(child)!);
  };
  for (const node of dag.nodes) {
    if (!isChild.has(node.id)) visit(node);
  }
  return { selection, screenErrors, frontier: Object.freeze(frontier) };
}
