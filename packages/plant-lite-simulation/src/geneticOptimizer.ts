/**
 * 遗传算法优化试点(规格 5.4,矩阵 P2)。
 * 实数编码 GA:锦标赛选择、算术交叉、高斯变异、精英保留;
 * 因子形态与点模型构建、指纹绑定全部复用 experimentDesign,评估走 runPlantLiteExperiment。
 * 确定性:GA 随机流按代从主种子派生(mixSeed),仿真流全程共享主种子(CRN),
 * 禁止 Math.random;同 seed 双跑历史曲线逐位一致。
 * GA 是启发式搜索,不承诺全局最优;评估次数 = populationSize×generations 量级,试点用小重复。
 */

import {
  type GeneticOptimizationConfig,
  type GeneticOptimizationGenerationRecord,
  type GeneticOptimizationResult,
  type PlantExperimentFactor,
} from "@bim-studio/contracts";
import { runPlantLiteExperiment } from "./engine.js";
import { buildPointModel, experimentPointFingerprint } from "./experimentDesign.js";
import { readMetricPath } from "./experimentAnalysis.js";
import type { PlantLiteModel, PlantLiteRunOptions, SimulationLimits } from "./model.js";
import { Random, mixSeed, seedNumber } from "./random.js";

interface FactorBounds {
  readonly id: string;
  readonly min: number;
  readonly max: number;
}

interface Individual {
  genes: Record<string, number>;
  metric: number;
  fingerprint: string;
}

const GENE_DECIMALS = 6;
/** 高斯变异步长占因子值域的比例;试点固定,不做自适应。 */
const MUTATION_SIGMA_RATIO = 0.15;

/** 评估前防线:任一基因越出因子声明值域立即拒绝,越界解不允许进入证据。 */
export function validateGenes(factors: readonly PlantExperimentFactor[], genes: Record<string, number>): void {
  for (const factor of boundsOf(factors)) {
    const value = genes[factor.id];
    if (value === undefined || !Number.isFinite(value)) throw new Error(`基因 ${factor.id} 缺少有限数值`);
    if (value < factor.min - 1e-9 || value > factor.max + 1e-9) {
      throw new Error(`基因 ${factor.id}=${value} 越出因子值域 [${factor.min}, ${factor.max}]`);
    }
  }
}

export class GeneticOptimizer {
  readonly #config: GeneticOptimizationConfig;
  readonly #factors: readonly PlantExperimentFactor[];
  readonly #bounds: readonly FactorBounds[];
  readonly #baseModel: PlantLiteModel;
  readonly #replications: number;
  readonly #limits: SimulationLimits | undefined;
  readonly #eliteCount: number;

  constructor(config: GeneticOptimizationConfig, factors: readonly PlantExperimentFactor[], baseModel: PlantLiteModel) {
    this.#config = assertConfig(config);
    this.#factors = factors;
    this.#bounds = boundsOf(factors);
    this.#baseModel = baseModel;
    this.#replications = config.replications ?? 3;
    if (!Number.isSafeInteger(this.#replications) || this.#replications < 1) throw new Error("replications 必须 ≥1");
    this.#limits = config.limits;
    this.#eliteCount = config.eliteCount ?? 1;
  }

  /** 进化到配置代数或被取消;历史曲线逐代记录,最优解绑定指纹可复现。 */
  optimize(runOptions: PlantLiteRunOptions = {}): GeneticOptimizationResult {
    const spawnRandom = new Random(mixSeed(seedNumber(this.#config.seed), 0));
    let population = this.#spawnPopulation(spawnRandom, runOptions);
    this.#sortByGoal(population);
    const history = [this.#recordGeneration(0, population)];
    let generations = 1;
    for (let generation = 1; generation < this.#config.generations; generation += 1) {
      if (runOptions.shouldCancel?.()) break;
      const stream = new Random(mixSeed(seedNumber(this.#config.seed), generation));
      population = this.#breedNextGeneration(population, stream, runOptions);
      this.#sortByGoal(population);
      history.push(this.#recordGeneration(generation, population));
      generations = generation + 1;
    }
    if (population.length === 0) throw new Error("种群为空,无可用结论");
    const best = population[0]!;
    return {
      generations,
      best: { genes: best.genes, metricValue: best.metric, fingerprint: best.fingerprint },
      history,
      evaluations: this.#evaluations,
    };
  }

  #evaluations = 0;

  #spawnPopulation(random: Random, runOptions: PlantLiteRunOptions): Individual[] {
    const population: Individual[] = [];
    for (let index = 0; index < this.#config.populationSize; index += 1) {
      const genes: Record<string, number> = {};
      for (const bound of this.#bounds) {
        genes[bound.id] = roundGene(bound.min + random.next() * (bound.max - bound.min));
      }
      population.push(this.#evaluate(genes, runOptions));
    }
    return population;
  }

  #breedNextGeneration(parents: Individual[], random: Random, runOptions: PlantLiteRunOptions): Individual[] {
    const next = parents.slice(0, this.#eliteCount).map((elite) => ({ ...elite, genes: { ...elite.genes } }));
    while (next.length < this.#config.populationSize) {
      const mother = this.#tournament(parents, random);
      const father = this.#tournament(parents, random);
      const genes: Record<string, number> = {};
      const blend = random.next() < this.#config.crossoverRate ? random.next() : 1;
      for (const bound of this.#bounds) {
        const inherited = mother.genes[bound.id]! * blend + father.genes[bound.id]! * (1 - blend);
        let value = inherited;
        if (random.next() < this.#config.mutationRate) {
          value += gauss(random) * MUTATION_SIGMA_RATIO * (bound.max - bound.min);
        }
        genes[bound.id] = roundGene(Math.min(Math.max(value, bound.min), bound.max));
      }
      next.push(this.#evaluate(genes, runOptions));
    }
    return next;
  }

  #tournament(population: readonly Individual[], random: Random): Individual {
    let winner = population[Math.floor(random.next() * population.length)]!;
    for (let index = 1; index < 3; index += 1) {
      const contender = population[Math.floor(random.next() * population.length)]!;
      if (this.#better(contender.metric, winner.metric)) winner = contender;
    }
    return winner;
  }

  #evaluate(genes: Record<string, number>, runOptions: PlantLiteRunOptions): Individual {
    validateGenes(this.#factors, genes);
    const model = buildPointModel(this.#baseModel, this.#factors, genes);
    const result = runPlantLiteExperiment({
      model,
      seed: this.#config.seed,
      replications: this.#replications,
      ...(this.#limits === undefined ? {} : { limits: this.#limits }),
    }, runOptions);
    this.#evaluations += 1;
    return {
      genes,
      metric: readMetricPath(result, this.#config.metricPath),
      fingerprint: experimentPointFingerprint(genes, this.#config.seed, result),
    };
  }

  #sortByGoal(population: Individual[]): void {
    population.sort((left, right) => (this.#better(left.metric, right.metric) ? -1 : this.#better(right.metric, left.metric) ? 1 : 0));
  }

  #better(left: number, right: number): boolean {
    return this.#config.goal === "maximize" ? left > right : left < right;
  }

  #recordGeneration(generation: number, population: readonly Individual[]): GeneticOptimizationGenerationRecord {
    const metrics = population.map((individual) => individual.metric);
    return {
      generation,
      bestMetric: metrics[0]!,
      meanMetric: metrics.reduce((sum, value) => sum + value, 0) / metrics.length,
    };
  }
}

function assertConfig(config: GeneticOptimizationConfig): GeneticOptimizationConfig {
  if (!config.metricPath || !config.metricPath.trim()) throw new Error("metricPath 不能为空");
  if (config.goal !== "maximize" && config.goal !== "minimize") throw new Error(`未知优化目标 ${String(config.goal)}`);
  if (!Number.isSafeInteger(config.populationSize) || config.populationSize < 2) throw new Error("populationSize 必须 ≥2");
  if (!Number.isSafeInteger(config.generations) || config.generations < 1) throw new Error("generations 必须 ≥1");
  for (const [name, rate] of [["crossoverRate", config.crossoverRate], ["mutationRate", config.mutationRate]] as const) {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error(`${name} 必须落在 [0,1]`);
  }
  const eliteCount = config.eliteCount ?? 1;
  if (!Number.isSafeInteger(eliteCount) || eliteCount < 0 || eliteCount >= config.populationSize) {
    throw new Error("eliteCount 必须落在 [0, populationSize)");
  }
  return config;
}

function boundsOf(factors: readonly PlantExperimentFactor[]): FactorBounds[] {
  if (factors.length === 0) throw new Error("遗传优化至少需要一个因子");
  const seen = new Set<string>();
  return factors.map((factor) => {
    if (seen.has(factor.id)) throw new Error(`因子 id 重复:${factor.id}`);
    seen.add(factor.id);
    if (factor.values.length === 0) throw new Error(`因子 ${factor.id} 的水平表为空`);
    if (!factor.values.every((value) => Number.isFinite(value))) throw new Error(`因子 ${factor.id} 的水平表含非有限数值`);
    return { id: factor.id, min: Math.min(...factor.values), max: Math.max(...factor.values) };
  });
}

function roundGene(value: number): number {
  return Math.round(value * 10 ** GENE_DECIMALS) / 10 ** GENE_DECIMALS;
}

function gauss(random: Random): number {
  return Math.sqrt(-2 * Math.log(Math.max(Number.EPSILON, random.next()))) * Math.cos(2 * Math.PI * random.next());
}
