/**
 * B4 簇级流送测试夹具(仅测试消费):合成实例集 → 聚合树 → 代理批 → 合法 manifest。
 * 字段组装镜像 apps/api hlodPackageSource 的确定性升序规则,但零 apps/api 依赖
 * (apps/api 在本切片的禁碰清单内);校验由 hlodTreeFromManifest 的
 * validateHlodPackageManifest fail-closed 兜底。
 */

import { buildHlodTree, generateHlodClusterProxies, HLOD_PACKAGE_SCHEMA, HLOD_PACKAGE_VERSION,
  HLOD_PROXY_ALGORITHM_VERSION, resolveHlodDecisionOptions, type HlodClusterTree,
  type HlodPackageInstanceInput, type HlodPackageLevelSummary, type HlodPackageManifest,
  type HlodPackageNodeRecord, type HlodPackageProxyRecord } from "../hlod/index.js";
import type { GeometryResource } from "../renderPacket.js";

export interface TestHlodPackage {
  readonly manifest: HlodPackageManifest;
  readonly geometries: readonly GeometryResource[];
  readonly tree: HlodClusterTree;
}

/** 合成实例集 → 完整 HLOD 包(manifest + 代理几何);决策阈值可调以便相机场景可控。 */
export function buildTestHlodPackage(instances: readonly HlodPackageInstanceInput[],
  options: { readonly targetPixelError?: number; readonly hysteresisRatio?: number } = {}): TestHlodPackage {
  const decision = resolveHlodDecisionOptions(options);
  const tree = buildHlodTree(instances);
  const internalNodeIds = [...tree.nodes.values()]
    .filter(node => node.children.length > 0).map(node => node.id).sort();
  const batch = generateHlodClusterProxies(tree, instances.map(instance => ({
    instanceId: instance.id, min: [instance.position[0] - instance.radius, instance.position[1] - instance.radius,
      instance.position[2] - instance.radius], max: [instance.position[0] + instance.radius,
      instance.position[1] + instance.radius, instance.position[2] + instance.radius] })), internalNodeIds, {});
  const geometries: GeometryResource[] = batch.entries.map(entry => ({
    id: entry.geometryId, revision: 0, vertices: entry.proxy.mesh.vertices, indices: entry.proxy.mesh.indices }));
  const nodes: HlodPackageNodeRecord[] = [...tree.nodes.values()]
    .map(node => ({ id: node.id, level: node.level, parent: tree.parentByNode.get(node.id) ?? null,
      children: node.children, instanceIds: node.instanceIds, instanceCount: node.instanceCount,
      center: node.center, radius: node.radius, cell: node.cell }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const proxies: HlodPackageProxyRecord[] = batch.entries.map(entry => ({ nodeId: entry.nodeId,
    level: entry.level, geometryId: entry.geometryId, instanceCount: entry.instanceCount,
    boxCount: entry.proxy.mesh.boxCount, triangleCount: entry.proxy.mesh.triangleCount }));
  const levels = new Map<number, HlodPackageLevelSummary>();
  for (const proxy of proxies) {
    const current = levels.get(proxy.level) ?? { level: proxy.level, proxyCount: 0, proxyTriangleCount: 0, coveredInstances: 0 };
    levels.set(proxy.level, { level: proxy.level, proxyCount: current.proxyCount + 1,
      proxyTriangleCount: current.proxyTriangleCount + proxy.triangleCount,
      coveredInstances: current.coveredInstances + proxy.instanceCount });
  }
  const center = [0, 1, 2].map(axis => instances.reduce((sum, instance) => sum + instance.position[axis]!, 0)
    / instances.length) as [number, number, number];
  const extent = Math.max(...instances.map(instance => Math.hypot(
    instance.position[0]! - center[0]!, instance.position[1]! - center[1]!, instance.position[2]! - center[2]!)
    + instance.radius));
  const manifest: HlodPackageManifest = { schema: HLOD_PACKAGE_SCHEMA, version: HLOD_PACKAGE_VERSION,
    clusterAlgorithmVersion: tree.algorithmVersion, proxyAlgorithmVersion: HLOD_PROXY_ALGORITHM_VERSION,
    decision: { targetPixelError: decision.targetPixelError, hysteresisRatio: decision.hysteresisRatio },
    clusterOptions: tree.options, proxyTriangleBudget: batch.totals.proxyTriangleCount || 12,
    rootCell: tree.rootCell, rootId: tree.rootId, stats: tree.stats, nodes,
    levels: [...levels.values()].sort((left, right) => left.level - right.level), proxies,
    tiers: [], sceneSphere: { center, extent: extent * 2 }, instanceCount: instances.length,
    sourceTriangleCount: instances.length * 12, proxyTriangleCount: batch.totals.proxyTriangleCount };
  return { manifest, geometries, tree };
}
