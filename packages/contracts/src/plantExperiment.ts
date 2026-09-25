import type { PlantLiteModel } from "./plantLiteModel.js";
/**
 * 实验矩阵与参数扫描合同(PS/PD/Plant 替代规格 5.4,R1 前置)。
 * 只覆盖 grid / sweep / random(确定性 LHS) 三种设计与筛查型分析;
 * 响应面、贝叶斯优化、多目标优化、遗传算法不在本层合同内。
 */

/** 实验设计类型;random 为种子确定性拉丁超立方,禁止 Math.random。 */
export type PlantExperimentDesignKind = "grid" | "sweep" | "random";

/** 优化目标方向;单指标单目标,组合目标是后续层的事。 */
export type PlantExperimentGoal = "maximize" | "minimize";

/**
 * 因子:apply 把一个标量水平写进模型(工位节拍、缓冲容量、资源容量等)。
 * values[0] 约定为基线水平(sweep 的其余因子取它);grid/sweep 按 values 枚举,
 * random(LHS) 在 [min(values), max(values)] 区间内分层采样。
 */
export interface PlantExperimentFactor {
  id: string;
  label: string;
  values: readonly number[];
  /** 直接改写传入模型;调用方保证传入的是深拷贝后的基准模型,实现不得共享外部可变状态。 */
  apply(model: PlantLiteModel, value: number): void;
}

/** 设计规格;seed 只驱动 LHS 的置换与抖动,与仿真运行种子相互独立。 */
export interface PlantExperimentDesignSpec {
  kind: PlantExperimentDesignKind;
  /** random(LHS) 的采样点数;grid/sweep 忽略。 */
  levels?: number;
  /** LHS 确定性来源;省略按固定默认种子,同 seed 双跑设计矩阵逐位一致。 */
  seed?: string | number;
}

/** 设计点:因子 id 到水平值的快照,是复现一次运行的完整因子输入。 */
export interface PlantExperimentDesignPoint {
  index: number;
  params: Record<string, number>;
}

/** 敏感性方向与强度;强度按 |spearman| 分档。 */
export type PlantSensitivityDirection = "increasing" | "decreasing" | "none";
export type PlantSensitivityStrength = "strong" | "moderate" | "weak" | "none";

/** 单因子对单指标的筛查结论;pearson/spearman 均为小样本自实现公式。 */
export interface PlantFactorSensitivity {
  factorId: string;
  label: string;
  pearson: number;
  /** 含并列秩的平均秩修正。 */
  spearman: number;
  direction: PlantSensitivityDirection;
  strength: PlantSensitivityStrength;
}

export interface PlantSensitivityReport {
  /** 读自实验结果对象的点分路径,如 confidence95.throughputPerHour.mean。 */
  metricPath: string;
  sampleCount: number;
  factors: PlantFactorSensitivity[];
}

/** 两设计点显著性:Welch t(方差不等,Satterthwaite 自由度)+ Hedges' g 小样本校正效应量。 */
export interface PlantPointComparison {
  meanA: number;
  meanB: number;
  difference: number;
  welchT: number;
  degreesOfFreedom: number;
  /** 双侧 p 值;两组零方差且均值相等时恒为 1,均值不等时恒为 0。 */
  pValue: number;
  hedgesG: number;
  gLower95: number;
  gUpper95: number;
  /** 两点 replication 种子逐位相同(CRN)时为 true,配对解读才成立。 */
  pairedSeeds: boolean;
}

/** 排序条目:指标值 + 设计点参数 + 指纹,足够复现与追溯。 */
export interface PlantPointRankingEntry {
  index: number;
  params: Record<string, number>;
  fingerprint: string;
  metric: number;
}

export interface PlantPointRanking {
  metricPath: string;
  goal: PlantExperimentGoal;
  entries: PlantPointRankingEntry[];
}
