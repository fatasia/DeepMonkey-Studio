/**
 * F2/驻留感知 HLOD 冻结场景对照 —— 共享常量与载荷类型(叶子模块,零 import)。
 * Node 侧载荷构建(scripts/f2HlodCullPayload.ts)与浏览器 probe(scripts/f2HlodCullGpuProbe.ts)
 * 共同消费;本文件必须保持无依赖,否则浏览器 bundle 会拖入 node:fs 链。
 */

export const F2_TIER = 10_000;
export const F2_CAMERAS = [["近 0.25×", 0.25], ["巡航 1×", 1], ["远 4×", 4], ["航拍 64×", 64]] as const;
/** 成员实例共享的单位盒几何键(浏览器几何表键,非生产 RenderPacket id)。 */
export const F2_MEMBER_GEOMETRY_KEY = "__member-unit-box__";
/** 折叠态代理实例的材质 id(生产 threeBridge overlay 合同值)。 */
export const F2_MATERIAL_ID = "hlod-proxy-cluster";
export const F2_VIEWPORT_WIDTH = 960;
export const F2_VIEWPORT_HEIGHT = 540;

export interface F2CameraPayload {
  readonly label: string;
  readonly eye: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly tanHalfFovY: number;
  readonly near: number;
  readonly far: number;
  /** 折叠成员实例下标(u32 升序,base64)。 */
  readonly hiddenIndicesB64: string;
  /** 活动代理在 proxyList 里的序号(u32 升序,base64)。 */
  readonly activeProxyOrdinalsB64: string;
  readonly collapsedNodeCount: number;
  readonly activeProxies: number;
  readonly hiddenInstances: number;
  /** T26 复核(与 batchBench 同口径的生产 hlodProxyDrawCost 账目,计划层)。 */
  readonly t26: { readonly perProxyDraws: number; readonly batchedDraws: number;
    readonly drawReduction: number; readonly proxyGeometryBytes: number };
}

export interface F2ProxyEntry {
  readonly drawId: string;
  readonly geometryId: string;
  readonly level: number;
  readonly memberCount: number;
  /** 代理网格顶点(stride-6 位置+法线,世界空间,base64 f32)。 */
  readonly verticesB64: string;
  /** base64 u32。 */
  readonly indicesB64: string;
}

export interface F2Payload {
  readonly schema: "f2-hlod-cull-payload-v1";
  readonly note: string;
  readonly ids: readonly string[];
  /** 成员实例盒变换 = M_box(16 f32 × N,base64;M_box 把单位盒映到真实 GLB 节点世界 AABB)。 */
  readonly memberTransformsB64: string;
  /** 成员真实 GLB 源三角形表(u32 × N,base64;证据口径,不进渲染)。 */
  readonly trianglesB64: string;
  readonly unitGeometry: { readonly verticesB64: string; readonly indicesB64: string };
  /** drawId 升序(= 生产 allProxyDraws 的确定性遍历序)。 */
  readonly proxyList: readonly F2ProxyEntry[];
  readonly cameras: readonly F2CameraPayload[];
  readonly sceneSphere: { readonly center: readonly [number, number, number]; readonly extent: number };
  readonly sourceTriangles: number;
}

export interface F2CameraOutcome {
  readonly label: string;
  readonly instancesA: number;
  readonly instancesB: number;
  readonly degenerateB: number;
  readonly hiddenSet: number;
  readonly activeProxies: number;
  readonly aCovered: number;
  readonly bCovered: number;
  readonly bothBackground: number;
  /** A 覆盖且 B 空(原始,含边缘抖动)。 */
  readonly missRaw: number;
  /** missRaw 中 B 膨胀 1px 后仍空(真缺);门限 0。 */
  readonly missTrue: number;
  /** B 覆盖且 A 空(代理超悬/合并盒外扩)。 */
  readonly overhang: number;
  readonly agreePixels: number;
  /** 双覆盖且双方都是成员且同 id(未折叠区逐位一致)。 */
  readonly memberAgreePixels: number;
  /** 双覆盖中 B 为代理、A 为成员(成员表面被代理替代 = 代理误差像素,显式计量)。 */
  readonly proxyReplacedPixels: number;
  /** 双覆盖中双方都是代理且不同 id。 */
  readonly proxyDifferentPixels: number;
  /** 双覆盖中双方都是成员但 id 不同(A 的近层隐藏成员在 B 缩放后露出更远成员)。 */
  readonly memberSwapPixels: number;
  /** B 携带本相机隐藏集成员 id 的像素;门限 0。 */
  readonly hiddenViolationPixels: number;
  readonly idShaA: string;
  readonly idShaB: string;
}

export interface F2HiZLevelOutcome {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly maxAbsDiff: number;
  readonly bitwise: boolean;
}

export interface F2HiZOutcome {
  readonly label: string;
  readonly pyramidMipLevelCount: number;
  readonly reduction: string;
  readonly levels: readonly F2HiZLevelOutcome[];
  readonly gpuMip0MatchesDepthReadback: boolean;
}

export interface F2ProbeResult {
  readonly adapter: unknown;
  readonly browserVersion: string;
  readonly userAgent: string;
  readonly deviceErrors: readonly string[];
  readonly cameras: readonly F2CameraOutcome[];
  readonly hiZ: F2HiZOutcome;
  readonly draws: { readonly stateA: number; readonly stateB: number; readonly note: string };
}
