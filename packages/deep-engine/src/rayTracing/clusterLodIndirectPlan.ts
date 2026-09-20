/**
 * Cluster LOD 选中槽位 → indexed-indirect 绘制参数计划（波次5 接线合同；纯函数，无 GPU 依赖）。
 *
 * == 消费与产出 ==
 * 输入：bake DAG（clusterLodBake 产物）+ 选层槽位数组（clusterLodSelection.selectClusterLod
 * 的 selection，或真机 kernel select_cluster_lod 读回的同语义槽位——见
 * clusterLodSelectionKernel.ts 头注释第 5 条：kernel 输出是逐节点独立判定，父子可同时过阈）
 * + bake levelGeometry 每层的 index/vertex 规模摘要。
 * 输出：从粗到细的绘制清单（哪个 cluster 画、画哪层的三角区间）、每层在拼接 index/vertex
 * buffer 内的基址跨度、可直接写入 indirect buffer 的 draw-indexed-indirect 5×u32 命令字。
 *
 * == webgpu/meshletIndirectExecutor 接线点（本切片不改 webgpu/ 任何既有文件，合同如下） ==
 * 1. 命令布局逐字对齐：indirectCommand 是 WebGPU draw-indexed-indirect 的 5×u32 记录
 *    (indexCount, instanceCount, firstIndex, baseVertex, firstInstance)，20B 步长与
 *    webgpu/meshletIndirectTypes.MESHLET_DRAW_INDEXED_INDIRECT_STRIDE 相等（单测交叉断言，
 *    src/rayTracing 不反向 import webgpu/，保持依赖方向 rayTracing ← webgpu）。
 * 2. 命令来源替换：meshletIndirectExecutor 的 compute pass（writeCommands，binding 2 的
 *    commands storage）由 culling 可见记录生成同布局命令；cluster LOD 路径以本计划替代该
 *    pass——v0 用 queue.writeBuffer 把 draws 的命令字按槽位顺序写入 STORAGE|INDIRECT|COPY_DST
 *    buffer（commandsByteLength 字节），容量纪律沿用 MESHLET_INDIRECT_MAX_DRAWS 预算。
 * 3. RenderBundle 消费：buildMeshletRenderBundle 的 draw 循环按 drawCount 槽位逐槽
 *    drawIndexedIndirect(commands, slot * 20)；index buffer = 各层 levelGeometry[level].indices
 *    按 level 升序拼接（span.firstIndexBase 以 index 计）；vertex buffer = 各层 vertices 同序
 *    拼接，层间顶点基址差由命令字 baseVertex 槽位（span.baseVertex）吸收，单 bundle 即可。
 * 4. 前沿闭合：绘制节点 = 选中（或已是叶） 且（是根 或 父未选中）（clusterLodSelection 头注释
 *    前沿规则）；每个叶子 cluster 恰被一个前沿绘制覆盖。CPU 参考 frontier（selectClusterLod）
 *    与本计划 deriveClusterLodFrontier 互为仲裁（multiset 相等；CPU 按 dag.nodes 遍历序，
 *    本计划 draws 按 level 从粗到细排序供命令生成消费）；真机 kernel 读回槽位走同一函数
 *    （lab/clusterLodGpuProbe）。
 *
 * == fail-closed ==
 * 槽位长度不匹配、槽位值既非哨兵也非节点自身层级（GPU 读回污染/计划过期）、同一子节点被
 * 两个父引用、层级规模摘要缺失/非负整数违规、前沿闭合破坏——一律抛错，绝不静默降级。
 * 空 cluster（triangleCount=0）按前沿覆盖恒等保留为 indexCount=0 的 no-op 绘制槽位。
 */

import type { ClusterLodDagDescriptor } from "./clusterLodDag.js";
import { CLUSTER_LOD_REFINE_SENTINEL } from "./clusterLodSelection.js";

/** draw-indexed-indirect 记录字节数（5×u32；与 webgpu MESHLET_DRAW_INDEXED_INDIRECT_STRIDE 合同相等）。 */
export const CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES = 20;

/** bake levelGeometry 单层规模摘要（调用方从 { vertices, indices } 映射，避免引入 bake 运行时依赖）。 */
export interface ClusterLodLevelGeometrySummary {
  readonly vertexCount: number;
  readonly indexCount: number;
}

/** 每层在拼接 buffer 内的基址跨度（level 升序 = levelGeometry 顺序；绘制按层从粗到细消费）。 */
export interface ClusterLodLevelSpan {
  readonly level: number;
  /** 拼接 index buffer 内本层基址（以 u32 index 计，非字节）。 */
  readonly firstIndexBase: number;
  readonly indexCount: number;
  /** 拼接 vertex buffer 内本层基址（以顶点计；经命令字 baseVertex 槽位生效）。 */
  readonly baseVertex: number;
  readonly vertexCount: number;
}

export interface ClusterLodIndirectDraw {
  readonly nodeIndex: number;
  readonly nodeId: string;
  readonly level: number;
  /** 层内 cluster 序号（与 packClusterLodNodes 的 per-level 顺序计数一致）。 */
  readonly clusterIndex: number;
  /** 层几何（levelGeometry[level].indices）层内局部三角基址。 */
  readonly firstTriangle: number;
  readonly triangleCount: number;
  /** 拼接 index buffer 内全局 firstIndex = levelSpans[level].firstIndexBase + firstTriangle × 3。 */
  readonly firstIndex: number;
  /** draw-indexed-indirect 5×u32 命令字（indexCount, instanceCount, firstIndex, baseVertex, firstInstance）。 */
  readonly indirectCommand: readonly [number, number, number, number, number];
}

export interface ClusterLodIndirectPlan {
  /** 绘制清单，从粗到细排序（level 降序，同层按 dag.nodes 顺序）；每根区域恰一条。 */
  readonly draws: readonly ClusterLodIndirectDraw[];
  /** 每层拼接基址跨度，level 升序（= levelGeometry 顺序）。 */
  readonly levelSpans: readonly ClusterLodLevelSpan[];
  readonly drawCount: number;
  /** indirect buffer 目标字节数 = drawCount × CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES。 */
  readonly commandsByteLength: number;
  /** 前沿覆盖校验值：根区域数（信息性）；与被前沿恰好一次覆盖的叶子 cluster 数（= 全部叶子，否则抛错）。 */
  readonly coveredRegions: number;
  readonly coveredLeafClusters: number;
}

/**
 * 前沿派生（本计划与真机对拍共用的单一定义，与 selectClusterLod.frontier 逐节点同语义）：
 * 节点入前沿 = （选中 或 已是叶节点） 且（是根 或 父未选中）。bake 的叶层误差恒 0，非空叶
 * 必选中；未选中的叶只可能是空 cluster → 保留为 indexCount=0 的 no-op 绘制槽位，前沿覆盖
 * 与 CPU 参考逐点相等。返回按从粗到细排序的节点下标；槽位值非法时抛错（见 fail-closed）。
 */
export function deriveClusterLodFrontier(dag: ClusterLodDagDescriptor, selection: Uint32Array,
): readonly number[] {
  validateSelection(dag, selection);
  const indexOf = new Map(dag.nodes.map((node, index) => [node.id, index] as const));
  const parentOf = buildParentOf(dag);
  const order = dag.nodes.map((_, index) => index)
    .sort((left, right) => dag.nodes[right]!.level - dag.nodes[left]!.level || left - right);
  const frontier: number[] = [];
  for (const index of order) {
    const node = dag.nodes[index]!;
    const reachesFrontier = selection[index] !== CLUSTER_LOD_REFINE_SENTINEL || node.children.length === 0;
    if (!reachesFrontier) continue;
    const parentId = parentOf.get(node.id);
    const parentSelected = parentId !== undefined
      && selection[indexOf.get(parentId)!] !== CLUSTER_LOD_REFINE_SENTINEL;
    if (!parentSelected) frontier.push(index);
  }
  return Object.freeze(frontier);
}

/** 选中槽位 → indirect 绘制参数计划（合同见头注释；任何不一致 fail-closed 抛错）。 */
export function planClusterLodIndirect(dag: ClusterLodDagDescriptor, selection: Uint32Array,
  levels: readonly ClusterLodLevelGeometrySummary[]): ClusterLodIndirectPlan {
  validateSelection(dag, selection);
  const levelSpans = buildLevelSpans(levels, dag);
  const frontier = deriveClusterLodFrontier(dag, selection);
  const parentOf = buildParentOf(dag);
  const perLevel = new Map<number, number>();
  const clusterIndexOf = new Map<string, number>();
  for (const [index, node] of dag.nodes.entries()) {
    const clusterIndex = perLevel.get(node.level) ?? 0;
    perLevel.set(node.level, clusterIndex + 1);
    clusterIndexOf.set(node.id, clusterIndex);
  }
  const draws = frontier.map((nodeIndex) => {
    const node = dag.nodes[nodeIndex]!;
    const span = levelSpans[node.level]!;
    const firstIndex = span.firstIndexBase + node.firstTriangle * 3;
    return {
      nodeIndex, nodeId: node.id, level: node.level, clusterIndex: clusterIndexOf.get(node.id)!,
      firstTriangle: node.firstTriangle, triangleCount: node.triangleCount, firstIndex,
      indirectCommand: [node.triangleCount * 3, 1, firstIndex, span.baseVertex, 0] as const,
    };
  });
  const coveredLeafClusters = validateLeafCoverage(dag, draws, parentOf);
  return {
    draws, levelSpans, drawCount: draws.length,
    commandsByteLength: draws.length * CLUSTER_LOD_INDIRECT_COMMAND_STRIDE_BYTES,
    coveredRegions: dag.nodes.filter(node => !parentOf.has(node.id)).length,
    coveredLeafClusters,
  };
}

function validateSelection(dag: ClusterLodDagDescriptor, selection: Uint32Array): void {
  if (selection.length !== dag.nodes.length) {
    throw new Error(`Cluster LOD selection length ${selection.length} does not match DAG node count ${dag.nodes.length}.`);
  }
  for (const [index, node] of dag.nodes.entries()) {
    if (!Number.isSafeInteger(node.level) || node.level < 0) {
      throw new Error(`Cluster LOD node ${node.id} carries an invalid level ${node.level}.`);
    }
    const value = selection[index]!;
    if (value === CLUSTER_LOD_REFINE_SENTINEL) continue;
    if (value !== node.level) {
      throw new Error(`Cluster LOD selection slot ${index} carries ${value}, expected sentinel or node level ${node.level}.`);
    }
  }
}

function buildParentOf(dag: ClusterLodDagDescriptor): Map<string, string> {
  const parentOf = new Map<string, string>();
  for (const node of dag.nodes) {
    for (const child of node.children) {
      const existing = parentOf.get(child);
      if (existing !== undefined) {
        throw new Error(`Cluster LOD DAG child ${child} is claimed by both ${existing} and ${node.id}.`);
      }
      parentOf.set(child, node.id);
    }
  }
  return parentOf;
}

function buildLevelSpans(levels: readonly ClusterLodLevelGeometrySummary[], dag: ClusterLodDagDescriptor,
): readonly ClusterLodLevelSpan[] {
  const maxLevel = Math.max(...dag.nodes.map(node => node.level));
  if (levels.length <= maxLevel) {
    throw new Error(`Cluster LOD level summaries (${levels.length}) do not cover DAG level ${maxLevel}.`);
  }
  let firstIndexBase = 0, baseVertex = 0;
  return levels.map((summary, level) => {
    if (!Number.isSafeInteger(summary.indexCount) || summary.indexCount < 0
      || !Number.isSafeInteger(summary.vertexCount) || summary.vertexCount < 0) {
      throw new Error(`Cluster LOD level ${level} geometry summary must be nonnegative safe integers.`);
    }
    const span = { level, firstIndexBase, indexCount: summary.indexCount, baseVertex, vertexCount: summary.vertexCount };
    firstIndexBase += summary.indexCount;
    baseVertex += summary.vertexCount;
    return span;
  });
}

/** 前沿闭合校验：每个叶子 cluster 沿父链到根的路径上恰有一个前沿绘制；否则 fail-closed。 */
function validateLeafCoverage(dag: ClusterLodDagDescriptor, draws: readonly ClusterLodIndirectDraw[],
  parentOf: Map<string, string>): number {
  const drawn = new Set(draws.map(draw => dag.nodes[draw.nodeIndex]!.id));
  let covered = 0;
  for (const leaf of dag.nodes) {
    if (leaf.children.length > 0) continue;
    let onPath = 0;
    for (let cursor: string | undefined = leaf.id; cursor !== undefined; cursor = parentOf.get(cursor)) {
      if (drawn.has(cursor)) onPath += 1;
    }
    if (onPath !== 1) {
      throw new Error(`Cluster LOD frontier closure broken: leaf ${leaf.id} is covered by ${onPath} frontier draws.`);
    }
    covered += 1;
  }
  return covered;
}
