/**
 * `.dgc` → Cluster LOD DAG 桥（G1 桥，路 4 公式）：把 decodeDgc 产物映射成
 * clusterLodDag 合同（ClusterLodDagDescriptor + 每层 levelGeometry），供波次 3
 * GPU 选层 / 波次 5 indirect 计划直接消费。与 `dgcDagToMeshletDag`（meshlet 消费面）
 * 互补，不重复：本桥面向 rayTracing 的簇 LOD 合同。
 *
 * == 路 4 映射公式（O(n) 纯函数，无 4:1 假设——缺口 3 裁决） ==
 *   levels[k] 簇 c → 节点 { firstTriangle: descriptors[c*4+2], triangleCount: descriptors[c*4+3],
 *                          error: levels[k].error }
 *   boundsMin/Max  ← bounds 的 16 f32 布局中 word 4..6（aabbMin）/ 8..10（aabbMax）
 *                    （布局 = sphere(4) + aabbMin(4) + aabbMax(4) + cone(4)，meshletBounds 同构）
 *   children       ← parentsByLevel[k] 的 O(n) 反转：粗层簇 p 的 children =
 *                    { 细层 k 簇 c : parentsByLevel[k][c] === p }（父子单射由 decodeDgc 校验）
 *   levelGeometry[k] = levels[k].positions/indices 零拷贝透传（typed array 视图原样共享）
 * bake 管线的 4:1 硬编码（clusterLodBake.ts L51/L58）不适用也不被触碰：本桥按
 * parents 驱动生成 children，GPU 选层数据面（selection/indirectPlan）已核查无 4:1 假设。
 *
 * == 统一误差域（缺口 2 裁决） ==
 * 统一域 = 累计顶点位移（世界单位）。`.dgc` 的 level.error 原生即该语义（逐级 maxDisplacement
 * 累加，黄金样本逐位对拍钉住），桥系数 γ_dgc = 1 直接透传；bake 误差（聚类 cell 边长）经
 * {@link calibrateBakeErrorToDisplacement}（标定系数见常量注释与标定测试）换算到同一域。
 * GPU 选层阈值只存一个域：像素阈值（CLUSTER_LOD_DEFAULT_PIXEL_THRESHOLD）经
 * clusterScreenError 的唯一投影公式作用于统一域节点误差，两来源不再系统性漂移。
 *
 * == fail-closed ==
 * 仅接受 decodeDgc 产物（结构性违规抛 DgcFormatError）；映射完成后运行
 * validateClusterLodDag 全量签核（含缺口 1 的"根可达叶子三角形去重并集"覆盖口径——
 * 孤儿簇按"仅该层可见的额外叶子"计入并集，不与祖先重复计数），invalid 即抛错，
 * 绝不带病输出。
 */
import { DGC_NO_PARENT, decodeDgc, DgcFormatError, type DgcBytes, type DgcDag } from "./dgcLoader.js";
import { validateClusterLodDag, type ClusterLodDagDescriptor, type ClusterLodNodeDescriptor } from "../rayTracing/clusterLodDag.js";
import type { ClusterLodBakeResult } from "../rayTracing/clusterLodBake.js";

/** 桥选项：geometryId 必填（ClusterLodDag 合同的身份字段，显式优于隐式推断）。 */
export interface DgcClusterLodBridgeOptions {
  readonly geometryId: string;
}

/** 桥产物形状与 bakeClusterLodDag 返回值同构（dag + 每层几何），消费面零分叉。 */
export type DgcClusterLodBridgeResult = ClusterLodBakeResult;

/**
 * bake 误差标定系数 α（缺口 2）：bake error = 聚类 cell 边长（单级、几何包围盒近似，
 * 高估真实位移），统一域 = 累计顶点位移。α = "顶点→cell 质心位移 / cell 边长"在黄金样本
 * 上的实测稳健值（quick_sphere/synthetic50k 双样本中位数，标定与容差证据见
 * dgcClusterLodBridgeParity.test.ts 的双臂对拍组：L1 相对真值带 0.354~0.802、
 * 末级累计带 0.802~1.053，0.2153 为两样本可行域 [0.183, 0.242] 的中位数；
 * 旧值 0.85 被双臂对拍证伪为自洽口径，已按实证修正）。
 * `.dgc` 侧系数 γ_dgc = 1（error 原生即累计位移）。
 */
export const BAKE_CELL_ERROR_TO_DISPLACEMENT = 0.2153;

/**
 * bake 聚类 cell 边长序列（level k 的 bake error，level0 = 0）→ 统一累计位移域：
 * out[k] = Σ_{j≤k} α × cellSizes[j]。确定性纯函数（同一输入逐位同输出，测试钉住）。
 */
export function calibrateBakeErrorToDisplacement(cellSizes: readonly number[]): number[] {
  let accumulated = 0;
  return cellSizes.map(cell => (accumulated += Math.max(cell, 0) * BAKE_CELL_ERROR_TO_DISPLACEMENT));
}

/** DgcDag → ClusterLodDagDescriptor + 零拷贝 levelGeometry（合同见文件头）。 */
export function dgcDagToClusterLod(dag: DgcDag, options: DgcClusterLodBridgeOptions): DgcClusterLodBridgeResult {
  if (!options.geometryId) throw new DgcFormatError("dgc cluster-lod bridge: geometryId is required.");
  if (dag.levels.length === 0) {
    throw new DgcFormatError("dgc cluster-lod bridge: zero levels (input must come from decodeDgc)");
  }
  if (dag.parentsByLevel.length !== dag.levels.length - 1) {
    throw new DgcFormatError(`dgc cluster-lod bridge: ${dag.parentsByLevel.length} parent tables for ${dag.levels.length} levels, expected levels-1`);
  }
  // 父表 O(n) 反转：childrenByLevel[k][p] = 引用粗层 k+1 簇 p 的细层 k 簇数组（coarse→fine）。
  const childrenByLevel: number[][][] = [];
  for (let k = 0; k < dag.parentsByLevel.length; k++) {
    const parents = dag.parentsByLevel[k]!;
    const fineCount = dag.levels[k]!.meshletCount;
    if (parents.length !== fineCount) {
      throw new DgcFormatError(`dgc cluster-lod bridge: parent table ${k} has ${parents.length} entries, fine level has ${fineCount} clusters`);
    }
    const children: number[][] = Array.from({ length: dag.levels[k + 1]!.meshletCount }, () => []);
    for (let c = 0; c < parents.length; c++) {
      const parent = parents[c]!;
      if (parent !== DGC_NO_PARENT) children[parent]!.push(c);
    }
    childrenByLevel.push(children);
  }
  const nodes: ClusterLodNodeDescriptor[] = [];
  for (let k = 0; k < dag.levels.length; k++) {
    const level = dag.levels[k]!;
    const descriptors = level.descriptors, bounds = level.bounds;
    for (let c = 0; c < level.meshletCount; c++) {
      const base = c * 16;
      nodes.push(Object.freeze({
        id: `l${k}-c${c}`,
        level: k,
        error: level.error,
        firstTriangle: descriptors[c * 4 + 2]!,
        triangleCount: descriptors[c * 4 + 3]!,
        children: Object.freeze((k > 0 ? childrenByLevel[k - 1]![c]! : []).map(child => `l${k - 1}-c${child}`)),
        boundsMin: Object.freeze([bounds[base + 4]!, bounds[base + 5]!, bounds[base + 6]!]) as readonly [number, number, number],
        boundsMax: Object.freeze([bounds[base + 8]!, bounds[base + 9]!, bounds[base + 10]!]) as readonly [number, number, number],
      }));
    }
  }
  const bridged: ClusterLodDagDescriptor = Object.freeze({
    geometryId: options.geometryId,
    leafTriangleTotal: dag.levels[0]!.indices.length / 3,
    nodes: Object.freeze(nodes),
  });
  const validation = validateClusterLodDag(bridged);
  if (!validation.valid) {
    throw new DgcFormatError(`dgc cluster-lod bridge: bridged DAG failed contract validation: ${validation.reason}`);
  }
  // 零拷贝：levels[k].positions/indices 是 decodeDgc 建立的视图，原样透传（合同要求）。
  const levelGeometry = dag.levels.map(level => ({ vertices: level.positions, indices: level.indices }));
  return { dag: bridged, levelGeometry: Object.freeze(levelGeometry) };
}

/** `.dgc` 字节 → Cluster LOD DAG：先过 decodeDgc 全校验链（损坏即 DgcFormatError）再桥接。 */
export function clusterLodFromDgc(bytes: DgcBytes, options: DgcClusterLodBridgeOptions): DgcClusterLodBridgeResult {
  return dgcDagToClusterLod(decodeDgc(bytes), options);
}
