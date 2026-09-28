/**
 * G1-S2 作者链路 staging 构建器（opt-in，`g1-cluster-lod=1`）。
 *
 * 把作者 RenderPacket 的静态实例几何合并成单份 bake 输入（簇级 LOD 是"单 bake
 * 单几何"合同：clusterLodBake 的 ClusterLodBakeInput 只收一份顶点/索引），经注入的
 * bake 能力产出 ClusterLodSceneStaging，由 DeepWebGpuBackend 在静态包发布成功后
 * 注入渲染器槽位（stageClusterLodScene）。
 *
 * fail-closed（绝不静默截断）：
 * - 包级 deformation → 整包拒绝（`deformation-packet`）：变形后的 GPU 顶点与静态
 *   bake 顶点不符，G1 边界"slot 不接收变形"由本构建器与接线方共同保证。
 * - 带 pose 实例 → 跳过该实例并计数（结果 `skippedDeformedInstances`）。
 * - 顶点预算超限 → 显式失败（`vertex-budget-exceeded`，带数值），不产出部分几何。
 * - 零可合并实例 → undefined。
 * - bake 自身抛错（三角超 RAY_BACKEND_LIMITS 等）→ 原样透传，不吞。
 *
 * 变换语义与 `applyAffinePoint`（three-bridge 公共导出）逐字一致：4x4 列主序，
 * 平移在 m[12..14]；顶点写入 Float32Array 时的 fround 与 camera-relative
 * localize 的精度口径一致。几何顶点 stride=6（位置 xyz + 法线 xyz，合同见
 * GeometryResource），合并只取位置（槽位管线 pos-only）。
 */

import type { RenderPacket } from "@bim-studio/deep-engine";
import type { ClusterLodSceneStaging } from "@bim-studio/deep-engine/webgpu";

/** 与 deep-engine `ClusterLodBakeInput` 结构一致（该符号无公共导出，见 G1-S2 报告）。 */
export interface ClusterLodAuthorBakeInput {
  readonly geometryId: string;
  readonly vertices: Float32Array;
  readonly indices: Uint32Array;
  readonly level0ClusterSize: number;
  readonly levelCount?: number;
}

/** 与 deep-engine `ClusterLodBakeResult` 结构一致。 */
export interface ClusterLodAuthorBakeResult {
  readonly dag: ClusterLodSceneStaging["dag"];
  readonly levelGeometry: ReadonlyArray<{ readonly vertices: Float32Array; readonly indices: Uint32Array }>;
}

export type ClusterLodAuthorBakeFn = (input: ClusterLodAuthorBakeInput) => ClusterLodAuthorBakeResult;

export interface ClusterLodAuthorStagingOptions {
  /** bake 能力注入点：宿主经 `DeepWebGpuBackend.bakeClusterLodAuthorGeometry` 提供。 */
  readonly bake: ClusterLodAuthorBakeFn;
  /** level0 meshlet 页大小；缺省 128（G1-S1 夹具同值，合同 [1,128]）。 */
  readonly level0ClusterSize?: number;
  /** 层数（含 level0）；缺省走 bake 合同（3）。 */
  readonly levelCount?: number;
  /** 合并展开后的顶点数上限；超限显式失败。缺省 4_000_000（bake 三角上限 4_194_304 同量级）。 */
  readonly maxVertices?: number;
  /** 选层像素阈值透传；缺省走槽位合同（1px）。 */
  readonly pixelThreshold?: number;
}

export type ClusterLodAuthorStagingFailure =
  | { readonly reason: "deformation-packet"; readonly detail: string }
  | { readonly reason: "vertex-budget-exceeded"; readonly detail: string };

export interface ClusterLodAuthorStagingValue {
  readonly staging: ClusterLodSceneStaging;
  /** 跳过的带 pose 实例数（G1 边界：slot 不接收变形）。 */
  readonly skippedDeformedInstances: number;
  readonly mergedInstances: number;
  readonly mergedVertices: number;
  readonly mergedTriangles: number;
}

/** 判别式结果：undefined = 零可合并实例；ok:false = fail-closed 显式原因。 */
export type ClusterLodAuthorStagingOutcome =
  | { readonly ok: true; readonly value: ClusterLodAuthorStagingValue }
  | { readonly ok: false; readonly failure: ClusterLodAuthorStagingFailure };

const DEFAULT_MAX_VERTICES = 4_000_000;
const DEFAULT_LEVEL0_CLUSTER_SIZE = 128;

export function buildClusterLodAuthorStaging(packet: RenderPacket,
  options: ClusterLodAuthorStagingOptions): ClusterLodAuthorStagingOutcome | undefined {
  if (typeof options?.bake !== "function") throw new TypeError("Cluster LOD author staging requires a bake function.");
  const maxVertices = options.maxVertices ?? DEFAULT_MAX_VERTICES;
  if (!Number.isSafeInteger(maxVertices) || maxVertices < 1) throw new RangeError("maxVertices must be a positive integer.");
  if (packet.deformation !== undefined) {
    return { ok: false, failure: { reason: "deformation-packet",
      detail: "Cluster LOD staging rejects deformation packets (G1 static-scene boundary)." } };
  }
  const geometries = new Map(packet.geometries.map(geometry => [geometry.id, geometry]));
  const mergedVertices: number[] = [];
  const mergedIndices: number[] = [];
  let skippedDeformedInstances = 0, mergedInstances = 0, vertexOffset = 0;
  for (const instance of packet.instances) {
    if (instance.pose !== undefined) { skippedDeformedInstances += 1; continue; }
    if (instance.transform.length !== 16) {
      throw new TypeError(`Cluster LOD author staging requires a 4x4 transform (instance ${instance.id}).`);
    }
    const geometry = geometries.get(instance.geometry);
    if (!geometry) throw new TypeError(`Cluster LOD author staging cannot resolve geometry ${instance.geometry}.`);
    const vertexCount = geometry.vertices.length / 6;
    if (vertexOffset + vertexCount > maxVertices) {
      return { ok: false, failure: { reason: "vertex-budget-exceeded",
        detail: `Merging instance ${instance.id} would exceed the vertex budget (${vertexOffset + vertexCount} > ${maxVertices}).` } };
    }
    const m = instance.transform;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const base = vertex * 6;
      const x = geometry.vertices[base]!, y = geometry.vertices[base + 1]!, z = geometry.vertices[base + 2]!;
      // 与 applyAffinePoint 逐字一致的内联展开（避免逐顶点临时数组）。
      mergedVertices.push(
        m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
        m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
        m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
      );
    }
    for (let index = 0; index < geometry.indices.length; index++) mergedIndices.push(geometry.indices[index]! + vertexOffset);
    vertexOffset += vertexCount;
    mergedInstances += 1;
  }
  if (mergedInstances === 0) return undefined;
  const baked = options.bake({ geometryId: "g1-author-cluster-lod",
    vertices: Float32Array.from(mergedVertices), indices: Uint32Array.from(mergedIndices),
    level0ClusterSize: options.level0ClusterSize ?? DEFAULT_LEVEL0_CLUSTER_SIZE,
    ...(options.levelCount === undefined ? {} : { levelCount: options.levelCount }) });
  return { ok: true, value: { staging: { dag: baked.dag, levelGeometry: baked.levelGeometry,
      ...(options.pixelThreshold === undefined ? {} : { pixelThreshold: options.pixelThreshold }) },
    skippedDeformedInstances, mergedInstances, mergedVertices: vertexOffset,
    mergedTriangles: mergedIndices.length / 3 } };
}

/**
 * 宿主侧便捷封装：从 three-bridge 模块取公共 bake 入口（`DeepWebGpuBackend` 是
 * three-bridge 既有公共导出；bake 能力经其静态代理暴露，rayTracing 一字未动）。
 */
export function clusterLodAuthorBakeFromModule(backendModule:
  typeof import("@bim-studio/deep-engine/three-bridge")): ClusterLodAuthorBakeFn {
  return input => backendModule.DeepWebGpuBackend.bakeClusterLodAuthorGeometry(input);
}
