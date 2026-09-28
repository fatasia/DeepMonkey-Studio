import type { GeometryResource } from "@bim-studio/deep-engine";
import {
  HLOD_PROXY_ALGORITHM_VERSION,
  HlodError,
  buildHlodTree,
  decideHlodFrame,
  generateHlodClusterProxies,
  resolveHlodDecisionOptions,
  resolveHlodProxyOptions,
  type ClusterLodCamera,
  type HlodClusterTree,
  type HlodFrameDecision,
  type HlodInstanceInput,
  type HlodInstanceShape,
  type HlodProxyBatch,
} from "@bim-studio/deep-engine/hlod";
import {
  HLOD_PACKAGE_SCHEMA,
  HLOD_PACKAGE_VERSION,
  HLOD_PROXY_GEOMETRY_PREFIX,
  type HlodPackageBuildOptions,
  type HlodPackageBuildResult,
  type HlodPackageInstanceInput,
  type HlodPackageLevelSummary,
  type HlodPackageManifest,
  type HlodPackageNodeRecord,
  type HlodPackageProxyRecord,
  type HlodPackageTierEvidence,
} from "./hlodPackageTypes.js";

/**
 * T26 renderPacket 接线:核心构建管线(数组入参,可脱离 GLB/渲染包复用)。
 * 实例(球 + 盒 + 三角形数)→ 聚合树 → 全部内节点的簇代理(按树层级档预生成,
 * 决策完备:客户端任意相机折叠的簇必命中包内代理)→ 渲染包几何 + manifest 字段。
 *
 * 确定性:节点 id = 内容哈希、geometryId = 节点内容 + 版本 + 预算的哈希、
 * manifest 各表升序、参考档相机为场景球的纯函数 ⇒ 同输入逐位同包。
 * fail-closed:实例形状/选项非法在 deep-engine 校验层抛 HlodError;本层补
 * 重复 id、几何 id 碰撞守卫与代理预算证据复核。
 */

export const HLOD_PACKAGE_REFERENCE_TIER_SCALES = Object.freeze([0.25, 1, 4, 64]) as readonly number[];

/**
 * 参考机位档的 canonical 相机约定(与 T26 车间统计/createFactoryWorkshopScene 同偏移):
 * eye = center + extent×(1.4,1.5,1.8)×scale,forward 指向场景中心,fov π/4,540p。
 * scale 是场景包围球 extent 的倍数 ⇒ 相机是实例集的纯函数,包侧/客户端可独立复算。
 */
export function hlodReferenceCamera(sphere: {
  readonly center: readonly [number, number, number];
  readonly extent: number;
}, scale: number): ClusterLodCamera {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new HlodError("invalid-options", `HLOD reference tier scale must be finite and positive, got ${scale}.`);
  }
  const tanHalfFovY = Math.tan(Math.PI / 4 / 2);
  const eye: [number, number, number] = [
    sphere.center[0] + 1.4 * sphere.extent * scale,
    sphere.center[1] + 1.5 * sphere.extent * scale,
    sphere.center[2] + 1.8 * sphere.extent * scale,
  ];
  const forward: [number, number, number] = [
    sphere.center[0] - eye[0], sphere.center[1] - eye[1], sphere.center[2] - eye[2],
  ];
  const length = Math.hypot(forward[0], forward[1], forward[2]);
  if (length === 0) throw new HlodError("invalid-camera", "HLOD reference camera collapsed onto the scene center.");
  return Object.freeze({
    position: Object.freeze(eye),
    forward: Object.freeze([forward[0] / length, forward[1] / length, forward[2] / length] as const),
    viewportHeightPixels: 540,
    tanHalfFovY,
    pixelThreshold: 1,
  });
}

/** 场景包围球(extent = 半跨度,退化钳 1e-3);与决策机位共用同一约定。 */
export function hlodSceneSphere(instances: readonly HlodPackageInstanceInput[]): {
  readonly center: readonly [number, number, number];
  readonly extent: number;
} {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const instance of instances) {
    validateInstanceInput(instance);
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, instance.sphereCenter[axis]! - instance.sphereRadius);
      max[axis] = Math.max(max[axis]!, instance.sphereCenter[axis]! + instance.sphereRadius);
    }
  }
  if (instances.length === 0) return Object.freeze({ center: Object.freeze([0, 0, 0] as const), extent: 1e-3 });
  const center: [number, number, number] = [
    (min[0]! + max[0]!) * 0.5, (min[1]! + max[1]!) * 0.5, (min[2]! + max[2]!) * 0.5];
  const extent = Math.max(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) * 0.5;
  return Object.freeze({ center: Object.freeze(center), extent: Math.max(extent, 1e-3) });
}

/** 核心入口:构建渲染包 HLOD 片段(manifest + 零转换代理几何)。 */
export function buildHlodPackage(instances: readonly HlodPackageInstanceInput[],
  options: HlodPackageBuildOptions = {}): HlodPackageBuildResult {
  validateInstances(instances);
  const decision = resolveHlodDecisionOptions({
    ...(options.targetPixelError === undefined ? {} : { targetPixelError: options.targetPixelError }),
    ...(options.hysteresisRatio === undefined ? {} : { hysteresisRatio: options.hysteresisRatio }),
  });
  const proxyOptions = resolveHlodProxyOptions(
    options.maxProxyTriangles === undefined ? {} : { maxProxyTriangles: options.maxProxyTriangles });
  // 配置面只有盒预算;有效三角形预算 = 盒预算 × 12(与生成器硬约束同源)。
  const effectiveTriangleBudget = proxyOptions.proxyBoxBudget * 12;
  const tree = buildHlodTree(instances.map(toHlodInstance), {
    ...(options.maxChildren === undefined ? {} : { maxChildren: options.maxChildren }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
  });
  const internalNodeIds = [...tree.nodes.values()]
    .filter(node => node.children.length > 0).map(node => node.id).sort();
  const batch = generateHlodClusterProxies(tree, shapesOf(instances), internalNodeIds, {
    maxProxyTriangles: proxyOptions.maxProxyTriangles,
    trianglesByInstance: trianglesByInstance(instances),
  });
  verifyBudgetInvariant(batch, effectiveTriangleBudget);
  const geometries = batch.entries.map((entry): GeometryResource => Object.freeze({
    id: entry.geometryId,
    // 内容寻址 id:内容变化必然换 id,revision 恒 0(渲染包合同"内容变化必须递增版本"
    // 以 id 为准绳满足,不虚增版本号)。
    revision: 0,
    // 零转换接线:typed array 与代理网格同一引用,可直接投 RenderPacket.geometries。
    vertices: entry.proxy.mesh.vertices,
    indices: entry.proxy.mesh.indices,
  }));
  const manifest = buildManifest(instances, tree, batch, decision, options, effectiveTriangleBudget);
  return Object.freeze({ manifest, geometries: Object.freeze(geometries) });
}

/** 渲染包接线守卫:代理几何 id 与既有渲染包几何冲突时 fail-closed(禁止静默覆盖)。 */
export function mergeHlodProxyGeometries(existingGeometryIds: readonly string[],
  result: HlodPackageBuildResult): readonly GeometryResource[] {
  const existing = new Set(existingGeometryIds);
  for (const geometry of result.geometries) {
    if (existing.has(geometry.id)) {
      throw new HlodError("invalid-options", `HLOD proxy geometry ID collides with the packet: ${geometry.id}.`);
    }
    if (!geometry.id.startsWith(HLOD_PROXY_GEOMETRY_PREFIX)) {
      throw new HlodError("invalid-options", `HLOD proxy geometry id lacks the reserved prefix: ${geometry.id}.`);
    }
  }
  return [...result.geometries];
}

/**
 * 决策 → 绘制列表(客户端运行时消费路径;纯函数)。
 * 折叠簇 → 包内代理几何 id(缺失 fail-closed,不冒充"无代理继续画实例")。
 */
export function hlodProxyDrawList(result: HlodPackageBuildResult, frame: HlodFrameDecision): {
  readonly draws: readonly { readonly nodeId: string; readonly geometryId: string;
    readonly instanceCount: number; readonly triangleCount: number }[];
  readonly renderedInstanceIds: readonly string[];
  readonly hiddenInstances: number;
} {
  const proxyByNode = new Map(result.manifest.proxies.map(proxy => [proxy.nodeId, proxy]));
  const draws = frame.collapsedNodes.map(decision => {
    const proxy = proxyByNode.get(decision.nodeId);
    if (!proxy) {
      throw new HlodError("unknown-node", `Collapsed cluster ${decision.nodeId} has no baked proxy in the package.`);
    }
    return Object.freeze({
      nodeId: proxy.nodeId, geometryId: proxy.geometryId,
      instanceCount: proxy.instanceCount, triangleCount: proxy.triangleCount,
    });
  });
  return Object.freeze({
    draws: Object.freeze(draws),
    renderedInstanceIds: Object.freeze(frame.renderedLeaves),
    hiddenInstances: frame.hiddenInstances,
  });
}

// ---------------------------------------------------------------------------
// 内部:输入整形与 manifest 组装(全部确定性升序)。
// ---------------------------------------------------------------------------

function validateInstances(instances: readonly HlodPackageInstanceInput[]): void {
  if (!Array.isArray(instances)) throw new HlodError("invalid-instance", "HLOD package instances must be an array.");
  const seen = new Set<string>();
  for (const instance of instances) {
    validateInstanceInput(instance);
    if (seen.has(instance.instanceId)) {
      throw new HlodError("duplicate-instance-id", `Duplicate HLOD package instance id: ${instance.instanceId}.`);
    }
    seen.add(instance.instanceId);
  }
}

function validateInstanceInput(instance: HlodPackageInstanceInput): void {
  if (!instance || typeof instance !== "object") {
    throw new HlodError("invalid-instance", "HLOD package instance must be an object.");
  }
  const finite3 = (value: readonly number[]): boolean =>
    value.length === 3 && value.every(component => Number.isFinite(component));
  if (typeof instance.instanceId !== "string" || instance.instanceId.length === 0) {
    throw new HlodError("invalid-instance", "HLOD package instance requires a non-empty instanceId.");
  }
  if (!finite3(instance.sphereCenter) || !Number.isFinite(instance.sphereRadius) || instance.sphereRadius < 0) {
    throw new HlodError("invalid-instance", `HLOD instance ${instance.instanceId} has an invalid bounding sphere.`);
  }
  if (!finite3(instance.min) || !finite3(instance.max)
    || instance.min.some((value, axis) => value > instance.max[axis]!)) {
    throw new HlodError("invalid-instance", `HLOD instance ${instance.instanceId} has an invalid world AABB.`);
  }
  if (!Number.isSafeInteger(instance.triangles) || instance.triangles < 0) {
    throw new HlodError("invalid-instance", `HLOD instance ${instance.instanceId} has an invalid triangle count.`);
  }
}

function toHlodInstance(instance: HlodPackageInstanceInput): HlodInstanceInput {
  return { id: instance.instanceId, position: instance.sphereCenter, radius: instance.sphereRadius };
}

function shapesOf(instances: readonly HlodPackageInstanceInput[]): readonly HlodInstanceShape[] {
  return instances.map(instance => Object.freeze({
    instanceId: instance.instanceId, min: instance.min, max: instance.max,
  }));
}

function trianglesByInstance(instances: readonly HlodPackageInstanceInput[]): ReadonlyMap<string, number> {
  return new Map(instances.map(instance => [instance.instanceId, instance.triangles]));
}

/** 预算是生成器硬约束(第二切片);此处对整包复核,防上游合同漂移。 */
function verifyBudgetInvariant(batch: HlodProxyBatch, effectiveTriangleBudget: number): void {
  for (const entry of batch.entries) {
    if (entry.proxy.mesh.triangleCount > effectiveTriangleBudget || entry.proxy.mesh.triangleCount % 12 !== 0) {
      throw new HlodError("invalid-options",
        `HLOD proxy ${entry.geometryId} violates the triangle budget `
          + `(${entry.proxy.mesh.triangleCount} > ${effectiveTriangleBudget}).`);
    }
  }
}

function buildManifest(instances: readonly HlodPackageInstanceInput[], tree: HlodClusterTree,
  batch: HlodProxyBatch, decision: { targetPixelError: number; hysteresisRatio: number },
  options: HlodPackageBuildOptions, proxyTriangleBudget: number): HlodPackageManifest {
  const nodes: HlodPackageNodeRecord[] = [...tree.nodes.values()]
    .map(node => ({
      id: node.id, level: node.level, parent: tree.parentByNode.get(node.id) ?? null,
      children: node.children, instanceIds: node.instanceIds, instanceCount: node.instanceCount,
      center: node.center, radius: node.radius, cell: node.cell,
    }))
    .sort((left, right) => compareText(left.id, right.id));
  const proxies: HlodPackageProxyRecord[] = batch.entries.map(entry => ({
    nodeId: entry.nodeId, level: entry.level, geometryId: entry.geometryId,
    instanceCount: entry.instanceCount, boxCount: entry.proxy.mesh.boxCount,
    triangleCount: entry.proxy.mesh.triangleCount,
  }));
  const triangleByNode = new Map(proxies.map(proxy => [proxy.nodeId, proxy.triangleCount]));
  const levels = levelSummaries(proxies);
  const sceneSphere = hlodSceneSphere(instances);
  const scales = options.referenceTierScales === undefined
    ? HLOD_PACKAGE_REFERENCE_TIER_SCALES
    : [...options.referenceTierScales].sort((left, right) => left - right);
  const tiers: HlodPackageTierEvidence[] = scales.map(scale => {
    const frame = decideHlodFrame(tree, hlodReferenceCamera(sceneSphere, scale), decision);
    return {
      scale,
      collapsedNodes: frame.collapsedNodes.length,
      coveredInstances: frame.hiddenInstances,
      proxyTriangleCount: frame.collapsedNodes.reduce((sum, item) => sum + (triangleByNode.get(item.nodeId) ?? 0), 0),
    };
  });
  const sourceTriangleCount = instances.reduce((sum, instance) => sum + instance.triangles, 0);
  return Object.freeze({
    schema: HLOD_PACKAGE_SCHEMA,
    version: HLOD_PACKAGE_VERSION,
    clusterAlgorithmVersion: tree.algorithmVersion,
    proxyAlgorithmVersion: HLOD_PROXY_ALGORITHM_VERSION,
    decision: Object.freeze({ targetPixelError: decision.targetPixelError, hysteresisRatio: decision.hysteresisRatio }),
    clusterOptions: Object.freeze({ maxChildren: tree.options.maxChildren, maxDepth: tree.options.maxDepth }),
    proxyTriangleBudget,
    rootCell: tree.rootCell,
    rootId: tree.rootId,
    stats: tree.stats,
    nodes: Object.freeze(nodes),
    levels: Object.freeze(levels),
    proxies: Object.freeze(proxies),
    tiers: Object.freeze(tiers),
    sceneSphere: Object.freeze({ center: sceneSphere.center, extent: sceneSphere.extent }),
    instanceCount: instances.length,
    sourceTriangleCount,
    proxyTriangleCount: batch.totals.proxyTriangleCount,
  });
}

function levelSummaries(proxies: readonly HlodPackageProxyRecord[]): readonly HlodPackageLevelSummary[] {
  const byLevel = new Map<number, HlodPackageLevelSummary>();
  for (const proxy of proxies) {
    const current = byLevel.get(proxy.level) ?? {
      level: proxy.level, proxyCount: 0, proxyTriangleCount: 0, coveredInstances: 0,
    };
    byLevel.set(proxy.level, {
      level: proxy.level,
      proxyCount: current.proxyCount + 1,
      proxyTriangleCount: current.proxyTriangleCount + proxy.triangleCount,
      coveredInstances: current.coveredInstances + proxy.instanceCount,
    });
  }
  return [...byLevel.values()].sort((left, right) => left.level - right.level);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
