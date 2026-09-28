/**
 * T26 簇级代理批生成:聚合树 + 折叠簇集合 → 代理网格批 + 汇总统计(纯 CPU)。
 *
 * - 代理内容 = 该簇成员摘要集的纯函数(hlodProxyGeometry);节点 id = 子树内容哈希
 *   (第一切片)⇒ 子树不变的簇跨帧/跨增量更新得到**逐位相同**的代理(测试断言)。
 * - 决策对接:`generateHlodProxiesForFrame` 直接消费第一切片 `decideHlodFrame` 的
 *   折叠簇列表——决策到代理的端到端 CPU 链路。
 * - 三角形口径:调用方可选提供 instanceId → 源三角形数(来自真实网格,如 GLB
 *   accessor);缺省时三角形削减率 = null(不虚称削减)。
 */

import { contentHash64 } from "./hlodIdentity.js";
import { HlodError, type HlodClusterTree, type HlodFrameDecision } from "./hlodTypes.js";
import { generateClusterProxyGeometry, resolveHlodProxyOptions, validateHlodShapes } from "./hlodProxyGeometry.js";
import { measureHlodProxyError } from "./hlodProxyMetrics.js";
import {
  HLOD_PROXY_ALGORITHM_VERSION,
  type HlodInstanceShape,
  type HlodProxyConfiguration,
  type HlodProxyErrorMetrics,
  type HlodProxyOptions,
  type HlodProxyResult,
} from "./hlodProxyTypes.js";

export interface HlodProxyBatchEntry {
  readonly nodeId: string;
  readonly level: number;
  readonly instanceCount: number;
  /** 代理几何 id(联测接线用):`hlod-proxy-` + 内容指纹(节点 id + 版本 + 预算)。 */
  readonly geometryId: string;
  readonly proxy: HlodProxyResult;
  readonly metrics: HlodProxyErrorMetrics;
  /** Σ成员源三角形(调用方未提供三角形表 → null,不估算)。 */
  readonly originalTriangles: number | null;
  /** 1 − 代理三角形/源三角形(源为 0 → null)。 */
  readonly triangleSavingRatio: number | null;
}

export interface HlodProxyBatchTotals {
  readonly proxyCount: number;
  readonly proxyTriangleCount: number;
  readonly coveredInstances: number;
  readonly originalTriangles: number | null;
  /** 1 − Σ代理三角形/Σ源三角形(缺源表 → null)。 */
  readonly triangleReductionRatio: number | null;
  /** 各簇 instanceToProxyMax 的最大值(簇半径归一由调用方做)。 */
  readonly instanceToProxyMax: number;
  readonly proxyBoxVolume: number;
  readonly instanceBoxVolume: number;
}

export interface HlodProxyBatch {
  /** nodeId 升序。 */
  readonly entries: readonly HlodProxyBatchEntry[];
  readonly totals: HlodProxyBatchTotals;
}

export interface HlodProxyBatchOptions extends HlodProxyOptions {
  /** instanceId → 源网格三角形数(真实值,来自网格 accessor;不提供 → 削减率为 null)。 */
  readonly trianglesByInstance?: ReadonlyMap<string, number> | undefined;
}

/**
 * 为指定内节点集合生成簇代理。nodeId 重复 fail-closed;未知/叶节点 fail-closed;
 * 簇成员缺摘要 fail-closed。汇总按 nodeId 升序累加(确定性)。
 */
export function generateHlodClusterProxies(tree: HlodClusterTree,
  shapes: readonly HlodInstanceShape[] | ReadonlyMap<string, HlodInstanceShape>,
  nodeIds: readonly string[], options: HlodProxyBatchOptions = {}): HlodProxyBatch {
  const config = resolveHlodProxyOptions(options);
  const shapeByInstance = toShapeMap(shapes);
  const trianglesByInstance = options.trianglesByInstance;
  const seen = new Set<string>();
  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) throw new HlodError("invalid-node", `Duplicate proxy target node: ${nodeId}.`);
    seen.add(nodeId);
  }
  const entries: HlodProxyBatchEntry[] = [...seen].sort().map(nodeId => {
    const node = tree.nodes.get(nodeId);
    if (!node) throw new HlodError("invalid-node", `Proxy target node ${nodeId} is not in the tree.`);
    if (node.children.length === 0) {
      throw new HlodError("invalid-node", `Proxy target ${nodeId} is a leaf; leaves render instances.`);
    }
    const memberShapes: HlodInstanceShape[] = [];
    let originalTriangles = 0;
    let hasTriangles = trianglesByInstance !== undefined;
    for (const instanceId of node.instanceIds) {
      const shape = shapeByInstance.get(instanceId);
      if (!shape) throw new HlodError("unknown-instance", `Cluster ${nodeId} member ${instanceId} has no instance shape.`);
      memberShapes.push(shape);
      if (hasTriangles) {
        const triangles = trianglesByInstance!.get(instanceId);
        if (triangles === undefined) throw new HlodError("unknown-instance",
          `Cluster ${nodeId} member ${instanceId} is missing from trianglesByInstance.`);
        originalTriangles += triangles;
      }
    }
    const proxy = generateClusterProxyGeometry(validateHlodShapes(memberShapes), config);
    const metrics = measureHlodProxyError(memberShapes, proxy.mesh, config);
    return {
      nodeId,
      level: node.level,
      instanceCount: node.instanceCount,
      geometryId: proxyGeometryId(nodeId, config),
      proxy,
      metrics,
      originalTriangles: hasTriangles ? originalTriangles : null,
      triangleSavingRatio: hasTriangles && originalTriangles > 0
        ? 1 - proxy.mesh.triangleCount / originalTriangles
        : null,
    };
  });
  return Object.freeze({ entries: Object.freeze(entries), totals: totalsOf(entries) });
}

/** 决策对接:为 `decideHlodFrame` 的折叠簇生成代理批。 */
export function generateHlodProxiesForFrame(tree: HlodClusterTree,
  shapes: readonly HlodInstanceShape[] | ReadonlyMap<string, HlodInstanceShape>,
  frame: HlodFrameDecision, options: HlodProxyBatchOptions = {}): HlodProxyBatch {
  if (!frame || typeof frame !== "object" || !Array.isArray(frame.collapsedNodes)) {
    throw new HlodError("invalid-options", "HLOD proxy frame decision is malformed.");
  }
  return generateHlodClusterProxies(tree, shapes, frame.collapsedNodes.map(decision => decision.nodeId), options);
}

function toShapeMap(shapes: readonly HlodInstanceShape[] | ReadonlyMap<string, HlodInstanceShape>):
  ReadonlyMap<string, HlodInstanceShape> {
  if (shapes instanceof Map) return shapes;
  if (!Array.isArray(shapes)) throw new HlodError("invalid-shape", "HLOD instance shapes must be an array or map.");
  const map = new Map<string, HlodInstanceShape>();
  for (const shape of shapes) {
    if (map.has(shape?.instanceId ?? "")) {
      throw new HlodError("duplicate-instance-id", `Duplicate HLOD instance shape id: ${String(shape?.instanceId)}.`);
    }
    map.set(shape.instanceId, shape);
  }
  return map;
}

function proxyGeometryId(nodeId: string, config: HlodProxyConfiguration): string {
  return `hlod-proxy-${contentHash64(
    `P\u0000${HLOD_PROXY_ALGORITHM_VERSION}\u0000${nodeId}\u0000${config.maxProxyTriangles}`)}`;
}

function totalsOf(entries: readonly HlodProxyBatchEntry[]): HlodProxyBatchTotals {
  let proxyTriangleCount = 0;
  let coveredInstances = 0;
  let originalTriangles: number | null = 0;
  let instanceToProxyMax = 0;
  let proxyBoxVolume = 0;
  let instanceBoxVolume = 0;
  for (const entry of entries) {
    proxyTriangleCount += entry.proxy.mesh.triangleCount;
    coveredInstances += entry.instanceCount;
    instanceToProxyMax = Math.max(instanceToProxyMax, entry.metrics.instanceToProxyMax);
    proxyBoxVolume += entry.metrics.proxyBoxVolume;
    instanceBoxVolume += entry.metrics.instanceBoxVolume;
    if (entry.originalTriangles === null) originalTriangles = null;
    else if (originalTriangles !== null) originalTriangles += entry.originalTriangles;
  }
  return Object.freeze({
    proxyCount: entries.length,
    proxyTriangleCount,
    coveredInstances,
    originalTriangles,
    triangleReductionRatio: originalTriangles !== null && originalTriangles > 0
      ? 1 - proxyTriangleCount / originalTriangles
      : null,
    instanceToProxyMax,
    proxyBoxVolume,
    instanceBoxVolume,
  });
}
