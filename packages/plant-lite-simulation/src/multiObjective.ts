/**
 * 多目标(Pareto)优化:NSGA-II 精简版(Plant 替代 P2 尾巴)。
 * 快速非支配排序 + 拥挤距离 + 二元锦囊选择 + 精英保留(父代并入子代竞争);因子/点模型/指纹
 * 复用 experimentDesign,评估走 runPlantLiteExperiment,基因越界防线复用 validateGenes。
 * 确定性:进化流按代从主种子派生(mixSeed),仿真流共享主种子(CRN),禁止 Math.random,
 * 同 seed 双跑逐位一致。诚实边界:拥挤距离只在双目标下有经典几何解释;收敛是启发式的。
 */

import { compareText } from "./textOrder.js";
import {
  type MultiObjectiveConfig,
  type MultiObjectiveGenerationRecord,
  type MultiObjectiveResult,
  type MultiObjectiveSolution,
  type MultiObjectiveTarget,
  type PlantExperimentFactor,
} from "@bim-studio/contracts";
import { runPlantLiteExperiment } from "./engine.js";
import { buildPointModel, experimentPointFingerprint } from "./experimentDesign.js";
import { readMetricPath } from "./experimentAnalysis.js";
import { validateGenes } from "./geneticOptimizer.js";
import type { PlantLiteExperimentResult, PlantLiteModel, PlantLiteRunOptions, SimulationLimits } from "./model.js";
import { Random, mixSeed, seedNumber } from "./random.js";

interface FactorBounds { readonly id: string; readonly min: number; readonly max: number }
interface Individual {
  genes: Record<string, number>;
  objectives: number[]; // 与 targetNames 同序的目标值向量。
  fingerprint: string;
  rank: number;
  crowdingDistance: number;
}

const GENE_DECIMALS = 6;
/** 变异步长占因子值域比例;与单目标 GA 同口径,试点固定。 */
const MUTATION_SIGMA_RATIO = 0.15;

/** 目标名 = label ?? metricPath;objectives 键与历史键都用它,必须两两不重。 */
export function targetName(target: MultiObjectiveTarget): string {
  return target.label ?? target.metricPath;
}

/** 目标值向量读取前防线:路径缺失或非有限值立即抛错,禁止静默 0。 */
export function readObjectiveVector(targets: readonly MultiObjectiveTarget[], result: PlantLiteExperimentResult): number[] {
  return targets.map((target) => {
    const value = readMetricPath(result, target.metricPath);
    if (!Number.isFinite(value)) throw new Error(`目标 ${targetName(target)} 的值 ${value} 非有限,拒绝进入前沿`);
    return value;
  });
}

export class MultiObjectiveOptimizer {
  readonly #config: MultiObjectiveConfig;
  readonly #factors: readonly PlantExperimentFactor[];
  readonly #bounds: readonly FactorBounds[];
  readonly #baseModel: PlantLiteModel;
  readonly #replications: number;
  readonly #limits: SimulationLimits | undefined;
  readonly #targetNames: string[];
  readonly #signs: number[]; // 变换后“越大越好”:minimize 取负;支配与排序全在变换后空间。

  constructor(config: MultiObjectiveConfig, factors: readonly PlantExperimentFactor[], baseModel: PlantLiteModel) {
    this.#config = assertConfig(config);
    this.#factors = factors;
    this.#bounds = boundsOf(factors);
    this.#baseModel = baseModel;
    this.#replications = config.replications ?? 3;
    if (!Number.isSafeInteger(this.#replications) || this.#replications < 1) throw new Error("replications 必须 ≥1");
    this.#limits = config.limits;
    this.#targetNames = config.targets.map(targetName);
    this.#signs = config.targets.map((target) => (target.goal === "maximize" ? 1 : -1));
  }

  /** 进化到配置代数或被取消;前沿成员 rank 恒为 1,历史逐代记录方向感知最优。 */
  optimize(runOptions: PlantLiteRunOptions = {}): MultiObjectiveResult {
    const spawnRandom = new Random(mixSeed(seedNumber(this.#config.seed), 0));
    let population = this.#spawnPopulation(spawnRandom, runOptions);
    this.#assignRankAndCrowding(population);
    const history = [this.#recordGeneration(0, population)];
    let generations = 1;
    for (let generation = 1; generation < this.#config.generations; generation += 1) {
      if (runOptions.shouldCancel?.()) break;
      const stream = new Random(mixSeed(seedNumber(this.#config.seed), generation));
      const offspring = this.#breedOffspring(population, stream, runOptions);
      population = this.#selectNextPopulation([...population, ...offspring]);
      history.push(this.#recordGeneration(generation, population));
      generations = generation + 1;
    }
    const paretoFront = population.filter((individual) => individual.rank === 1)
      .map((individual) => this.#toSolution(individual))
      .sort((left, right) => this.#frontOrder(left, right));
    return { paretoFront, generations, history, evaluations: this.#evaluations, targetNames: this.#targetNames };
  }

  #evaluations = 0;

  #spawnPopulation(random: Random, runOptions: PlantLiteRunOptions): Individual[] {
    const population: Individual[] = [];
    for (let index = 0; index < this.#config.populationSize; index += 1) {
      const genes: Record<string, number> = {};
      for (const bound of this.#bounds) genes[bound.id] = roundGene(bound.min + random.next() * (bound.max - bound.min));
      population.push(this.#evaluate(genes, runOptions));
    }
    return population;
  }

  #breedOffspring(parents: Individual[], random: Random, runOptions: PlantLiteRunOptions): Individual[] {
    const offspring: Individual[] = [];
    while (offspring.length < this.#config.populationSize) {
      const mother = this.#tournament(parents, random);
      const father = this.#tournament(parents, random);
      const genes: Record<string, number> = {};
      const blend = random.next() < this.#config.crossoverRate ? random.next() : 1;
      for (const bound of this.#bounds) {
        const inherited = mother.genes[bound.id]! * blend + father.genes[bound.id]! * (1 - blend);
        let value = inherited;
        if (random.next() < this.#config.mutationRate) value += gauss(random) * MUTATION_SIGMA_RATIO * (bound.max - bound.min);
        genes[bound.id] = roundGene(Math.min(Math.max(value, bound.min), bound.max));
      }
      offspring.push(this.#evaluate(genes, runOptions));
    }
    return offspring;
  }

  /** 二元锦囊选择:秩小者优先,同秩拥挤距离大者优先(多样性)。 */
  #tournament(population: readonly Individual[], random: Random): Individual {
    const pick = () => population[Math.floor(random.next() * population.length)]!;
    const first = pick();
    const second = pick();
    if (first.rank !== second.rank) return first.rank < second.rank ? first : second;
    return first.crowdingDistance >= second.crowdingDistance ? first : second;
  }

  #evaluate(genes: Record<string, number>, runOptions: PlantLiteRunOptions): Individual {
    validateGenes(this.#factors, genes);
    const model = buildPointModel(this.#baseModel, this.#factors, genes);
    const result = runPlantLiteExperiment({
      model, seed: this.#config.seed, replications: this.#replications,
      ...(this.#limits === undefined ? {} : { limits: this.#limits }),
    }, runOptions);
    this.#evaluations += 1;
    return {
      genes,
      objectives: readObjectiveVector(this.#config.targets, result),
      fingerprint: experimentPointFingerprint(genes, this.#config.seed, result),
      rank: 0,
      crowdingDistance: 0,
    };
  }

  /** 精英保留:父代与子代合并,按指纹去重(blend=1 且未变异会精确复制父代),再截断回原规模。 */
  #selectNextPopulation(union: Individual[]): Individual[] {
    const seen = new Set<string>();
    const unique = union.filter((individual) => (seen.has(individual.fingerprint) ? false : (seen.add(individual.fingerprint), true)));
    const next: Individual[] = [];
    for (const front of this.#nonDominatedSort(unique)) {
      if (next.length + front.length <= this.#config.populationSize) {
        next.push(...front);
        continue;
      }
      this.#assignCrowdingDistance(front);
      const byCrowding = [...front].sort((left, right) =>
        right.crowdingDistance - left.crowdingDistance || compareText(left.fingerprint, right.fingerprint));
      next.push(...byCrowding.slice(0, this.#config.populationSize - next.length));
      break;
    }
    return next;
  }

  /** 快速非支配排序;返回按秩分组(秩 1 在前)的个体引用列表,并就地写入 rank。 */
  #nonDominatedSort(individuals: Individual[]): Individual[][] {
    const dominated = individuals.map(() => [] as number[]);
    const dominationCount = individuals.map(() => 0);
    for (let i = 0; i < individuals.length; i += 1) {
      for (let j = i + 1; j < individuals.length; j += 1) {
        if (this.#dominates(individuals[i]!, individuals[j]!)) {
          dominated[i]!.push(j); dominationCount[j]! += 1;
        } else if (this.#dominates(individuals[j]!, individuals[i]!)) {
          dominated[j]!.push(i); dominationCount[i]! += 1;
        }
      }
    }
    let current = individuals.reduce<number[]>((front, _, index) => (dominationCount[index] === 0 ? [...front, index] : front), []);
    const fronts: Individual[][] = [];
    let rank = 1;
    while (current.length > 0) {
      fronts.push(current.map((index) => { individuals[index]!.rank = rank; return individuals[index]!; }));
      const next: number[] = [];
      for (const index of current) {
        for (const follower of dominated[index]!) {
          dominationCount[follower]! -= 1;
          if (dominationCount[follower] === 0) next.push(follower);
        }
      }
      current = next;
      rank += 1;
    }
    return fronts;
  }

  /** 拥挤距离(变换后目标空间):边界解无穷大,内部解按相邻目标间距归一累加。 */
  #assignCrowdingDistance(front: Individual[]): void {
    for (const individual of front) individual.crowdingDistance = 0;
    for (let axis = 0; axis < this.#targetNames.length; axis += 1) {
      const ordered = [...front].sort((left, right) =>
        left.objectives[axis]! - right.objectives[axis]! || compareText(left.fingerprint, right.fingerprint));
      ordered[0]!.crowdingDistance = ordered[ordered.length - 1]!.crowdingDistance = Infinity;
      const span = ordered[ordered.length - 1]!.objectives[axis]! - ordered[0]!.objectives[axis]!;
      if (span <= 0) continue;
      for (let index = 1; index < ordered.length - 1; index += 1) {
        const individual = ordered[index]!;
        if (individual.crowdingDistance === Infinity) continue;
        individual.crowdingDistance += (ordered[index + 1]!.objectives[axis]! - ordered[index - 1]!.objectives[axis]!) / span;
      }
    }
  }

  #assignRankAndCrowding(population: Individual[]): void {
    for (const front of this.#nonDominatedSort(population)) this.#assignCrowdingDistance(front);
  }

  /** 支配判定(变换后空间):全目标不劣且至少一目标严格更优。 */
  #dominates(left: Individual, right: Individual): boolean {
    let strictlyBetter = false;
    for (let axis = 0; axis < left.objectives.length; axis += 1) {
      const a = left.objectives[axis]! * this.#signs[axis]!;
      const b = right.objectives[axis]! * this.#signs[axis]!;
      if (a < b) return false;
      strictlyBetter ||= a > b;
    }
    return strictlyBetter;
  }

  #recordGeneration(generation: number, population: readonly Individual[]): MultiObjectiveGenerationRecord {
    const bestByTarget: Record<string, number> = {};
    const meanByTarget: Record<string, number> = {};
    for (let axis = 0; axis < this.#targetNames.length; axis += 1) {
      const values = population.map((individual) => individual.objectives[axis]!);
      bestByTarget[this.#targetNames[axis]!] = this.#signs[axis]! > 0 ? Math.max(...values) : Math.min(...values);
      meanByTarget[this.#targetNames[axis]!] = values.reduce((sum, value) => sum + value, 0) / values.length;
    }
    return { generation, frontSize: population.filter((individual) => individual.rank === 1).length, bestByTarget, meanByTarget };
  }

  #toSolution(individual: Individual): MultiObjectiveSolution {
    const { genes, fingerprint, rank, crowdingDistance } = individual;
    return {
      genes,
      objectives: Object.fromEntries(this.#targetNames.map((name, axis) => [name, individual.objectives[axis]!])),
      fingerprint, rank, crowdingDistance,
    };
  }

  /** 前沿输出顺序:按各目标“更优在前”逐轴比较,全平按指纹,保证确定性。 */
  #frontOrder(left: MultiObjectiveSolution, right: MultiObjectiveSolution): number {
    for (let axis = 0; axis < this.#targetNames.length; axis += 1) {
      const diff = right.objectives[this.#targetNames[axis]!]! * this.#signs[axis]!
        - left.objectives[this.#targetNames[axis]!]! * this.#signs[axis]!;
      if (diff !== 0) return diff;
    }
    return compareText(left.fingerprint, right.fingerprint);
  }
}

function assertConfig(config: MultiObjectiveConfig): MultiObjectiveConfig {
  if (!Array.isArray(config.targets) || config.targets.length < 2) throw new Error("多目标优化至少需要 2 个目标");
  const names = new Set<string>();
  for (const target of config.targets) {
    if (!target.metricPath || !target.metricPath.trim()) throw new Error("目标 metricPath 不能为空");
    if (target.goal !== "maximize" && target.goal !== "minimize") throw new Error(`未知优化目标 ${String(target.goal)}`);
    const name = targetName(target);
    if (names.has(name)) throw new Error(`目标名重复:${name}`);
    names.add(name);
  }
  if (!Number.isSafeInteger(config.populationSize) || config.populationSize < 4) throw new Error("populationSize 必须 ≥4");
  if (!Number.isSafeInteger(config.generations) || config.generations < 1) throw new Error("generations 必须 ≥1");
  for (const [name, rate] of [["crossoverRate", config.crossoverRate], ["mutationRate", config.mutationRate]] as const) {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error(`${name} 必须落在 [0,1]`);
  }
  return config;
}

function boundsOf(factors: readonly PlantExperimentFactor[]): FactorBounds[] {
  if (factors.length === 0) throw new Error("多目标优化至少需要一个因子");
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
