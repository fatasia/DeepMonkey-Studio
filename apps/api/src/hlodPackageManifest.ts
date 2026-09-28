import {
  HLOD_ALGORITHM_VERSION,
  HLOD_PROXY_ALGORITHM_VERSION,
  HlodError,
  resolveHlodDecisionOptions,
  type HlodCell,
  type HlodClusterNode,
  type HlodClusterStats,
  type HlodClusterTree,
} from "@bim-studio/deep-engine/hlod";
import {
  HLOD_PACKAGE_SCHEMA,
  HLOD_PACKAGE_VERSION,
  type HlodPackageLevelSummary,
  type HlodPackageManifest,
  type HlodPackageNodeRecord,
  type HlodPackageProxyRecord,
  type HlodPackageTierEvidence,
} from "./hlodPackageTypes.js";

/**
 * HLOD manifest 字段的序列化/校验/消费(渲染包 manifest 构造面)。
 *
 * - `parseHlodPackageManifest`:fail-closed 全量校验(字段白名单、图一致性、统计复核),
 *   未知字段拒绝——与 runtimePackage 渲染包读取器同一纪律,Native/客户端契约不吃脏数据。
 * - `hlodTreeFromManifest`:从 manifest 记录重建 deep-engine 决策树(客户端零重聚类:
 *   节点对象按记录重建,决策只依赖 nodes/rootId/stats.leafCount ⇒ 与包侧逐位同决策)。
 * - 序列化 = 解析后的规范化对象 JSON 化(同包逐字节稳定,支撑包级 diff/哈希)。
 */

const MANIFEST_KEYS = ["schema", "version", "clusterAlgorithmVersion", "proxyAlgorithmVersion", "decision",
  "clusterOptions", "proxyTriangleBudget", "rootCell", "rootId", "stats", "nodes", "levels", "proxies",
  "tiers", "sceneSphere", "instanceCount", "sourceTriangleCount", "proxyTriangleCount"] as const;
const NODE_KEYS = ["id", "level", "parent", "children", "instanceIds", "instanceCount", "center", "radius", "cell"] as const;
const CELL_KEYS = ["center", "side"] as const;
const STATS_KEYS = ["nodeCount", "leafCount", "internalCount", "depth", "maxFanout"] as const;
const PROXY_KEYS = ["nodeId", "level", "geometryId", "instanceCount", "boxCount", "triangleCount"] as const;
const LEVEL_KEYS = ["level", "proxyCount", "proxyTriangleCount", "coveredInstances"] as const;
const TIER_KEYS = ["scale", "collapsedNodes", "coveredInstances", "proxyTriangleCount"] as const;

export function serializeHlodPackageManifest(manifest: HlodPackageManifest): string {
  return JSON.stringify(parseHlodPackageManifest(JSON.parse(JSON.stringify(manifest))), null, 2);
}

export function parseHlodPackageManifest(input: unknown): HlodPackageManifest {
  const value = record(input, "manifest");
  exactFields(value, MANIFEST_KEYS, "manifest");
  if (value.schema !== HLOD_PACKAGE_SCHEMA) fail(`manifest.schema 必须为 ${HLOD_PACKAGE_SCHEMA}`);
  if (value.version !== HLOD_PACKAGE_VERSION) fail(`manifest.version 必须为 ${HLOD_PACKAGE_VERSION}`);
  if (value.clusterAlgorithmVersion !== HLOD_ALGORITHM_VERSION) fail("manifest.clusterAlgorithmVersion 与本构建不一致");
  if (value.proxyAlgorithmVersion !== HLOD_PROXY_ALGORITHM_VERSION) fail("manifest.proxyAlgorithmVersion 与本构建不一致");
  const decisionRaw = record(value.decision, "manifest.decision");
  exactFields(decisionRaw, ["targetPixelError", "hysteresisRatio"], "manifest.decision");
  const decision = resolveHlodDecisionOptions({
    targetPixelError: number(decisionRaw.targetPixelError, "manifest.decision.targetPixelError"),
    hysteresisRatio: number(decisionRaw.hysteresisRatio, "manifest.decision.hysteresisRatio"),
  });
  const optionsRaw = record(value.clusterOptions, "manifest.clusterOptions");
  exactFields(optionsRaw, ["maxChildren", "maxDepth"], "manifest.clusterOptions");
  const clusterOptions = {
    maxChildren: positiveInt(optionsRaw.maxChildren, "manifest.clusterOptions.maxChildren"),
    maxDepth: positiveInt(optionsRaw.maxDepth, "manifest.clusterOptions.maxDepth"),
  };
  const proxyTriangleBudget = positiveInt(value.proxyTriangleBudget, "manifest.proxyTriangleBudget");
  if (proxyTriangleBudget % 12 !== 0) fail("manifest.proxyTriangleBudget 必须为 12 的倍数");
  const rootCell = parseCell(value.rootCell);
  const rootId = value.rootId === null ? null : text(value.rootId, "manifest.rootId");
  const stats = parseStats(value.stats);
  const nodes = array(value.nodes, "manifest.nodes").map((item, index) => parseNode(item, index));
  const levels = array(value.levels, "manifest.levels").map((item, index) => parseLevel(item, index));
  const proxies = array(value.proxies, "manifest.proxies").map((item, index) => parseProxy(item, index));
  const tiers = array(value.tiers, "manifest.tiers").map((item, index) => parseTier(item, index));
  const sceneSphereRaw = record(value.sceneSphere, "manifest.sceneSphere");
  exactFields(sceneSphereRaw, ["center", "extent"], "manifest.sceneSphere");
  const sceneSphere = {
    center: point(sceneSphereRaw.center, "manifest.sceneSphere.center"),
    extent: positiveFinite(number(sceneSphereRaw.extent, "manifest.sceneSphere.extent"), "manifest.sceneSphere.extent"),
  };
  const instanceCount = nonNegativeInt(value.instanceCount, "manifest.instanceCount");
  const sourceTriangleCount = nonNegativeInt(value.sourceTriangleCount, "manifest.sourceTriangleCount");
  const proxyTriangleCount = nonNegativeInt(value.proxyTriangleCount, "manifest.proxyTriangleCount");
  const manifest = freezeManifest({ schema: HLOD_PACKAGE_SCHEMA, version: HLOD_PACKAGE_VERSION,
    clusterAlgorithmVersion: HLOD_ALGORITHM_VERSION, proxyAlgorithmVersion: HLOD_PROXY_ALGORITHM_VERSION,
    decision, clusterOptions, proxyTriangleBudget, rootCell, rootId, stats, nodes, levels, proxies, tiers,
    sceneSphere, instanceCount, sourceTriangleCount, proxyTriangleCount });
  // 解析即全量图校验:损坏的 manifest 在读取面 fail-closed,不带病进入消费端。
  validateHlodPackageManifest(manifest);
  return manifest;
}

/** 图一致性与统计复核(解析后必查;失败即包损坏,fail-closed)。 */
export function validateHlodPackageManifest(manifest: HlodPackageManifest): void {
  const ids = new Set<string>();
  for (const node of manifest.nodes) {
    if (ids.has(node.id)) fail(`manifest 节点 id 重复:${node.id}`);
    ids.add(node.id);
  }
  let leafCount = 0, internalCount = 0, depth = 0, maxFanout = 0;
  const leafInstances = new Set<string>();
  for (const node of manifest.nodes) {
    if (node.parent !== null && !ids.has(node.parent)) fail(`manifest 节点 ${node.id} 的父引用缺失:${node.parent}`);
    for (const child of node.children) {
      if (!ids.has(child)) fail(`manifest 节点 ${node.id} 引用缺失子节点:${child}`);
    }
    if (node.children.length === 0) {
      leafCount += 1;
      if (node.level !== 0) fail(`manifest 叶节点 ${node.id} 的 level 必须为 0`);
      for (const instanceId of node.instanceIds) {
        if (leafInstances.has(instanceId)) fail(`manifest 实例被重复指派:${instanceId}`);
        leafInstances.add(instanceId);
      }
      if (node.instanceIds.length !== node.instanceCount) fail(`manifest 叶节点 ${node.id} 实例计数不一致`);
    } else {
      internalCount += 1;
      if (node.instanceIds.length !== node.instanceCount) fail(`manifest 簇节点 ${node.id} 实例计数不一致`);
    }
    depth = Math.max(depth, node.level);
    maxFanout = Math.max(maxFanout, node.children.length);
  }
  if (manifest.stats.nodeCount !== manifest.nodes.length || manifest.stats.leafCount !== leafCount
    || manifest.stats.internalCount !== internalCount || manifest.stats.depth !== depth
    || manifest.stats.maxFanout !== maxFanout) {
    fail("manifest.stats 与节点记录复核不一致");
  }
  if (leafInstances.size !== manifest.instanceCount) fail("manifest.instanceCount 与叶指派不一致");
  if (manifest.rootId !== null && !ids.has(manifest.rootId)) fail(`manifest.rootId 缺失:${manifest.rootId}`);
  if (manifest.rootId === null && manifest.nodes.length > 0) fail("manifest.rootId 为空但节点表非空");
  const nodeById = new Map(manifest.nodes.map(node => [node.id, node]));
  let proxyTriangleTotal = 0;
  const levelSeen = new Map<number, HlodPackageLevelSummary>();
  for (const proxy of manifest.proxies) {
    const node = nodeById.get(proxy.nodeId);
    if (!node) fail(`manifest 代理引用缺失节点:${proxy.nodeId}`);
    if (node!.children.length === 0) fail(`manifest 代理挂在叶节点:${proxy.nodeId}`);
    if (proxy.level !== node!.level) fail(`manifest 代理 ${proxy.nodeId} 层级与节点不一致`);
    if (proxy.instanceCount !== node!.instanceCount) fail(`manifest 代理 ${proxy.nodeId} 实例计数与节点不一致`);
    if (proxy.triangleCount % 12 !== 0 || proxy.triangleCount > manifest.proxyTriangleBudget) {
      fail(`manifest 代理 ${proxy.nodeId} 违反三角形预算`);
    }
    if (proxy.boxCount < 1 || proxy.boxCount * 12 !== proxy.triangleCount) {
      fail(`manifest 代理 ${proxy.nodeId} 盒/三角形账目不一致`);
    }
    proxyTriangleTotal += proxy.triangleCount;
    const current = levelSeen.get(proxy.level);
    levelSeen.set(proxy.level, {
      level: proxy.level,
      proxyCount: (current?.proxyCount ?? 0) + 1,
      proxyTriangleCount: (current?.proxyTriangleCount ?? 0) + proxy.triangleCount,
      coveredInstances: (current?.coveredInstances ?? 0) + proxy.instanceCount,
    });
  }
  if (proxyTriangleTotal !== manifest.proxyTriangleCount) fail("manifest.proxyTriangleCount 与代理记录不一致");
  if (manifest.levels.length !== levelSeen.size) fail("manifest.levels 档数与代理层级不一致");
  for (const level of manifest.levels) {
    const expected = levelSeen.get(level.level);
    if (!expected
      || expected.proxyCount !== level.proxyCount
      || expected.proxyTriangleCount !== level.proxyTriangleCount
      || expected.coveredInstances !== level.coveredInstances) {
      fail(`manifest.levels[${level.level}] 与代理记录不一致`);
    }
  }
}

/** 客户端零重聚类:manifest 记录 → deep-engine 决策树(决策逐位等价于包侧构建)。 */
export function hlodTreeFromManifest(manifest: HlodPackageManifest): HlodClusterTree {
  validateHlodPackageManifest(manifest);
  const nodes = new Map<string, HlodClusterNode>();
  const leafByInstance = new Map<string, string>();
  const parentByNode = new Map<string, string | null>();
  for (const node of manifest.nodes) {
    nodes.set(node.id, Object.freeze({
      id: node.id, level: node.level, cell: Object.freeze({ center: node.cell.center, side: node.cell.side }),
      children: Object.freeze(node.children), instanceIds: Object.freeze(node.instanceIds),
      instanceCount: node.instanceCount, center: node.center, radius: node.radius,
    }));
    parentByNode.set(node.id, node.parent);
    if (node.children.length === 0) {
      for (const instanceId of node.instanceIds) leafByInstance.set(instanceId, node.id);
    }
  }
  return Object.freeze({
    algorithmVersion: HLOD_ALGORITHM_VERSION,
    options: Object.freeze({ ...manifest.clusterOptions }),
    rootCell: Object.freeze({ center: manifest.rootCell.center, side: manifest.rootCell.side }),
    rootId: manifest.rootId,
    nodes,
    leafByInstance,
    parentByNode,
    stats: Object.freeze({ ...manifest.stats }),
  });
}

// ---------------------------------------------------------------------------
// 字段级解析(白名单 + 取值域;风格与 runtimePackage 读取器一致)。
// ---------------------------------------------------------------------------

function parseCell(input: unknown): HlodCell {
  const value = record(input, "manifest.rootCell");
  exactFields(value, CELL_KEYS, "manifest.rootCell");
  const side = number(value.side, "manifest.rootCell.side");
  if (!(side > 0) || !Number.isFinite(side) || (side & (side - 1)) !== 0) fail("manifest.rootCell.side 必须为 2 的幂");
  return { center: point(value.center, "manifest.rootCell.center"), side };
}

function parseStats(input: unknown): HlodClusterStats {
  const value = record(input, "manifest.stats");
  exactFields(value, STATS_KEYS, "manifest.stats");
  return {
    nodeCount: nonNegativeInt(value.nodeCount, "manifest.stats.nodeCount"),
    leafCount: nonNegativeInt(value.leafCount, "manifest.stats.leafCount"),
    internalCount: nonNegativeInt(value.internalCount, "manifest.stats.internalCount"),
    depth: nonNegativeInt(value.depth, "manifest.stats.depth"),
    maxFanout: nonNegativeInt(value.maxFanout, "manifest.stats.maxFanout"),
  };
}

function parseNode(input: unknown, index: number): HlodPackageNodeRecord {
  const path = `manifest.nodes[${index}]`;
  const value = record(input, path);
  exactFields(value, NODE_KEYS, path);
  const parent = value.parent === null ? null : text(value.parent, `${path}.parent`);
  return {
    id: text(value.id, `${path}.id`),
    level: nonNegativeInt(value.level, `${path}.level`),
    parent,
    children: array(value.children, `${path}.children`).map(child => text(child, `${path}.children`)),
    instanceIds: array(value.instanceIds, `${path}.instanceIds`).map(id => text(id, `${path}.instanceIds`)),
    instanceCount: nonNegativeInt(value.instanceCount, `${path}.instanceCount`),
    center: point(value.center, `${path}.center`),
    radius: nonNegativeFinite(number(value.radius, `${path}.radius`), `${path}.radius`),
    cell: parseCell(value.cell),
  };
}

function parseProxy(input: unknown, index: number): HlodPackageProxyRecord {
  const path = `manifest.proxies[${index}]`;
  const value = record(input, path);
  exactFields(value, PROXY_KEYS, path);
  return {
    nodeId: text(value.nodeId, `${path}.nodeId`),
    level: nonNegativeInt(value.level, `${path}.level`),
    geometryId: text(value.geometryId, `${path}.geometryId`),
    instanceCount: positiveInt(value.instanceCount, `${path}.instanceCount`),
    boxCount: positiveInt(value.boxCount, `${path}.boxCount`),
    triangleCount: positiveInt(value.triangleCount, `${path}.triangleCount`),
  };
}

function parseLevel(input: unknown, index: number): HlodPackageLevelSummary {
  const path = `manifest.levels[${index}]`;
  const value = record(input, path);
  exactFields(value, LEVEL_KEYS, path);
  return {
    level: nonNegativeInt(value.level, `${path}.level`),
    proxyCount: positiveInt(value.proxyCount, `${path}.proxyCount`),
    proxyTriangleCount: positiveInt(value.proxyTriangleCount, `${path}.proxyTriangleCount`),
    coveredInstances: positiveInt(value.coveredInstances, `${path}.coveredInstances`),
  };
}

function parseTier(input: unknown, index: number): HlodPackageTierEvidence {
  const path = `manifest.tiers[${index}]`;
  const value = record(input, path);
  exactFields(value, TIER_KEYS, path);
  return {
    scale: positiveFinite(number(value.scale, `${path}.scale`), `${path}.scale`),
    collapsedNodes: nonNegativeInt(value.collapsedNodes, `${path}.collapsedNodes`),
    coveredInstances: nonNegativeInt(value.coveredInstances, `${path}.coveredInstances`),
    proxyTriangleCount: nonNegativeInt(value.proxyTriangleCount, `${path}.proxyTriangleCount`),
  };
}

function freezeManifest(manifest: HlodPackageManifest): HlodPackageManifest {
  return Object.freeze({
    ...manifest,
    decision: Object.freeze({ ...manifest.decision }),
    clusterOptions: Object.freeze({ ...manifest.clusterOptions }),
    rootCell: Object.freeze({ center: Object.freeze(manifest.rootCell.center), side: manifest.rootCell.side }),
    stats: Object.freeze({ ...manifest.stats }),
    nodes: Object.freeze(manifest.nodes.map(node => Object.freeze({ ...node }))),
    levels: Object.freeze(manifest.levels.map(level => Object.freeze({ ...level }))),
    proxies: Object.freeze(manifest.proxies.map(proxy => Object.freeze({ ...proxy }))),
    tiers: Object.freeze(manifest.tiers.map(tier => Object.freeze({ ...tier }))),
    sceneSphere: Object.freeze({ center: Object.freeze(manifest.sceneSphere.center), extent: manifest.sceneSphere.extent }),
  });
}

function record(input: unknown, path: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail(`${path} 必须为对象`);
  return input as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(`${path}.${key} 为未知字段(Native/客户端契约拒绝)`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key} 缺失`);
    if (value[key] === null && key !== "parent" && key !== "rootId") fail(`${path}.${key} 为 null`);
  }
}

function array(input: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(input)) fail(`${path} 必须为数组`);
  return input;
}

function text(input: unknown, path: string): string {
  if (typeof input !== "string" || input.length === 0) fail(`${path} 必须为非空字符串`);
  return input;
}

function number(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isFinite(input)) fail(`${path} 必须为有限数值`);
  return input;
}

function nonNegativeInt(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0) fail(`${path} 必须为非负安全整数`);
  return input;
}

function positiveInt(input: unknown, path: string): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1) fail(`${path} 必须为正安全整数`);
  return input;
}

function positiveFinite(input: number, path: string): number {
  if (input <= 0) fail(`${path} 必须为正数`);
  return input;
}

function nonNegativeFinite(input: number, path: string): number {
  if (input < 0) fail(`${path} 必须为非负数`);
  return input;
}

function point(input: unknown, path: string): readonly [number, number, number] {
  const value = array(input, path).map((component, index) => number(component, `${path}[${index}]`));
  if (value.length !== 3) fail(`${path} 必须为 3 分量点`);
  return Object.freeze([value[0]!, value[1]!, value[2]!]);
}

function fail(message: string): never {
  throw new HlodError("invalid-options", `HLOD package manifest invalid: ${message}`);
}
