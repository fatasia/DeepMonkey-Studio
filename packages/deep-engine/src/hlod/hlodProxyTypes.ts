/**
 * T26 第二切片:簇级代理几何生成的公共合同(纯 CPU,零依赖,确定性)。
 *
 * 与既有底座的分工(不重复建设):
 * - `packetBoundsHlod.ts` 是逐实例远档包围盒代理;本模块把同样的盒代理思想
 *   **升级到簇级**:一个折叠簇 → 一份预算受控的低三角形代理网格。
 * - 输入 = 簇内实例的**几何摘要**(世界 AABB;代表网格/包围盒由调用方化简到此形态),
 *   输出 = 盒簇合并的低面代理(每盒 12 三角)。T12 meshoptimizer 简化链在 apps/api
 *   (跨包 + WASM 异步),不做本切片依赖;接线留联测清单。
 * - 确定性纪律同第一切片:同输入 + 同算法版本 → 逐位同网格;无随机、无时钟。
 */

/** 代理生成算法版本:进入网格与度量结果的确定性合同;行为变更必须升版本。 */
export const HLOD_PROXY_ALGORITHM_VERSION = "t26-hlod-proxy-v1";

/** 簇内实例几何摘要:世界空间 AABB(min ≤ max,逐分量有限)。id 全局唯一。 */
export interface HlodInstanceShape {
  readonly instanceId: string;
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface HlodProxyOptions {
  /**
   * 面数预算(硬约束):输出三角形数 ≤ 有效预算 = max(12, floor(该值/12)×12)。
   * 取值 [12, 24576];簇实例数 ≤ 盒预算时逐实例原样出盒,否则确定性贪心合并。
   */
  readonly maxProxyTriangles?: number;
  /** 误差度量的实例采样数上限(规范序 stride 选取)。 */
  readonly metricInstanceSampleLimit?: number;
  /** 误差度量的距离求值总预算(超限按比例收缩采样,保持确定性)。 */
  readonly metricEvalBudget?: number;
}

export interface HlodProxyConfiguration {
  readonly maxProxyTriangles: number;
  /** 有效盒预算 = 有效三角形预算 / 12。 */
  readonly proxyBoxBudget: number;
  readonly metricInstanceSampleLimit: number;
  readonly metricEvalBudget: number;
}

export const HLOD_PROXY_DEFAULTS = Object.freeze({
  maxProxyTriangles: 96,
  metricInstanceSampleLimit: 256,
  metricEvalBudget: 2_000_000,
});

/**
 * 代理网格数据:stride-6 交错顶点(位置 + 面法线),索引三角形。
 * 顶点布局与 `packetBoundsHlod` 的盒代理同约定(每盒 24 顶点/36 索引);
 * 缓冲为普通 ArrayBuffer 背书(非 SharedArrayBuffer),renderPacket 接线时
 * 作为 `GeometryResource.vertices/indices` 零转换直接消费(同引用)。
 */
export interface HlodProxyMesh {
  readonly vertices: Float32Array<ArrayBuffer>;
  readonly indices: Uint32Array<ArrayBuffer>;
  readonly triangleCount: number;
  readonly boxCount: number;
}

export interface HlodProxyBudgetEvidence {
  readonly maxProxyTriangles: number;
  readonly effectiveTriangleBudget: number;
  readonly inputShapeCount: number;
  /** true = 输入超预算,发生了确定性贪心合并;false = 逐实例原样出盒(零合并)。 */
  readonly merged: boolean;
}

/** 单簇代理生成结果(纯数据;几何 id 由批生成层铸造)。 */
export interface HlodProxyResult {
  readonly algorithmVersion: typeof HLOD_PROXY_ALGORITHM_VERSION;
  readonly mesh: HlodProxyMesh;
  readonly budget: HlodProxyBudgetEvidence;
}

/** Hausdorff 式近似度量(有界采样,报告级——不冒充视觉等价,不冒充严格界)。 */
export interface HlodProxyErrorMetrics {
  /** 实例盒表面采样 → 代理盒集的有向最大距离(0 = 全被代理覆盖)。 */
  readonly instanceToProxyMax: number;
  /** 参与度量的实例盒数(stride 选取后的实际值)。 */
  readonly instanceSampleCount: number;
  /** 代理盒表面采样 → 实例盒集的有向最大距离(代理填隙超出原始几何的程度)。 */
  readonly proxyToInstanceMax: number;
  /** 代理表面采样点总数 = 采样盒数 × 9(8 角 + 质心)。 */
  readonly proxySampleCount: number;
  /** Σ代理盒体积(盒可重叠 → 只作上界口径)。 */
  readonly proxyBoxVolume: number;
  /** Σ实例盒体积。 */
  readonly instanceBoxVolume: number;
  /** proxyBoxVolume / instanceBoxVolume(分母 0 → 双 0 记 0,否则 Infinity)。 */
  readonly volumeRatioUpperBound: number;
}
