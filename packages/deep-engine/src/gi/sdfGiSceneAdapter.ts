/**
 * Brief-GI M2 场景适配:渲染包快照(batches + geometries)→ SDF 场景烘焙实例。
 *
 * 纯函数、确定性、无 GPU 依赖 —— 帧循环在场景 dirty 时用它把当前包翻译成
 * `bakeSdfSceneGrid` 的输入(单源烘焙,不另立场景描述)。
 *
 * == 入选/排除合同(逐条可对拍)==
 * - 排除变形批(pose !== undefined):动态资产不进静态遮蔽场(与 sdfSceneBake 的
 *   dynamic 排除同语义,报告逐条 dynamic-excluded);
 * - 排除 BLEND 批:半透明遮挡物(玻璃/容积效果)进闭体并集会造出假影;
 * - 其余批次全量入场(castShadow 不作为 GI 遮蔽判据 —— 不投影的静态体仍然挡天光);
 * - 几何:GeometryResource.vertices 是 xyz+法线 交错(stride 6 float),此处解交错出
 *   纯 xyz(烘焙只消费位置);indices 原样透传。
 * - 变换:批次 data 行 36 float/实例,packTransform 布局 = (列0 xyz, 列1 xyz,
 *   列2 xyz, 平移 xyz)(列主 3×4;sdfSceneBake 的 basis 是行主 3×3,此处转置)。
 */

import type { SdfSceneBakeInstance, SdfSceneTransform } from "./sdfSceneBake.js";
import type { CachedPacketBatch } from "../webgpu/packetBufferTypes.js";
import type { GeometryResource } from "../renderPacketTypes.js";

/** 单实例 packed 行步长(renderPacketBatches.packInstanceBatches 的 36 float 布局)。 */
export const SDF_GI_INSTANCE_ROW_FLOATS = 36;
/** packed 行内变换段:列0(0..2)、列1(3..5)、列2(6..8)、平移(9..11)。 */
export const SDF_GI_INSTANCE_TRANSFORM_FLOATS = 12;

export interface SdfGiPacketSnapshot {
  readonly batches: ReadonlyMap<string, CachedPacketBatch>;
  readonly geometries: ReadonlyMap<string, CachedPacketGeometrySource>;
}

/** 与 webgpu/packetBufferTypes.CachedPacketGeometry 的 CPU 半对齐(纯字段,测试可造)。 */
export interface CachedPacketGeometrySource {
  readonly source: GeometryResource;
}

/**
 * 包快照 → 烘焙实例。同输入逐位同输出;几何解交错每几何只做一次(Map 缓存)。
 * 空/不可烘焙输入返回空数组(调用方按「无可烘焙静态实例」跳过本帧烘焙)。
 */
export function sdfGiBakeInstancesFromPackets(snapshot: SdfGiPacketSnapshot):
  readonly SdfSceneBakeInstance[] {
  const positionsCache = new Map<string, Float32Array<ArrayBuffer>>();
  const instances: SdfSceneBakeInstance[] = [];
  for (const batch of snapshot.batches.values()) {
    const source = batch.source;
    // 动态(可变形)与半透明批次不进静态遮蔽场(合同见文件头)。
    if (source.pose !== undefined || source.alphaMode === "BLEND") continue;
    const geometry = snapshot.geometries.get(source.geometry)?.source;
    if (!geometry || geometry.indices.length < 3 || geometry.vertices.length < 9) continue;
    let positions = positionsCache.get(source.geometry);
    if (!positions) {
      positions = deinterleavePositions(geometry.vertices);
      positionsCache.set(source.geometry, positions);
    }
    const rows = source.count;
    const data = source.data;
    for (let slot = 0; slot < rows; slot++) {
      const offset = slot * SDF_GI_INSTANCE_ROW_FLOATS;
      instances.push({
        id: `${source.key}#${slot}`,
        mesh: { positions, indices: geometry.indices },
        transform: unpackTransformRow(data, offset),
      });
    }
  }
  return instances;
}

/** xyz+法线交错(stride 6)→ 纯 xyz 打包。 */
function deinterleavePositions(vertices: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const vertexCount = Math.floor(vertices.length / 6);
  const out = new Float32Array(vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    out[vertex * 3] = vertices[vertex * 6]!;
    out[vertex * 3 + 1] = vertices[vertex * 6 + 1]!;
    out[vertex * 3 + 2] = vertices[vertex * 6 + 2]!;
  }
  return out;
}

/** packed 行(列主 3×4)→ sdfSceneBake 行主 basis + 平移(转置语义,见文件头)。 */
export function unpackTransformRow(data: Float32Array<ArrayBuffer>, offset: number):
  SdfSceneTransform {
  const c0 = [data[offset]!, data[offset + 1]!, data[offset + 2]!];
  const c1 = [data[offset + 3]!, data[offset + 4]!, data[offset + 5]!];
  const c2 = [data[offset + 6]!, data[offset + 7]!, data[offset + 8]!];
  const t = [data[offset + 9]!, data[offset + 10]!, data[offset + 11]!] as const;
  // 行主 basis 行 i = (列向量们) 的第 i 分量:basis[i*3+j] = 列j 的第 i 分量。
  return {
    basis: [c0[0]!, c1[0]!, c2[0]!, c0[1]!, c1[1]!, c2[1]!, c0[2]!, c1[2]!, c2[2]!],
    translation: t,
  };
}

/** 实例 AABB 最大边长(烘焙 cellSize 缺省基准;sdfSceneBake 内部还会重推 bounds)。 */
export function instanceMaxExtent(instances: readonly SdfSceneBakeInstance[]): number {
  let max = 0;
  for (const instance of instances) {
    const positions = instance.mesh.positions;
    for (let axis = 0; axis < 3; axis++) {
      let min = Infinity, bound = -Infinity;
      for (let index = axis; index < positions.length; index += 3) {
        const value = positions[index]!;
        if (value < min) min = value;
        if (value > bound) bound = value;
      }
      if (Number.isFinite(min)) max = Math.max(max, bound - min);
    }
  }
  return max;
}

/**
 * 场景包围盒 → 探针 lattice(均匀格,内缩半格避免探针贴面;确定性:分辨率从细到粗
 * 首个满足预算的组合,同输入同输出)。上限默认 4096 探针(96B ABI 下 384KiB 记录存储)。
 */
export function deriveSdfGiProbeLattice(
  bounds: { readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number] },
  spacing: number, maxProbes = 4096): { positions: [number, number, number][];
    dimensions: [number, number, number]; spacing: number } {
  if (!Number.isFinite(spacing) || spacing <= 0) throw new RangeError("Probe spacing must be a positive finite number.");
  if (!Number.isSafeInteger(maxProbes) || maxProbes < 1) throw new RangeError("Probe budget must be a positive integer.");
  const extent = [0, 1, 2].map(axis => Math.max(bounds.max[axis]! - bounds.min[axis]!, 0));
  // 每轴至少 2 探针;预算不足时按几何均值放大 spacing(确定性倍增)。
  let resolved = spacing;
  for (let attempt = 0; attempt < 64; attempt++) {
    const dims = extent.map(axis => Math.max(2, Math.floor(axis / resolved) + 1));
    if (dims[0]! * dims[1]! * dims[2]! <= maxProbes) {
      const positions: [number, number, number][] = [];
      for (let z = 0; z < dims[2]!; z++) for (let y = 0; y < dims[1]!; y++) {
        for (let x = 0; x < dims[0]!; x++) {
          positions.push([
            bounds.min[0]! + Math.min(x * resolved, extent[0]!),
            bounds.min[1]! + Math.min(y * resolved, extent[1]!),
            bounds.min[2]! + Math.min(z * resolved, extent[2]!),
          ]);
        }
      }
      return { positions, dimensions: [dims[0]!, dims[1]!, dims[2]!], spacing: resolved };
    }
    resolved *= 2;
  }
  // 64 次倍增仍超预算 = 输入规模病态;fail-visible 而非静默截断。
  throw new RangeError(`Probe lattice exceeds ${maxProbes} probes even at maximal spacing.`);
}
