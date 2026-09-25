/**
 * 实验矩阵与参数扫描(PS/PD/Plant 替代规格 5.4,R1 前置)。
 * 纯函数层:只组合既有内核 runPlantLiteExperiment,不新增任何统计语义。
 * 共同随机数(CRN):全部设计点共用同一个运行种子,同序号 replication 共享
 * 种子基,跨设计点配对比较才成立。
 */

import {
  fingerprint64Labeled,
  type PlantExperimentDesignKind,
  type PlantExperimentDesignPoint,
  type PlantExperimentDesignSpec,
  type PlantExperimentFactor,
} from "@bim-studio/contracts";
import { runPlantLiteExperiment } from "./engine.js";
import type { PlantLiteExperimentResult, PlantLiteModel, PlantLiteRunOptions, SimulationLimits } from "./model.js";
import { Random, seedNumber } from "./random.js";

/** 单设计点数上限;全因子网格按笛卡尔积计,防止组合爆炸。 */
export const MAX_DESIGN_POINTS = 1000;
const MAX_LHS_LEVELS = 512;
const DEFAULT_LHS_LEVELS = 10;
const DEFAULT_LHS_SEED = "plant-experiment-lhs";
/** LHS 层内抖动留出的边界;四舍五入后被压回层内,保证每层恰好一点可被外部核验。 */
const LHS_STRATUM_MARGIN = 1e-6;

export interface PlantExperimentRunSpec {
  /** 所有设计点共用的运行种子;这是 CRN 的唯一来源。 */
  seed: string | number;
  replications?: number;
  limits?: SimulationLimits;
}

export interface PlantExperimentPointRecord {
  point: PlantExperimentDesignPoint;
  fingerprint: string;
  result: PlantLiteExperimentResult;
}

export interface PlantExperimentMatrixResult {
  design: PlantExperimentDesignKind;
  points: PlantExperimentPointRecord[];
}

/** 生成设计点矩阵;grid 全因子网格、sweep 单因子扫描(其余基线)、random 确定性 LHS。 */
export function buildDesignPoints(factors: readonly PlantExperimentFactor[], spec: PlantExperimentDesignSpec): PlantExperimentDesignPoint[] {
  assertFactors(factors);
  const baselines = new Map(factors.map((factor) => [factor.id, factor.values[0]!]));
  const withBaseline = (params: Map<string, number>): Record<string, number> => {
    const merged = new Map(baselines);
    for (const [id, value] of params) merged.set(id, value);
    return Object.fromEntries([...merged.entries()]);
  };
  if (spec.kind === "grid") return gridPoints(factors).map((params, index) => ({ index, params: Object.fromEntries(params) }));
  if (spec.kind === "sweep") {
    const total = factors.reduce((sum, factor) => sum + factor.values.length, 0);
    if (total > MAX_DESIGN_POINTS) throw new RangeError(`sweep 设计点数 ${total} 超过上限 ${MAX_DESIGN_POINTS}`);
    const points: PlantExperimentDesignPoint[] = [];
    for (const factor of factors) {
      for (const value of factor.values) {
        points.push({ index: points.length, params: withBaseline(new Map([[factor.id, value]])) });
      }
    }
    return points;
  }
  if (spec.kind !== "random") throw new Error(`未知设计类型 ${String(spec.kind)}`);
  return lhsPoints(factors, spec);
}

/** 深拷贝基准模型后按 params 逐因子 apply;因子缺水平视为契约错误,立即抛出。 */
export function buildPointModel(baseModel: PlantLiteModel, factors: readonly PlantExperimentFactor[], params: Record<string, number>): PlantLiteModel {
  const model = structuredClone(baseModel);
  for (const factor of factors) {
    const value = params[factor.id];
    if (value === undefined || !Number.isFinite(value)) {
      throw new Error(`设计点缺少因子 ${factor.id} 的有限水平值`);
    }
    factor.apply(model, value);
  }
  return model;
}

/** 点指纹:参数快照 + 运行种子 + 结果三者绑定;任何一项漂移都会改变指纹。 */
export function experimentPointFingerprint(params: Record<string, number>, seed: string | number, result: PlantLiteExperimentResult): string {
  return fingerprint64Labeled([
    ["params", params],
    ["seed", seed],
    ["result", result],
  ]);
}

/** 逐点运行矩阵;每点深拷贝基准模型并 apply,运行种子全矩阵共享(CRN)。 */
export function runExperimentMatrix(
  baseModel: PlantLiteModel,
  factors: readonly PlantExperimentFactor[],
  spec: PlantExperimentDesignSpec,
  run: PlantExperimentRunSpec,
  options: PlantLiteRunOptions = {},
): PlantExperimentMatrixResult {
  const points: PlantExperimentPointRecord[] = [];
  for (const point of buildDesignPoints(factors, spec)) {
    if (options.shouldCancel?.()) break;
    const model = buildPointModel(baseModel, factors, point.params);
    const result = runPlantLiteExperiment({
      model,
      seed: run.seed,
      ...(run.replications === undefined ? {} : { replications: run.replications }),
      ...(run.limits === undefined ? {} : { limits: run.limits }),
    }, options);
    points.push({ point, fingerprint: experimentPointFingerprint(point.params, run.seed, result), result });
  }
  return { design: spec.kind, points };
}

function assertFactors(factors: readonly PlantExperimentFactor[]): void {
  if (factors.length === 0) throw new Error("实验矩阵至少需要一个因子");
  const ids = new Set<string>();
  for (const factor of factors) {
    if (ids.has(factor.id)) throw new Error(`因子 id 重复:${factor.id}`);
    ids.add(factor.id);
    if (factor.values.length === 0) throw new Error(`因子 ${factor.id} 的水平表为空`);
    if (!factor.values.every((value) => Number.isFinite(value))) throw new Error(`因子 ${factor.id} 的水平表含非有限数值`);
  }
}

function gridPoints(factors: readonly PlantExperimentFactor[]): Array<Map<string, number>> {
  const total = factors.reduce((product, factor) => product * factor.values.length, 1);
  if (total > MAX_DESIGN_POINTS) throw new RangeError(`grid 设计点数 ${total} 超过上限 ${MAX_DESIGN_POINTS}`);
  const points: Array<Map<string, number>> = [new Map()];
  for (const factor of factors) {
    const next: Array<Map<string, number>> = [];
    for (const prefix of points) {
      for (const value of factor.values) next.push(new Map([...prefix, [factor.id, value]]));
    }
    points.length = 0;
    points.push(...next);
  }
  return points;
}

/** 确定性 LHS:每因子按 seed 驱动的置换分配层,层内抖动;禁止 Math.random。 */
function lhsPoints(factors: readonly PlantExperimentFactor[], spec: PlantExperimentDesignSpec): PlantExperimentDesignPoint[] {
  const levels = spec.levels ?? DEFAULT_LHS_LEVELS;
  if (!Number.isSafeInteger(levels) || levels < 2 || levels > MAX_LHS_LEVELS) {
    throw new RangeError(`LHS levels must be 2..${MAX_LHS_LEVELS}`);
  }
  const random = new Random(seedNumber(spec.seed ?? DEFAULT_LHS_SEED));
  const strata = factors.map((factor) => shuffledStrata(levels, random));
  const params: PlantExperimentDesignPoint[] = [];
  for (let index = 0; index < levels; index += 1) {
    const point: Record<string, number> = {};
    factors.forEach((factor, factorIndex) => {
      point[factor.id] = lhsValue(factor, strata[factorIndex]![index]!, levels, random);
    });
    params.push({ index, params: point });
  }
  return params;
}

function shuffledStrata(levels: number, random: Random): number[] {
  const strata = Array.from({ length: levels }, (_, index) => index);
  for (let index = levels - 1; index > 0; index -= 1) {
    const swap = Math.floor(random.next() * (index + 1));
    [strata[index], strata[swap]] = [strata[swap]!, strata[index]!];
  }
  return strata;
}

function lhsValue(factor: PlantExperimentFactor, stratum: number, levels: number, random: Random): number {
  const minimum = Math.min(...factor.values);
  const maximum = Math.max(...factor.values);
  if (maximum === minimum) return minimum;
  const width = (maximum - minimum) / levels;
  const jitter = LHS_STRATUM_MARGIN + random.next() * (1 - 2 * LHS_STRATUM_MARGIN);
  const rounded = Math.round((minimum + (stratum + jitter) * width) * 1e6) / 1e6;
  // 四舍五入可能越过层边界;压回本层内侧,保证层覆盖检验(每层恰一点)稳定成立。
  return Math.min(
    Math.max(rounded, minimum + (stratum + LHS_STRATUM_MARGIN) * width),
    minimum + (stratum + 1 - LHS_STRATUM_MARGIN) * width,
  );
}
