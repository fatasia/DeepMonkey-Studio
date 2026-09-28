import type { GeometryResource } from "@bim-studio/deep-engine";
import type { HlodCell, HlodClusterStats } from "@bim-studio/deep-engine/hlod";

/**
 * T26 renderPacket 接线切片:GLB/渲染包场景 → 聚合树 → 按层级档预生成簇代理 →
 * 渲染包几何 + HLOD manifest 字段。决策在客户端运行时(`decideHlodFrame`,
 * deep-engine hlod),代理数据在包侧预生成(本模块);输出布局与
 * `packetBoundsHlod` 盒代理消费端同约定(stride-6 顶点 + Uint32 索引,
 * 每盒 24 顶点/36 索引),几何数组**零转换**直接投 `RenderPacket.geometries`。
 *
 * 纪律:确定性(同输入逐位同包)、fail-closed 校验、内容寻址 geometryId
 * (id 变 = 内容变 ⇒ 包 diff 退化为 id 集合差,revision 恒 0 不虚增版本)。
 */

export const HLOD_PACKAGE_SCHEMA = "deep-api.hlod-package" as const;
export const HLOD_PACKAGE_VERSION = 1 as const;
/** 代理几何 id 前缀(deep-engine hlodProxyBatch 铸造);进渲染包前必须做碰撞守卫。 */
export const HLOD_PROXY_GEOMETRY_PREFIX = "hlod-proxy-";

/** 核心输入实例:同一来源数据的两种形态(与 deep-engine 车间夹具同源不同形约定)。 */
export interface HlodPackageInstanceInput {
  /** 场景内全局唯一(重复 fail-closed)。 */
  readonly instanceId: string;
  /** 聚合树/决策输入:世界包围球(中心 + 半径,radius ≥ 0)。 */
  readonly sphereCenter: readonly [number, number, number];
  readonly sphereRadius: number;
  /** 代理几何摘要输入:世界 AABB(min ≤ max,逐分量有限)。 */
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** 源网格三角形数(真实值,来自 accessor/索引;≥ 0 安全整数)。 */
  readonly triangles: number;
}

export interface HlodPackageBuildOptions {
  /** 透传 deep-engine 聚合树选项(终端聚合扇出/深度保险)。 */
  readonly maxChildren?: number;
  readonly maxDepth?: number;
  /** 透传代理预算(硬约束,12 的倍数生效)。 */
  readonly maxProxyTriangles?: number;
  /** 记录进 manifest 的决策合同(客户端据此跑 decideHlodFrame)。 */
  readonly targetPixelError?: number;
  readonly hysteresisRatio?: number;
  /** 参考机位档(场景包围球半径的倍数,近→远);空数组跳过参考档证据。 */
  readonly referenceTierScales?: readonly number[];
}

/** manifest 节点记录(id 升序;树的全量可序列化投影,客户端据此重建决策树)。 */
export interface HlodPackageNodeRecord {
  readonly id: string;
  readonly level: number;
  readonly parent: string | null;
  readonly children: readonly string[];
  readonly instanceIds: readonly string[];
  readonly instanceCount: number;
  readonly center: readonly [number, number, number];
  readonly radius: number;
  readonly cell: HlodCell;
}

/** manifest 代理记录(nodeId 升序;nodeId → geometryId 的决策映射表)。 */
export interface HlodPackageProxyRecord {
  readonly nodeId: string;
  readonly level: number;
  readonly geometryId: string;
  readonly instanceCount: number;
  readonly boxCount: number;
  readonly triangleCount: number;
}

/** 档 = 树层级:每层预生成代理的汇总(全部内节点,决策完备)。 */
export interface HlodPackageLevelSummary {
  readonly level: number;
  readonly proxyCount: number;
  readonly proxyTriangleCount: number;
  readonly coveredInstances: number;
}

/** 参考机位档证据(canonical 相机约定,见 hlodPackageSource.hlodReferenceCamera)。 */
export interface HlodPackageTierEvidence {
  readonly scale: number;
  readonly collapsedNodes: number;
  readonly coveredInstances: number;
  readonly proxyTriangleCount: number;
}

/** 渲染包 manifest 的 HLOD 字段(JSON 可序列化;几何二进制走包 blob/渲染包几何表)。 */
export interface HlodPackageManifest {
  readonly schema: typeof HLOD_PACKAGE_SCHEMA;
  readonly version: typeof HLOD_PACKAGE_VERSION;
  readonly clusterAlgorithmVersion: string;
  readonly proxyAlgorithmVersion: string;
  readonly decision: { readonly targetPixelError: number; readonly hysteresisRatio: number };
  readonly clusterOptions: { readonly maxChildren: number; readonly maxDepth: number };
  readonly proxyTriangleBudget: number;
  readonly rootCell: HlodCell;
  readonly rootId: string | null;
  readonly stats: HlodClusterStats;
  /** id 升序。 */
  readonly nodes: readonly HlodPackageNodeRecord[];
  /** level 升序。 */
  readonly levels: readonly HlodPackageLevelSummary[];
  /** nodeId 升序。 */
  readonly proxies: readonly HlodPackageProxyRecord[];
  /** scale 升序(调用方给的序不重排,构建时排序)。 */
  readonly tiers: readonly HlodPackageTierEvidence[];
  readonly sceneSphere: { readonly center: readonly [number, number, number]; readonly extent: number };
  readonly instanceCount: number;
  readonly sourceTriangleCount: number;
  readonly proxyTriangleCount: number;
}

/** 构建产物:manifest(JSON 面)+ 代理几何(二进制面,零转换投渲染包)。 */
export interface HlodPackageBuildResult {
  readonly manifest: HlodPackageManifest;
  /** manifest.proxies 同序(nodeId 升序);vertices/indices 与代理网格**同一引用**(零转换)。 */
  readonly geometries: readonly GeometryResource[];
}

/** 包级 diff(内容寻址 id ⇒ 差异 = id 集合差;字节一致性由测试对 unchanged 断言)。 */
export interface HlodPackageDiff {
  readonly previousProxyCount: number;
  readonly nextProxyCount: number;
  readonly unchangedProxyCount: number;
  readonly addedGeometryIds: readonly string[];
  readonly removedGeometryIds: readonly string[];
  /** 根胞元重定(实例逃出 2 的幂边界)→ 全树重建,属诚实降级路径而非 diff 缺陷。 */
  readonly rootCellShifted: boolean;
}
