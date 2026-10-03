import type { MeshletDag } from "./geometry/meshletDag.js";
import { MESHLET_BOUNDS_STRIDE, MESHLET_DESCRIPTOR_STRIDE } from "./geometry/types.js";

/**
 * Nanite M3 —— DAG→页表编译:把 meshletDag 的层级簇切成调度页。
 *
 * 页 = 簇(Nanite 调度原子):每页携带层误差、包围球、字节成本与父子链接。
 * 页身份 `"<source>|l<level>|c<cluster>"` 确定性可复现(与 F3 virtualTexturePageId
 * 同风格),跨帧稳定,驻留表以此为键。层内几何布局与 expandMeshletIndices 展开序一致:
 * firstIndex = descriptors[cluster*4+2] * 3(层内全局索引缓冲),展开索引即层内全局
 * 顶点号,baseVertex 恒 0 —— 页是层缓冲内的段,上传/驻留按页计费(段字节)。
 * 非 DAG 资产不进入本编译器(继续走现有 packet/HLOD 通路,兼容层语义)。
 */

/** 簇级页:一次调度/上传/绘制的原子。 */
export interface VirtualGeometryDagPage {
  readonly id: string;
  readonly sourceGeometry: string;
  /** 0 = 最细(原始),越大越粗;与 MeshletDagLevel.level 同向。 */
  readonly level: number;
  readonly cluster: number;
  /** 层误差(顶点相对源位置的最大位移,世界单位)。 */
  readonly error: number;
  readonly triangleCount: number;
  /** 驻留计费:该簇 unique 顶点 position(12B/顶点)+ 展开索引(4B/索引)。 */
  readonly byteLength: number;
  /** 簇 bounds 球(世界系,[cx,cy,cz,r],与 meshletBounds 同源)。 */
  readonly sphere: readonly [number, number, number, number];
  /** 层内全局展开索引缓冲中的起始索引(descriptors.triangleOffset * 3)。 */
  readonly firstIndex: number;
  /** 粗一层父页 id;最粗层为 null(单父,parentsByLevel 语义)。 */
  readonly parentId: string | null;
  /** 细一层子页 id(升序)。 */
  readonly childIds: readonly string[];
}

export interface VirtualGeometryDagPageTable {
  readonly sourceGeometry: string;
  readonly revision: number;
  readonly levels: number;
  /** 全部页,按 level 升序(细→粗)、层内簇序排列。 */
  readonly pages: readonly VirtualGeometryDagPage[];
  readonly byId: ReadonlyMap<string, VirtualGeometryDagPage>;
  /** 最粗层页(调度遍历入口)。 */
  readonly rootIds: readonly string[];
  readonly totalTriangles: number;
  readonly totalBytes: number;
}

export function virtualGeometryDagPageId(sourceGeometry: string, level: number, cluster: number): string {
  return `${sourceGeometry}|l${level.toString(36)}|c${cluster.toString(36)}`;
}

/** MeshletDag → 调度页表。簇缺失(空层/空簇)fail-loud,静默空表会伪装成"无几何"。 */
export function compileVirtualGeometryDagPages(dag: MeshletDag, sourceGeometry: string,
  revision = 0): VirtualGeometryDagPageTable {
  if (!sourceGeometry) throw new Error("Virtual geometry DAG pages require a non-empty source geometry id.");
  if (dag.levels.length === 0) throw new Error("Virtual geometry DAG has no levels.");
  const levelOffsets = expandTriangleOffsets(dag);
  const childIdsByParent = new Map<string, string[]>();
  const pages: VirtualGeometryDagPage[] = [];
  const byId = new Map<string, VirtualGeometryDagPage>();

  for (let level = 0; level < dag.levels.length; level += 1) {
    const dagLevel = dag.levels[level]!;
    if (dagLevel.meshletCount === 0) throw new Error(`Virtual geometry DAG level ${level} has no clusters.`);
    for (let cluster = 0; cluster < dagLevel.meshletCount; cluster += 1) {
      const id = virtualGeometryDagPageId(sourceGeometry, level, cluster);
      const descriptor = cluster * MESHLET_DESCRIPTOR_STRIDE;
      const triangleCount = dagLevel.descriptors[descriptor + 3]!;
      if (triangleCount === 0) throw new Error(`Virtual geometry DAG page ${id} has no triangles.`);
      const vertexCount = dagLevel.descriptors[descriptor]!;
      const bounds = cluster * MESHLET_BOUNDS_STRIDE;
      const sphere = [dagLevel.bounds[bounds]!, dagLevel.bounds[bounds + 1]!, dagLevel.bounds[bounds + 2]!,
        dagLevel.bounds[bounds + 3]!] as const;
      if (!sphere.every(Number.isFinite) || sphere[3]! < 0) {
        throw new Error(`Virtual geometry DAG page ${id} has invalid bounds sphere.`);
      }
      // M2 实现的 parentsByLevel 实为"逐层 Uint32Array"数组(类型声明为单表,
      // 经 unknown 收窄到真实形状;漂移由 meshletDag.test 钉住)。
      const parentTable = dag.parentsByLevel as unknown as readonly (Uint32Array | undefined)[];
      const parentCluster = level + 1 < dag.levels.length ? parentTable[level]?.[cluster] : undefined;
      // M2 父哨兵:细簇三角形被粗层全局去重吞没时 parent=-1,经 Uint32 回绕为 4294967295。
      // 该簇在粗层无单射父 —— 页表按"孤儿根"处理(无祖先前缀要求,自身为调度种子;
      // 其区域几何由粗层旁路覆盖,细层保真靠本页,与 Nanite 无粗表示区域的语义一致)。
      // 其余越界父仍是结构损坏,fail-loud。
      const orphaned = parentCluster !== undefined && parentCluster >= dag.levels[level + 1]!.meshletCount;
      if (orphaned && parentCluster !== 4294967295) {
        throw new Error(`Virtual geometry DAG page ${id} has an out-of-range parent cluster.`);
      }
      const parentId = parentCluster === undefined || orphaned ? null
        : virtualGeometryDagPageId(sourceGeometry, level + 1, parentCluster);
      const page: VirtualGeometryDagPage = Object.freeze({
        id, sourceGeometry, level, cluster, error: dagLevel.error,
        triangleCount, byteLength: vertexCount * 12 + triangleCount * 3 * 4,
        sphere, firstIndex: levelOffsets[level]![cluster]! * 3, parentId, childIds: Object.freeze([]),
      });
      byId.set(id, page);
      pages.push(page);
      if (parentId) {
        const list = childIdsByParent.get(parentId);
        if (list) list.push(id); else childIdsByParent.set(parentId, [id]);
      }
    }
  }
  const withChildren = pages.map((page) => {
    const ids = childIdsByParent.get(page.id);
    return ids ? Object.freeze({ ...page, childIds: Object.freeze([...ids].sort()) }) : page;
  });
  const byIdFinal = new Map(withChildren.map((page) => [page.id, page]));
  return Object.freeze({
    sourceGeometry, revision, levels: dag.levels.length,
    pages: Object.freeze(withChildren), byId: byIdFinal,
    rootIds: Object.freeze(withChildren.filter((page) => page.parentId === null).map((page) => page.id)),
    totalTriangles: withChildren.reduce((sum, page) => page.level === 0 ? sum + page.triangleCount : sum, 0),
    totalBytes: withChildren.reduce((sum, page) => sum + page.byteLength, 0),
  });
}

/** 每层簇的索引偏移:descriptors[cluster*4+2] 本就是层内累计三角形偏移(buildMeshlets flush 语义),
 *  直接读取;再叠前缀和会双重计数(firstIndex 错位,实测踩坑)。firstIndex = 偏移×3。 */
function expandTriangleOffsets(dag: MeshletDag): readonly Uint32Array[] {
  const stride = MESHLET_DESCRIPTOR_STRIDE;
  return dag.levels.map((dagLevel) => {
    const offsets = new Uint32Array(dagLevel.meshletCount);
    for (let cluster = 0; cluster < dagLevel.meshletCount; cluster += 1) {
      offsets[cluster] = dagLevel.descriptors[cluster * stride + 2]!;
    }
    return offsets;
  });
}
