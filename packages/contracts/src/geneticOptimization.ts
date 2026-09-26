/**
 * 遗传算法优化合同(规格 5.4,矩阵 P2 试点)。
 * 只约定配置形态与结果证据(历史曲线 + 最优解指纹);
 * 因子形态直接复用 plantExperiment 的 PlantExperimentFactor,不另立一套。
 * GA 是启发式搜索,不承诺全局最优;响应面、贝叶斯与多目标不在本合同。
 */

import type { PlantExperimentFactor, PlantExperimentGoal } from "./plantExperiment.js";
import type { PlantLiteSimulationLimits } from "./plantLiteModel.js";

export type GeneticOptimizationGoal = PlantExperimentGoal;

/** GA 运行配置;全部随机性由 seed 派生,同 seed 双跑历史曲线逐位一致。 */
export interface GeneticOptimizationConfig {
  /** 读自实验结果对象的点分路径,如 confidence95.throughputPerHour.mean。 */
  metricPath: string;
  goal: GeneticOptimizationGoal;
  /** 种群规模,≥2;精英数必须小于它。 */
  populationSize: number;
  /** 进化代数,≥1。 */
  generations: number;
  /** 交叉概率,∈[0,1]。 */
  crossoverRate: number;
  /** 变异概率,∈[0,1]。 */
  mutationRate: number;
  /** 每代直接保留的精英个体数,缺省 1。 */
  eliteCount?: number;
  /** GA 与仿真共用主种子:GA 随机流按代派生,仿真流全程共享(CRN)。 */
  seed: string | number;
  /** 每次候选评估的仿真重复次数;试点用小重复控制评估成本。 */
  replications?: number;
  limits?: PlantLiteSimulationLimits;
}

/** 一代的收敛记录;bestMetric 为该代全体评估后的最优指标值。 */
export interface GeneticOptimizationGenerationRecord {
  generation: number;
  bestMetric: number;
  meanMetric: number;
}

export interface GeneticOptimizationResult {
  /** 实际完成的代数;Cancelled 时可小于配置值。 */
  generations: number;
  /** 最优解:基因快照 + 指标值 + 绑定(基因、种子、结果)的指纹,输入完整可复现。 */
  best: {
    genes: Record<string, number>;
    metricValue: number;
    fingerprint: string;
  };
  history: GeneticOptimizationGenerationRecord[];
  /** 累计仿真评估次数(populationSize×generations 上界)。 */
  evaluations: number;
}
