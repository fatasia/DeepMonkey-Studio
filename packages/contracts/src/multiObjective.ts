/**
 * 多目标(Pareto)优化合同(Plant 替代 P2 尾巴)。
 * 只约定目标集、进化配置与 Pareto 前沿证据(解 + 目标向量 + 指纹 + 秩);
 * 搜索实现(NSGA-II 精简版:快速非支配排序 + 拥挤距离)在 plant-lite-simulation。
 * 因子形态复用 plantExperiment 的 PlantExperimentFactor;目标方向复用 PlantExperimentGoal。
 * GA 的单目标优化(geneticOptimization.ts)与多目标是并列关系,互不替代。
 */

import type { PlantExperimentFactor, PlantExperimentGoal } from "./plantExperiment.js";
import type { PlantLiteSimulationLimits } from "./plantLiteModel.js";

/** 单个优化目标:读自实验结果对象的点分路径 + 优化方向。k 目标 = k 个 entry,至少 2 个。 */
export interface MultiObjectiveTarget {
  /** 读自实验结果对象的点分路径,如 confidence95.throughputPerHour.mean。 */
  metricPath: string;
  goal: PlantExperimentGoal;
  /** 目标展示名;缺省用 metricPath,作为 objectives 键与历史记录键,必须两两不重。 */
  label?: string;
}

/** 多目标进化配置;全部随机性由 seed 派生,同 seed 双跑结果逐位一致。 */
export interface MultiObjectiveConfig {
  /** 目标集;至少 2 个(双目标),可扩展 k 目标。目标间若不冲突,前沿退化为单点,是合法结果。 */
  targets: readonly [MultiObjectiveTarget, MultiObjectiveTarget, ...MultiObjectiveTarget[]];
  /** 种群规模,≥4;精英保留 + 分层填充要求种群至少容纳两个前沿层。 */
  populationSize: number;
  /** 进化代数,≥1。 */
  generations: number;
  /** 交叉概率,∈[0,1]。 */
  crossoverRate: number;
  /** 变异概率,∈[0,1]。 */
  mutationRate: number;
  /** 进化流按代从主种子派生;仿真流全程共享主种子(CRN)。 */
  seed: string | number;
  /** 每次候选评估的仿真重复次数;缺省 3。 */
  replications?: number;
  limits?: PlantLiteSimulationLimits;
}

/** 前沿(及种群)中的一个解;objectives 键 = 目标名(label ?? metricPath)。 */
export interface MultiObjectiveSolution {
  genes: Record<string, number>;
  objectives: Record<string, number>;
  /** 基因 + 种子 + 仿真结果三者绑定的指纹,输入完整可复现。 */
  fingerprint: string;
  /** 非支配序,1 = Pareto 前沿;仅供审计,前沿成员恒为 1。 */
  rank: number;
  /** 同层拥挤距离;无穷大表示该目标轴上的层边界解。 */
  crowdingDistance: number;
}

/** 一代的收敛记录;best 为方向感知最优(maximize 取最大,minimize 取最小)。 */
export interface MultiObjectiveGenerationRecord {
  generation: number;
  /** 该代种群第一前沿的规模。 */
  frontSize: number;
  bestByTarget: Record<string, number>;
  meanByTarget: Record<string, number>;
}

export interface MultiObjectiveResult {
  /** 最终种群的第一前沿;目标轴上无互配对支配。 */
  paretoFront: MultiObjectiveSolution[];
  /** 实际完成的代数;Cancelled 时可小于配置值。 */
  generations: number;
  history: MultiObjectiveGenerationRecord[];
  /** 累计仿真评估次数(populationSize×(generations+初始代) 上界,精英免重评)。 */
  evaluations: number;
  /** 目标名快照,与 objectives 键顺序一致。 */
  targetNames: string[];
}

/** 因子形态直接复用实验设计的 PlantExperimentFactor;此处仅为文档锚点,不另立类型。 */
export type MultiObjectiveFactor = PlantExperimentFactor;
