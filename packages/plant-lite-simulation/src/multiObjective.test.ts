/**
 * 多目标优化断言:已知双目标权衡(吞吐 ↑ ↔ 能耗成本 ↓,工时/需求率为旋钮)、
 * 前沿非支配性(前沿上无互配对支配)、历史方向感知最优单调改进、
 * 同 seed 双跑逐位一致、目标值/配置/基因越界拒绝。
 * 数字口径:480/60 分钟窗口(测量 420 分钟),replications 见各用例;全部随机走 seed 派生。
 * 诚实边界:内核 station 单件加工,设备数不影响吞吐(纯成本轴),故旋钮取工时与需求率。
 */

import { describe, expect, it } from "vitest";
import type { MultiObjectiveConfig, MultiObjectiveSolution, MultiObjectiveTarget, PlantExperimentFactor } from "@bim-studio/contracts";
import { MultiObjectiveOptimizer, readObjectiveVector, targetName } from "./multiObjective.js";
import { runPlantLiteExperiment } from "./engine.js";
import { validateGenes } from "./geneticOptimizer.js";
import type { PlantLiteExperimentResult, PlantLiteModel } from "./model.js";

const LIMITS = { durationMinutes: 480, warmupMinutes: 60 } as const;
const THROUGHPUT = "confidence95.throughputPerHour.mean";
const ENERGY = "energy95.totalEnergyKwh.mean";

/**
 * 已知权衡单线(可手算):产能上限 = 60/工时;吞吐靠“需求逼近产能”或“压低工时”
 * 换取,但机器占用率随之上升 → 运行能耗上升。
 * 手算锚点(测量窗口 7h):来料 1.0/工时 0.6 → 忙 0.6 台、闲 0.4 台
 * → 吞吐 60、能耗 0.6×80×7 + 0.4×60×7 = 504 kWh;
 * 来料 0.6/工时 0.6 → 吞吐 100(产能上限)、满忙 → 能耗 560 kWh。
 * (100,560) 与 (60,504) 互不支配:吞吐必须付出能耗代价 —— 已知双目标权衡。
 */
function tradeoffLine(): PlantLiteModel {
  return {
    id: "mo-tradeoff-line",
    name: "多目标 · 吞吐-能耗权衡线",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1.0 } },
      { id: "buf", name: "线前缓存", kind: "queue-buffer", capacity: 16 },
      { id: "st", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: 1.2 }, resourceId: "mc" },
      { id: "snk", name: "出货", kind: "sink" },
    ],
    edges: [
      { id: "e1", from: "src", to: "buf" },
      { id: "e2", from: "buf", to: "st" },
      { id: "e3", from: "st", to: "snk" },
    ],
    resources: [{
      id: "mc",
      name: "机床",
      kind: "equipment",
      capacity: 1,
      power: { activePowerKw: 80, idlePowerKw: 60 },
    }],
    energyEconomics: { electricityPricePerKwh: 1, carbonEmissionFactorKgPerKwh: 0.5 },
  };
}

const setStationMinutes = (model: PlantLiteModel, value: number): void => {
  const node = model.nodes.find((candidate) => candidate.id === "st");
  if (!node || node.kind !== "station") throw new Error("station st 不存在");
  node.processingTime = { kind: "deterministic", value };
};
const setSourceInterval = (model: PlantLiteModel, value: number): void => {
  const node = model.nodes.find((candidate) => candidate.id === "src");
  if (!node || node.kind !== "source") throw new Error("source src 不存在");
  node.interarrivalTime = { kind: "deterministic", value };
};

const factors: PlantExperimentFactor[] = [
  { id: "st-min", label: "工位工时", values: [0.6, 1.6], apply: setStationMinutes },
  { id: "src-arr", label: "来料间隔", values: [0.6, 1.2], apply: setSourceInterval },
];
const targets = [
  { metricPath: THROUGHPUT, goal: "maximize", label: "throughput" },
  { metricPath: ENERGY, goal: "minimize", label: "energy" },
] as const satisfies readonly MultiObjectiveTarget[];
const config: MultiObjectiveConfig = {
  targets: [...targets] as MultiObjectiveConfig["targets"],
  populationSize: 16,
  generations: 8,
  crossoverRate: 0.9,
  mutationRate: 0.3,
  seed: "mo-tradeoff-2026-09-26",
  replications: 2,
  limits: LIMITS,
};

/** 支配判定(left 是否支配 right),与实现的变换空间语义一致。 */
function dominates(left: MultiObjectiveSolution, right: MultiObjectiveSolution): boolean {
  const better = (a: number, b: number, goal: string) => (goal === "maximize" ? a > b : a < b);
  const equalOrBetter = (a: number, b: number, goal: string) => (goal === "maximize" ? a >= b : a <= b);
  let strictly = false;
  for (const target of targets) {
    const a = left.objectives[targetName(target)]!;
    const b = right.objectives[targetName(target)]!;
    if (!equalOrBetter(a, b, target.goal)) return false;
    if (better(a, b, target.goal)) strictly = true;
  }
  return strictly;
}

describe("多目标 Pareto 前沿", () => {
  it("权衡问题得到非支配前沿:前沿上无互配对支配,基因全部落在因子值域内", () => {
    const result = new MultiObjectiveOptimizer(config, factors, tradeoffLine()).optimize();
    expect(result.generations).toBe(8);
    expect(result.history).toHaveLength(8);
    expect(result.evaluations).toBe(16 * 8);
    expect(result.targetNames).toEqual(["throughput", "energy"]);
    // 实测前沿 15 点(种子锁定),无重复解(相同解互不支配,不去重会重复入前沿)。
    expect(result.paretoFront.length).toBeGreaterThanOrEqual(10);
    expect(new Set(result.paretoFront.map((solution) => solution.fingerprint)).size).toBe(result.paretoFront.length);
    for (let i = 0; i < result.paretoFront.length; i += 1) {
      for (let j = i + 1; j < result.paretoFront.length; j += 1) {
        expect(dominates(result.paretoFront[i]!, result.paretoFront[j]!)).toBe(false);
        expect(dominates(result.paretoFront[j]!, result.paretoFront[i]!)).toBe(false);
      }
      validateGenes(factors, result.paretoFront[i]!.genes);
      expect(Object.keys(result.paretoFront[i]!.objectives).sort()).toEqual(["energy", "throughput"]);
      // 前沿成员秩恒为 1。
      expect(result.paretoFront[i]!.rank).toBe(1);
    }
    // 前沿两端有真实梯度:高吞吐端逼近产能上限,能耗跨度 ≥30 kWh(利用率换能耗)。
    const energyAxis = result.paretoFront.map((solution) => solution.objectives.energy!);
    const throughputAxis = result.paretoFront.map((solution) => solution.objectives.throughput!);
    expect(Math.max(...throughputAxis)).toBeGreaterThanOrEqual(90);
    expect(Math.max(...throughputAxis)).toBeLessThanOrEqual(100);
    expect(Math.min(...throughputAxis)).toBeLessThanOrEqual(60);
    expect(Math.max(...energyAxis) - Math.min(...energyAxis)).toBeGreaterThanOrEqual(30);
    // 黄金锁定:前沿按输出序首点(吞吐最高端)指纹前 8 位;基因/种子/结果任一漂移即变。
    expect(result.paretoFront[0]!.fingerprint.slice(0, 8)).toBe("87084868");
  });

  it("手算对拍:锚点工况(来料 1.0/工时 0.6)的吞吐与能耗与解析值一致", () => {
    // 解析:忙 0.6 台 → 0.6×80kW×7h = 336;闲 0.4 台 → 0.4×60kW×7h = 168;合计 504 kWh。
    const anchor = tradeoffLine();
    setStationMinutes(anchor, 0.6);
    const result = runPlantLiteExperiment({ model: anchor, seed: "mo-tradeoff-2026-09-26", replications: 2, limits: LIMITS });
    expect(result.confidence95.throughputPerHour.mean).toBeCloseTo(60, 9);
    const energy = readObjectiveVector([...targets], result)[1]!;
    expect(energy).toBeCloseTo(504, 6);
  });

  it("历史方向感知最优单调改进:吞吐不降、能耗不增(精英保留)", () => {
    const result = new MultiObjectiveOptimizer(config, factors, tradeoffLine()).optimize();
    for (let index = 1; index < result.history.length; index += 1) {
      const previous = result.history[index - 1]!;
      const current = result.history[index]!;
      expect(current.bestByTarget.throughput!).toBeGreaterThanOrEqual(previous.bestByTarget.throughput! - 1e-9);
      expect(current.bestByTarget.energy!).toBeLessThanOrEqual(previous.bestByTarget.energy! + 1e-9);
    }
    expect(result.history[0]!.frontSize).toBeGreaterThan(0);
  });

  it("同 seed 双跑逐位一致(含前沿、历史与评估数);异 seed 漂移", () => {
    const first = new MultiObjectiveOptimizer(config, factors, tradeoffLine()).optimize();
    const second = new MultiObjectiveOptimizer(config, factors, tradeoffLine()).optimize();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const drifted = new MultiObjectiveOptimizer({ ...config, seed: "mo-tradeoff-drift" }, factors, tradeoffLine()).optimize();
    expect(JSON.stringify(drifted)).not.toBe(JSON.stringify(first));
  });
});

describe("多目标拒绝非法输入", () => {
  it("目标数不足、目标名重复、方向非法、种群过小、概率出界全部拒绝", () => {
    const base: MultiObjectiveConfig = { ...config };
    expect(() => new MultiObjectiveOptimizer(
      { ...base, targets: [targets[0]!] as unknown as MultiObjectiveConfig["targets"] },
      factors,
      tradeoffLine(),
    )).toThrow(/至少需要 2 个目标/);
    expect(() => new MultiObjectiveOptimizer(
      { ...base, targets: [targets[0]!, { ...targets[0]!, goal: "minimize" }] as MultiObjectiveConfig["targets"] },
      factors,
      tradeoffLine(),
    )).toThrow(/目标名重复/);
    expect(() => new MultiObjectiveOptimizer(
      { ...base, targets: [targets[0]!, { ...targets[1]!, goal: "ascent" }] as MultiObjectiveConfig["targets"] },
      factors,
      tradeoffLine(),
    )).toThrow(/未知优化目标/);
    expect(() => new MultiObjectiveOptimizer({ ...base, populationSize: 3 }, factors, tradeoffLine())).toThrow(/populationSize/);
    expect(() => new MultiObjectiveOptimizer({ ...base, crossoverRate: 1.2 }, factors, tradeoffLine())).toThrow(/crossoverRate/);
    expect(() => new MultiObjectiveOptimizer({ ...base, mutationRate: -0.1 }, factors, tradeoffLine())).toThrow(/mutationRate/);
  });

  it("目标值越界拒绝:指标路径缺失或非有限值立即抛错,基因越出值域拒绝", () => {
    const fake = {
      confidence95: { throughputPerHour: { mean: 10 } },
      energy95: { totalEnergyKwh: { mean: Number.POSITIVE_INFINITY } },
    } as unknown as PlantLiteExperimentResult;
    expect(() => readObjectiveVector([...targets], fake)).toThrow(/不是有限数值/);
    expect(() => readObjectiveVector([{ ...targets[0]!, metricPath: "confidence95.missing.mean" }], fake)).toThrow(/指标路径不存在/);
    expect(() => validateGenes(factors, { "st-min": 0.6, "src-arr": 1.3 })).toThrow(/越出因子值域/);
    expect(() => validateGenes(factors, { "st-min": Number.NaN, "src-arr": 1 })).toThrow(/有限数值/);
    expect(readObjectiveVector([...targets], {
      confidence95: { throughputPerHour: { mean: 10 } },
      energy95: { totalEnergyKwh: { mean: 5 } },
    } as unknown as PlantLiteExperimentResult)).toEqual([10, 5]);
  });
});
