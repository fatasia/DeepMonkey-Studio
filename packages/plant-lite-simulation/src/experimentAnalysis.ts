/**
 * 实验矩阵分析(PS/PD/Plant 替代规格 5.4)。
 * 筛查层三件套:敏感性(pearson/spearman)、显著性(Welch t + Hedges' g)、最优候选排序。
 * 全部小样本自实现公式,不依赖内核 statistics.ts;也不提供响应面与贝叶斯优化。
 */

import {
  type PlantExperimentFactor,
  type PlantExperimentGoal,
  type PlantFactorSensitivity,
  type PlantPointComparison,
  type PlantPointRanking,
  type PlantPointRankingEntry,
  type PlantSensitivityReport,
} from "@bim-studio/contracts";
import { buildPointModel, type PlantExperimentPointRecord } from "./experimentDesign.js";
import type { PlantLiteModel } from "./model.js";

/** 按点分路径读取数值指标;路径缺失或非数值立即抛错,禁止静默 0。 */
export function readMetricPath(source: unknown, path: string): number {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object" || !(segment in (current as Record<string, unknown>))) {
      throw new Error(`指标路径不存在:${path}(停在 ${segment})`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current !== "number" || !Number.isFinite(current)) throw new Error(`指标路径 ${path} 不是有限数值`);
  return current;
}

/** 敏感性筛查:x=因子水平,y=每点指标;至少 3 个设计点才有意义。 */
export function analyzeSensitivity(
  records: readonly PlantExperimentPointRecord[],
  factors: readonly PlantExperimentFactor[],
  metricPath: string,
): PlantSensitivityReport {
  if (records.length < 3) throw new Error("敏感性分析至少需要 3 个设计点");
  const y = records.map((record) => readMetricPath(record.result, metricPath));
  return {
    metricPath,
    sampleCount: records.length,
    factors: factors.map((factor) => factorSensitivity(records, factor, y)),
  };
}

function factorSensitivity(records: readonly PlantExperimentPointRecord[], factor: PlantExperimentFactor, y: readonly number[]): PlantFactorSensitivity {
  const x = records.map((record) => {
    const value = record.point.params[factor.id];
    if (value === undefined) throw new Error(`设计点缺少因子 ${factor.id} 的水平值`);
    return value;
  });
  if (new Set(x).size === 1) throw new Error(`因子 ${factor.id} 在全部设计点上取值相同,相关性无定义`);
  // Spearman 并列秩修正:并列值取平均秩(中列秩),再按秩做 Pearson,即含并列秩的精确公式。
  const spearman = pearson(averageRanks(x), averageRanks(y));
  const magnitude = Math.abs(spearman);
  const strength = magnitude >= 0.8 ? "strong" : magnitude >= 0.5 ? "moderate" : magnitude >= 0.2 ? "weak" : "none";
  return {
    factorId: factor.id,
    label: factor.label,
    pearson: pearson(x, y),
    spearman,
    direction: strength === "none" ? "none" : spearman > 0 ? "increasing" : "decreasing",
    strength,
  };
}

/** 两设计点显著性;样本 = 两点全部已完成 replication 的同路径指标(CRN 下按序号配对)。 */
export function comparePoints(a: PlantExperimentPointRecord, b: PlantExperimentPointRecord, metricPath: string): PlantPointComparison {
  const completedSamples = (record: PlantExperimentPointRecord) =>
    record.result.replications.filter((replication) => replication.termination === "completed")
      .map((replication) => readMetricPath(replication, metricPath));
  const x = completedSamples(a);
  const y = completedSamples(b);
  if (x.length < 2 || y.length < 2) throw new Error("显著性比较每组至少需要 2 个已完成 replication");
  const pairedSeeds = a.result.replications.length === b.result.replications.length
    && a.result.replications.every((replication, index) => replication.seed === b.result.replications[index]?.seed);
  return welchComparison(x, y, pairedSeeds);
}

function welchComparison(x: readonly number[], y: readonly number[], pairedSeeds: boolean): PlantPointComparison {
  const n1 = x.length;
  const n2 = y.length;
  const meanA = mean(x);
  const meanB = mean(y);
  const difference = meanA - meanB;
  const v1 = sampleVariance(x);
  const v2 = sampleVariance(y);
  const standardErrorSquared = v1 / n1 + v2 / n2;
  if (standardErrorSquared === 0) {
    // CRN 下同点零方差是常态,不是除零事故;均值相等恒不显著,均值不等恒显著。
    const t = difference === 0 ? 0 : Math.sign(difference) * Infinity;
    return { meanA, meanB, difference, welchT: t, degreesOfFreedom: n1 + n2 - 2, pValue: difference === 0 ? 1 : 0, hedgesG: difference === 0 ? 0 : Math.sign(difference) * Infinity, gLower95: 0, gUpper95: 0, pairedSeeds };
  }
  const degreesOfFreedom = standardErrorSquared ** 2
    / ((v1 / n1) ** 2 / (n1 - 1) + (v2 / n2) ** 2 / (n2 - 1));
  const welchT = difference / Math.sqrt(standardErrorSquared);
  const pValue = studentTTwoSidedP(Math.abs(welchT), degreesOfFreedom);
  const pooled = Math.sqrt(((n1 - 1) * v1 + (n2 - 1) * v2) / (n1 + n2 - 2));
  const correction = 1 - 3 / (4 * (n1 + n2) - 9);
  const hedgesG = correction * difference / pooled;
  const standardErrorG = Math.sqrt((n1 + n2) / (n1 * n2) + hedgesG ** 2 / (2 * (n1 + n2 - 2)));
  const critical = tQuantile(0.975, degreesOfFreedom);
  return {
    meanA,
    meanB,
    difference,
    welchT,
    degreesOfFreedom,
    pValue,
    hedgesG,
    gLower95: hedgesG - critical * standardErrorG,
    gUpper95: hedgesG + critical * standardErrorG,
    pairedSeeds,
  };
}

/** 按指标路径与目标方向排序,返回前 k 个设计点;并列以点序号升序破平,保证确定性。 */
export function rankPoints(
  records: readonly PlantExperimentPointRecord[],
  options: { metricPath: string; goal: PlantExperimentGoal; k: number },
): PlantPointRanking {
  if (records.length === 0) throw new Error("排序至少需要 1 个设计点");
  if (!Number.isSafeInteger(options.k) || options.k < 1) throw new RangeError("k 必须为正整数");
  const entries: PlantPointRankingEntry[] = records
    .map((record) => ({ index: record.point.index, params: record.point.params, fingerprint: record.fingerprint, metric: readMetricPath(record.result, options.metricPath) }))
    .sort((left, right) => (options.goal === "maximize" ? right.metric - left.metric : left.metric - right.metric) || left.index - right.index)
    .slice(0, options.k);
  return { metricPath: options.metricPath, goal: options.goal, entries };
}

export interface PlantCandidateInput {
  index: number;
  params: Record<string, number>;
  /** 深拷贝基准模型并 apply 后的完整模型输入;与 run spec 一起即可逐位复现。 */
  model: PlantLiteModel;
}

/** 把排序条目还原成完整可复现输入(模型快照 + 运行种子/重复数由调用方持有)。 */
export function candidateInputs(
  ranking: PlantPointRanking,
  factors: readonly PlantExperimentFactor[],
  baseModel: PlantLiteModel,
): PlantCandidateInput[] {
  return ranking.entries.map((entry) => ({
    index: entry.index,
    params: entry.params,
    model: buildPointModel(baseModel, factors, entry.params),
  }));
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function sampleVariance(values: readonly number[]): number {
  const center = mean(values);
  return values.reduce((total, value) => total + (value - center) ** 2, 0) / (values.length - 1);
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const centerX = mean(x);
  const centerY = mean(y);
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index]! - centerX;
    const dy = y[index]! - centerY;
    covariance += dx * dy;
    varianceX += dx ** 2;
    varianceY += dy ** 2;
  }
  if (varianceX === 0 || varianceY === 0) return 0;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/** 并列值取平均秩(中列秩);这是 Spearman 含并列秩时的标准修正。 */
function averageRanks(values: readonly number[]): number[] {
  const order = values.map((value, index) => ({ value, index })).sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = new Array<number>(values.length);
  let start = 0;
  while (start < order.length) {
    let end = start;
    while (end + 1 < order.length && order[end + 1]!.value === order[start]!.value) end += 1;
    const average = (start + end) / 2 + 1;
    for (let position = start; position <= end; position += 1) ranks[order[position]!.index] = average;
    start = end + 1;
  }
  return ranks;
}

/** 双侧 p 值 = I_{df/(df+t²)}(df/2, 1/2);正则化不完全 Beta 用 Lentz 连分式。 */
function studentTTwoSidedP(t: number, degreesOfFreedom: number): number {
  if (!Number.isFinite(t)) return 0;
  return regularizedIncompleteBeta(degreesOfFreedom / 2, 0.5, degreesOfFreedom / (degreesOfFreedom + t * t));
}

/** t 分位数:CDF 关于 t 单调,对双侧 p 二分即可,80 次内收敛到机器精度。 */
function tQuantile(probability: number, degreesOfFreedom: number): number {
  let low = 0;
  let high = 1000;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (low + high) / 2;
    if (studentTTwoSidedP(middle, degreesOfFreedom) > 1 - probability) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

const LOG_GAMMA_COEFFICIENTS = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5] as const;

function logGamma(x: number): number {
  let series = 1.000000000190015;
  let y = x;
  for (const coefficient of LOG_GAMMA_COEFFICIENTS) series += coefficient / ++y;
  const temp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5);
  return -temp + Math.log(2.5066282746310005 * series / x);
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 300;
  const epsilon = 3e-14;
  const tiny = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return front * betaContinuedFraction(a, b, x) / a;
  return 1 - front * betaContinuedFraction(b, a, 1 - x) / b;
}
