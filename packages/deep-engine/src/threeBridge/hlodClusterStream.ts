/**
 * B4 簇级 HLOD 的后端驻留感知决策层(纯 CPU,可单测)。
 *
 * 与既有层的分工(不重复建设):
 * - `apps/web/delivery/webHlodPackage.decideWebHlodDraws` 是单模型绑定helper;本模块是
 *   后端决策引擎——消费逐放置绑定(manifest 树在**资产源空间**,共享资产多放置各有
 *   `decisionFromWorld` 逆变换),把渲染局部相机换算进决策空间后跑同一份
 *   `decideHlodFrame`(deep-engine hlod,决策合同单一定义不重写)。
 * - 决策输出 `HlodClusterFramePlan`(隐藏实例集 + 活动代理绘制),由
 *   `authorChunkStream` 做**驻留感知应用**:全隐藏块按阴影降级/省略(可逐出),
 *   混合块走批数据行置零补偿(身份不变,批修订合同不破坏),代理走 overlay 块
 *   (按需 registerChunk,此后经 demand 可见性切换,不做每帧重编目)。
 *
 * 强制原件驻留:选择/剖切/测量经 `collectDeepOverlayPrimitives` 全部进
 * `view.editorOverlay`;顶点非空即抑制折叠(盒代理是保守近似,不参与测量真值,
 * 隐藏原件也无法被 GPU 拾取)。宿主可再经 `hlodCollapseSuppressed` 叠加。
 *
 * 非流送路径(authorChunks 关闭):`applyHlodPlanToInstances` 以 1e-6 缩放变换
 * 隐藏实例行(packTransform 拒绝奇异矩阵,缩放是合法仿射;1e-6 缩放在几何上
 * 不可见),代理几何必须随发布包全量入包,否则后续激活时资源已不在驻留闭包。
 */

import { decideHlodFrame, hlodTreeFromManifest, HLOD_PROXY_GEOMETRY_PREFIX,
  type ClusterLodCamera, type HlodClusterTree, type HlodPackageManifest } from "../hlod/index.js";
import { resolvePbrCameraProjection } from "../webgpu/pbrFrameUniforms.js";
import type { RenderView } from "../webgpu/pbrRendererTypes.js";
import type { GeometryResource, RenderInstance, RenderPacket } from "../renderPacket.js";

/** 簇代理 overlay 批专用的合成材质 id;编译层(opt-in hlodPackages)负责随包分发。 */
export const HLOD_PROXY_MATERIAL_ID = "hlod-proxy-cluster";
/** 非流送路径隐藏实例的缩放因子:合法仿射(packTransform 允许)且几何不可见。 */
export const HLOD_HIDDEN_INSTANCE_SCALE = 1e-6;

/** 单个折叠簇在某放置下的代理绘制;transform 为作者世界 4x4 列主序。 */
export interface HlodClusterProxyDraw {
  readonly instanceId: string;
  readonly geometryId: string;
  readonly transform: readonly number[];
}

/** 逐放置(模型实例)簇绑定;manifest 树与代理几何在资产源空间。 */
export interface HlodClusterStreamBinding {
  readonly manifest: HlodPackageManifest;
  /** 资产节点 apiId → 该放置的场景实例 id(manifest 叶全集,缺一即决策失败)。 */
  readonly instanceIdsByNode: ReadonlyMap<string, readonly string[]>;
  /** 资产节点 apiId → 该放置的代理绘制(每折叠节点一份)。 */
  readonly proxyDrawsByNode: ReadonlyMap<string, readonly HlodClusterProxyDraw[]>;
  /** 作者世界 → 决策空间(资产源空间)的仿射逆(16 列主序);构造时校验。 */
  readonly decisionFromWorld: readonly number[];
}

/** 一帧簇决策计划;变换已按渲染局部原点平移局部化。 */
export interface HlodClusterFramePlan {
  readonly origin: readonly [number, number, number];
  readonly hiddenInstanceIds: ReadonlySet<string>;
  /** instanceId → 已局部化的代理绘制。 */
  readonly activeProxyDraws: ReadonlyMap<string, HlodClusterProxyDraw>;
  readonly collapsedNodeCount: number;
  readonly suppressed: boolean;
}

/** 代理 overlay 块的资源来源:原始包中按前缀筛出的代理几何与材质表。 */
export interface HlodClusterStreamResources {
  readonly geometries: ReadonlyMap<string, GeometryResource>;
  readonly materials: RenderPacket["materials"];
}

/** 编辑辅助(选择/剖切/测量/gizmo)顶点非空 → 强制原件驻留(关闭折叠)。 */
export function collapseSuppressedByOverlay(view: RenderView): boolean {
  const overlay = view.editorOverlay;
  return overlay !== undefined && overlay.vertices.length > 0;
}

/** 列主序仿射(16)校验;失败 fail-closed。 */
function validateAffine(matrix: readonly number[], label: string): void {
  if (!Array.isArray(matrix) && !(matrix instanceof Array)) {
    throw new TypeError(`${label} must be an array.`);
  }
  if (matrix.length !== 16 || matrix.some(value => !Number.isFinite(value))
    || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
    throw new TypeError(`${label} must be a finite column-major affine 4x4.`);
  }
}

/** 点变换(含平移);输入输出均为列主序仿射约定下的世界坐标。 */
export function applyAffinePoint(matrix: readonly number[],
  point: readonly [number, number, number]): [number, number, number] {
  return [
    matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!,
    matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!,
    matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!,
  ];
}

/** 方向变换(仅线性部分);调用方负责归一。 */
export function applyAffineDirection(matrix: readonly number[],
  direction: readonly [number, number, number]): [number, number, number] {
  return [
    matrix[0]! * direction[0] + matrix[4]! * direction[1] + matrix[8]! * direction[2],
    matrix[1]! * direction[0] + matrix[5]! * direction[1] + matrix[9]! * direction[2],
    matrix[2]! * direction[0] + matrix[6]! * direction[1] + matrix[10]! * direction[2],
  ];
}

function normalize3(value: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > 1e-12)) throw new Error("HLOD cluster decision camera forward is degenerate.");
  return [value[0] / length, value[1] / length, value[2] / length];
}

/**
 * 隐藏实例的缩放变换:线性部分 × factor,平移保留;校验仿射与有限。
 * packTransform 拒绝奇异矩阵,缩放是该约束下唯一的"合法不可见"表达。
 */
export function shrinkTransform(transform: ArrayLike<number>, factor: number, label: string): number[] {
  const values = Array.from(transform);
  validateAffine(values, label);
  return [...values.slice(0, 11).map(value => value * factor), values[11]!, ...values.slice(12)];
}

/** 每帧计划签名:抑制态/隐藏集规模/活动代理集决定是否需要重打包。 */
export function hlodPlanSignature(plan: HlodClusterFramePlan): string {
  return `${plan.suppressed ? "s" : "o"}:${plan.hiddenInstanceIds.size}:${[...plan.activeProxyDraws.keys()].sort().join(",")}`;
}

/** 后端簇决策引擎:持有逐放置绑定与迟滞状态;decide 纯输入输出(相机 + 原点)。 */
export class HlodClusterDecisionEngine {
  private readonly entries: readonly {
    readonly binding: HlodClusterStreamBinding;
    readonly tree: HlodClusterTree;
    previousCollapsed: Set<string>;
  }[];
  private readonly hostSuppressed: (() => boolean) | undefined;

  constructor(bindings: readonly HlodClusterStreamBinding[], hostSuppressed?: () => boolean) {
    if (!Array.isArray(bindings)) throw new TypeError("HLOD cluster bindings must be an array.");
    if (hostSuppressed !== undefined && typeof hostSuppressed !== "function") {
      throw new TypeError("hlodCollapseSuppressed must be a function.");
    }
    this.hostSuppressed = hostSuppressed;
    this.entries = bindings.map(binding => {
      if (!binding || typeof binding !== "object") throw new TypeError("HLOD cluster binding must be an object.");
      validateAffine(binding.decisionFromWorld, "HLOD decisionFromWorld");
      if (binding.manifest.decision.targetPixelError <= 0) {
        throw new TypeError("HLOD manifest decision targetPixelError must be positive.");
      }
      return { binding, tree: hlodTreeFromManifest(binding.manifest), previousCollapsed: new Set<string>() };
    });
  }

  get bindingCount(): number { return this.entries.length; }

  /** 计算一帧计划;view 为渲染局部视图,origin 为其局部化原点。 */
  decide(view: RenderView, origin: readonly [number, number, number]): HlodClusterFramePlan {
    const projection = resolvePbrCameraProjection(view);
    const viewportHeightPixels = view.height * view.pixelRatio;
    const tanHalfFovY = Math.tan(projection.verticalFovRadians / 2);
    const eyeWorld: [number, number, number] = [view.eye[0]! + origin[0], view.eye[1]! + origin[1], view.eye[2]! + origin[2]];
    const targetWorld: [number, number, number] = [view.target[0]! + origin[0], view.target[1]! + origin[1], view.target[2]! + origin[2]];
    const forwardWorld = normalize3([targetWorld[0] - eyeWorld[0], targetWorld[1] - eyeWorld[1], targetWorld[2] - eyeWorld[2]]);
    const hidden = new Set<string>();
    const activeProxyDraws = new Map<string, HlodClusterProxyDraw>();
    let collapsedNodes = 0;
    const suppressed = collapseSuppressedByOverlay(view) || this.hostSuppressed?.() === true;
    for (const entry of this.entries) {
      if (suppressed) { entry.previousCollapsed.clear(); continue; }
      const decision = decideHlodFrame(entry.tree, clusterCamera(eyeWorld, forwardWorld,
        entry.binding.decisionFromWorld, viewportHeightPixels, tanHalfFovY,
        entry.binding.manifest.decision.targetPixelError), entry.binding.manifest.decision, entry.previousCollapsed);
      entry.previousCollapsed = new Set(decision.collapsedNodes.map(node => node.nodeId));
      collapsedNodes += decision.collapsedNodes.length;
      for (const node of decision.collapsedNodes) {
        // 折叠节点是内节点:成员 = 树节点记录的叶 apiId 全集,再经绑定映射展开为场景实例。
        const members = entry.tree.nodes.get(node.nodeId)?.instanceIds;
        if (!members?.length) throw new Error(`HLOD collapsed node ${node.nodeId} has no tree members.`);
        for (const apiId of members) {
          const ids = entry.binding.instanceIdsByNode.get(apiId);
          if (!ids?.length) throw new Error(`HLOD collapsed node ${node.nodeId} member ${apiId} has no Web instance mapping.`);
          for (const id of ids) hidden.add(id);
        }
        const draws = entry.binding.proxyDrawsByNode.get(node.nodeId);
        if (!draws?.length) throw new Error(`HLOD collapsed node ${node.nodeId} has no proxy draws.`);
        for (const draw of draws) {
          if (activeProxyDraws.has(draw.instanceId)) throw new Error(`Duplicate HLOD proxy instance id: ${draw.instanceId}.`);
          activeProxyDraws.set(draw.instanceId, localizeDraw(draw, origin));
        }
      }
    }
    return { origin, hiddenInstanceIds: hidden, activeProxyDraws, collapsedNodeCount: collapsedNodes, suppressed };
  }

  /** 全量代理绘制(已局部化):非流送路径发布时引用全部代理几何,防止后续激活缺资源。 */
  allProxyDraws(origin: readonly [number, number, number]): ReadonlyMap<string, HlodClusterProxyDraw> {
    const draws = new Map<string, HlodClusterProxyDraw>();
    for (const entry of this.entries) {
      for (const list of entry.binding.proxyDrawsByNode.values()) {
        for (const draw of list) {
          if (draws.has(draw.instanceId)) throw new Error(`Duplicate HLOD proxy instance id: ${draw.instanceId}.`);
          draws.set(draw.instanceId, localizeDraw(draw, origin));
        }
      }
    }
    return draws;
  }
}

function clusterCamera(eyeWorld: readonly [number, number, number], forwardWorld: readonly [number, number, number],
  decisionFromWorld: readonly number[], viewportHeightPixels: number, tanHalfFovY: number,
  pixelThreshold: number): ClusterLodCamera {
  return { position: applyAffinePoint(decisionFromWorld, eyeWorld),
    forward: normalize3(applyAffineDirection(decisionFromWorld, forwardWorld)),
    viewportHeightPixels, tanHalfFovY, pixelThreshold };
}

function localizeDraw(draw: HlodClusterProxyDraw,
  origin: readonly [number, number, number]): HlodClusterProxyDraw {
  const transform = [...draw.transform];
  if (transform.length !== 16) throw new Error(`HLOD proxy draw ${draw.instanceId} transform must be 4x4.`);
  transform[12] = Math.fround(transform[12]! - origin[0]);
  transform[13] = Math.fround(transform[13]! - origin[1]);
  transform[14] = Math.fround(transform[14]! - origin[2]);
  return { instanceId: draw.instanceId, geometryId: draw.geometryId, transform };
}

/**
 * 非流送路径的实例重排:隐藏原件缩放到不可见,追加全部代理绘制
 * (活动 = 真实变换,非活动 = 缩放隐藏)。实例数恒定,批几何引用恒完整。
 */
export function applyHlodPlanToInstances(instances: readonly RenderInstance[], plan: HlodClusterFramePlan,
  allDraws: ReadonlyMap<string, HlodClusterProxyDraw>,
  proxyMaterialId: string = HLOD_PROXY_MATERIAL_ID): RenderInstance[] {
  const output: RenderInstance[] = instances.map(instance => plan.hiddenInstanceIds.has(instance.id)
    ? { ...instance, transform: shrinkTransform(instance.transform, HLOD_HIDDEN_INSTANCE_SCALE, `instance ${instance.id}`) }
    : instance);
  for (const draw of allDraws.values()) {
    const active = plan.activeProxyDraws.has(draw.instanceId);
    output.push({ id: draw.instanceId, geometry: draw.geometryId, material: proxyMaterialId,
      transform: active ? [...draw.transform] : shrinkTransform(draw.transform, HLOD_HIDDEN_INSTANCE_SCALE, `proxy ${draw.instanceId}`) });
  }
  return output;
}

/** 从原始渲染包提取代理 overlay 资源(几何按 HLOD 前缀,材质按合成 id)。 */
export function hlodClusterStreamResources(packet: RenderPacket): HlodClusterStreamResources {
  const geometries = new Map<string, GeometryResource>();
  for (const geometry of packet.geometries) {
    if (geometry.id.startsWith(HLOD_PROXY_GEOMETRY_PREFIX)) geometries.set(geometry.id, geometry);
  }
  return { geometries, materials: packet.materials };
}
