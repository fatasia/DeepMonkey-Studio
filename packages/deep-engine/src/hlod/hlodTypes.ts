/**
 * T26 HLOD 自动生成——聚合树与代理决策的公共合同(第一切片,纯 CPU)。
 *
 * 与既有底座的分工(不重复建设):
 * - `packetBoundsHlod.ts` 是逐实例远档包围盒代理(packet 内 LOD 层);本模块是
 *   **跨实例**的空间聚合树(叶=实例,内节点=聚合簇),代理切换按簇决策。
 * - 屏幕误差公式单一定义沿用 `rayTracing/clusterLodSelection.ts` 的
 *   `clusterScreenError`(CPU 参考与 WGSL kernel 逐式对应的那份),本模块不重写公式。
 * - 确定性纪律同 T13:同输入 + 同算法版本 → 逐位同树;内容哈希身份支撑增量失效。
 */

/** 聚合输入实例:世界包围球(中心 + 半径)。id 全局唯一,radius ≥ 0(点状资产允许 0)。 */
export interface HlodInstanceInput {
  readonly id: string;
  readonly position: readonly [number, number, number];
  readonly radius: number;
}

export interface HlodClusterOptions {
  /**
   * 终端聚合扇出:单元成员数 ≤ maxChildren 时不再二分,直接构成一个聚合节点
   * (子节点 = 成员实例叶)。更大扇出 → 更浅层级、更早的整簇折叠。
   */
  readonly maxChildren?: number;
  /** 深度保险上限:median-split 深度 ≤ log2(n)+1,超出即视为实现缺陷 fail-closed。 */
  readonly maxDepth?: number;
}

export interface HlodClusterConfiguration {
  readonly maxChildren: number;
  readonly maxDepth: number;
}

export const HLOD_CLUSTER_DEFAULTS = Object.freeze({
  maxChildren: 8,
  maxDepth: 64,
});

/** 算法版本:进入树与决策结果的确定性合同;行为变更必须升版本(同 T13 纪律)。 */
export const HLOD_ALGORITHM_VERSION = "t26-hlod-cluster-v1";

/**
 * 聚合树节点。叶(level 0)= 单实例;内节点 = 子球的最小包围球(保守代理误差 = radius)。
 * 节点对象 = 纯子树内容(胞元几何 + 成员 + 子 id 序列;无父指针):父关系由树级
 * `parentByNode` 承载,使"子树内容不变 ⇒ 节点对象跨版本复用"在结构上成立。
 */
export interface HlodClusterNode {
  /** 内容身份:FNV 双种子 64 位哈希(叶=实例指纹+胞元,内节点=子 id 序列+胞元);冲突 fail-closed。 */
  readonly id: string;
  /** 叶 = 0;内节点 = max(子 level) + 1。 */
  readonly level: number;
  /** 该节点负责的胞元(根 = rootCell;八分子胞元边界 f64 精确;tie-split 与父同胞元)。 */
  readonly cell: HlodCell;
  readonly children: readonly string[];
  /** 成员实例 id,规范序((x,y,z,id) 字典序)——确定性遍历与输出排序的基准。 */
  readonly instanceIds: readonly string[];
  readonly instanceCount: number;
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

export interface HlodClusterStats {
  readonly nodeCount: number;
  readonly leafCount: number;
  readonly internalCount: number;
  /** 叶的最大深度(根到叶的边数)。 */
  readonly depth: number;
  readonly maxFanout: number;
}

/** 根胞元(轴对齐立方体):side = 2 的幂;子胞元边界 = center ± side/4,f64 精确。 */
export interface HlodCell {
  readonly center: readonly [number, number, number];
  readonly side: number;
}

export interface HlodClusterTree {
  readonly algorithmVersion: typeof HLOD_ALGORITHM_VERSION;
  readonly options: HlodClusterConfiguration;
  /** 根胞元(边界几何常量;小范围增量更新保持不变 ⇒ 局部性成立)。 */
  readonly rootCell: HlodCell;
  /** 空实例集 → null(空场景是合法状态;决策结果为空,不抛错)。 */
  readonly rootId: string | null;
  readonly nodes: ReadonlyMap<string, HlodClusterNode>;
  /** instanceId → 叶节点 id。 */
  readonly leafByInstance: ReadonlyMap<string, string>;
  /** nodeId → 父节点 id(根为 null);节点对象保持内容纯粹,父子关系属树级结构。 */
  readonly parentByNode: ReadonlyMap<string, string | null>;
  readonly stats: HlodClusterStats;
}

export interface HlodTreeDelta {
  /** 增量后与前树内容 id 相同而**复用同一对象**的节点数(引用不变的可断言证据)。 */
  readonly reusedNodes: number;
  /** 内容 id 变化而重建的节点数 = 变更实例的祖先闭包(含叶)。 */
  readonly rebuiltNodes: number;
}

export interface HlodTreeChangeSet {
  /** 新增实例(id 不得与现存重复)。 */
  readonly added?: readonly HlodInstanceInput[];
  /** 删除的实例 id(必须存在;漂移 fail-closed)。 */
  readonly removed?: readonly string[];
  /** 移动/变形实例的**完整新输入**(id 必须存在;坐标与半径与旧值全等 → no-op 整树复用)。 */
  readonly moved?: readonly HlodInstanceInput[];
}

export const HLOD_DECISION_DEFAULTS = Object.freeze({
  /** 目标像素误差:簇包围球半径的投影 ≤ 该值 → 整簇折叠为聚合代理。 */
  targetPixelError: 8,
  /** 迟滞比(与 packetBoundsHlod 默认一致):已折叠簇在 ≤(1+h)× 阈值内保持折叠防抖动。 */
  hysteresisRatio: 0.12,
});

export interface HlodDecisionOptions {
  readonly targetPixelError?: number;
  readonly hysteresisRatio?: number;
}

export interface HlodDecisionConfiguration {
  readonly targetPixelError: number;
  readonly hysteresisRatio: number;
}

/** 单簇决策记录。 */
export interface HlodClusterDecision {
  readonly nodeId: string;
  readonly level: number;
  readonly screenErrorPixels: number;
  /** true = 折叠为聚合代理(子树全部隐藏);false = 下钻(叶则渲染实例)。 */
  readonly collapsed: boolean;
  /** true = 迟滞把上一帧的折叠保持到了超出严格阈值的区间。 */
  readonly heldByHysteresis: boolean;
}

export interface HlodFrameDecision {
  /** 折叠簇(聚合代理绘制列表),id 升序。 */
  readonly collapsedNodes: readonly HlodClusterDecision[];
  /** 需要真实渲染的实例叶,id 升序。 */
  readonly renderedLeaves: readonly string[];
  readonly renderedInstances: number;
  readonly hiddenInstances: number;
  readonly visitedNodes: number;
  /** hiddenInstances / totalInstances(空树 = 0)。 */
  readonly proxyCoverage: number;
}

export type HlodErrorCode =
  | "duplicate-instance-id"
  | "invalid-instance"
  | "invalid-options"
  | "invalid-camera"
  | "hash-collision"
  | "depth-exceeded"
  | "unknown-node"
  /** 代理生成:簇成员缺少几何摘要。 */
  | "unknown-instance"
  /** 代理生成:几何摘要形状非法(非有限/min>max)。 */
  | "invalid-shape"
  /** 代理生成:目标节点非法(不存在/是叶)。 */
  | "invalid-node";

export class HlodError extends Error {
  readonly code: HlodErrorCode;

  constructor(code: HlodErrorCode, message: string) {
    super(message);
    this.name = "HlodError";
    this.code = code;
  }
}
