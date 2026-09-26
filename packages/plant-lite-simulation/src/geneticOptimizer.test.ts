/**
 * 遗传优化试点断言:已知单峰收敛到界内最优、同 seed 历史逐位一致、
 * 越界基因与非法配置拒绝、golden-16 双因子优化指纹锁定。
 * 数字口径:seed 与 replications 见各用例,480/60 分钟窗口;
 * golden-16 是 GA 试点的黄金锁定样例,定义在 golden/golden16GeneticOptimization.ts(独立成文件,
 * 不占用 goldenModels.ts 的编号队列)。
 */

import { describe, expect, it } from "vitest";
import type { GeneticOptimizationConfig, PlantExperimentFactor } from "@bim-studio/contracts";
import { GeneticOptimizer, validateGenes } from "./geneticOptimizer.js";
import type { PlantLiteModel } from "./model.js";
import { golden16GeneticOptimization } from "./golden/golden16GeneticOptimization.js";

const LIMITS = { durationMinutes: 480, warmupMinutes: 60 } as const;
const METRIC = "confidence95.throughputPerHour.mean";

/** 单峰基准:golden-01 拓扑,来料 0.5 分钟让工位(而非来料)成为唯一瓶颈。 */
function unimodalLine(): PlantLiteModel {
  return {
    id: "ga-unimodal-line",
    name: "遗传优化 · 单峰单线",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.5 } },
      { id: "buf", name: "线前缓存", kind: "queue-buffer", capacity: 16 },
      { id: "st", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: 1.2 }, resourceId: "mc" },
      { id: "snk", name: "出货", kind: "sink" },
    ],
    edges: [
      { id: "e1", from: "src", to: "buf" },
      { id: "e2", from: "buf", to: "st" },
      { id: "e3", from: "st", to: "snk" },
    ],
    resources: [{ id: "mc", name: "机床", kind: "equipment", capacity: 1 }],
  };
}

const setStationMinutes = (model: PlantLiteModel, value: number): void => {
  const node = model.nodes.find((candidate) => candidate.id === "st");
  if (!node || node.kind !== "station") throw new Error("station st 不存在");
  node.processingTime = { kind: "deterministic", value };
};

describe("遗传优化收敛与确定性", () => {
  const unimodalFactors: PlantExperimentFactor[] = [
    { id: "st-min", label: "工位工时", values: [0.6, 2], apply: setStationMinutes },
  ];
  const config: GeneticOptimizationConfig = {
    metricPath: METRIC,
    goal: "maximize",
    populationSize: 10,
    generations: 8,
    crossoverRate: 0.9,
    mutationRate: 0.25,
    seed: "ga-unimodal-2026-09-26",
    replications: 3,
    limits: LIMITS,
  };

  it("单峰问题收敛到下界附近:工时越小米吞吐越高,最优落在界内", () => {
    const result = new GeneticOptimizer(config, unimodalFactors, unimodalLine()).optimize();
    expect(result.generations).toBe(8);
    expect(result.history).toHaveLength(8);
    // 精英个体直接保留不重评:每代新增评估 = 种群 - 精英数。
    expect(result.evaluations).toBe(10 + 7 * (10 - 1));
    // 理论最优:工时=0.6 → 100 件/小时;允许收敛在界内邻域。
    expect(result.best.genes["st-min"]).toBeLessThanOrEqual(0.65);
    expect(result.best.metricValue).toBeGreaterThan(99);
    // 最大化时历史 bestMetric 单调不减(精英保留的必然结果)。
    for (let index = 1; index < result.history.length; index += 1) {
      expect(result.history[index]!.bestMetric).toBeGreaterThanOrEqual(result.history[index - 1]!.bestMetric - 1e-9);
    }
  });

  it("同 seed 双跑:history 与 best.fingerprint 逐位一致;异 seed 则漂移", () => {
    const first = new GeneticOptimizer(config, unimodalFactors, unimodalLine()).optimize();
    const second = new GeneticOptimizer(config, unimodalFactors, unimodalLine()).optimize();
    expect(JSON.stringify(first.history)).toBe(JSON.stringify(second.history));
    expect(first.best.fingerprint).toBe(second.best.fingerprint);
    const drifted = new GeneticOptimizer({ ...config, seed: "ga-unimodal-drift" }, unimodalFactors, unimodalLine()).optimize();
    expect(drifted.best.fingerprint).not.toBe(first.best.fingerprint);
  });
});

describe("遗传优化拒绝非法输入", () => {
  const factors: PlantExperimentFactor[] = [
    { id: "st-min", label: "工位工时", values: [0.6, 2], apply: setStationMinutes },
  ];

  it("基因越出因子值域或非有限值直接拒绝", () => {
    expect(() => validateGenes(factors, { "st-min": 2.1 })).toThrow(/越出因子值域/);
    expect(() => validateGenes(factors, { "st-min": Number.NaN })).toThrow(/有限数值/);
    expect(() => validateGenes(factors, {})).toThrow(/有限数值/);
    expect(() => validateGenes(factors, { "st-min": 0.6 })).not.toThrow();
  });

  it("配置越界拒绝:种群过小、代数为零、概率出界、精英数≥种群", () => {
    const base: GeneticOptimizationConfig = {
      metricPath: METRIC,
      goal: "maximize",
      populationSize: 8,
      generations: 2,
      crossoverRate: 0.9,
      mutationRate: 0.2,
      seed: 7,
    };
    expect(() => new GeneticOptimizer({ ...base, populationSize: 1 }, factors, unimodalLine())).toThrow(/populationSize/);
    expect(() => new GeneticOptimizer({ ...base, generations: 0 }, factors, unimodalLine())).toThrow(/generations/);
    expect(() => new GeneticOptimizer({ ...base, crossoverRate: 1.5 }, factors, unimodalLine())).toThrow(/crossoverRate/);
    expect(() => new GeneticOptimizer({ ...base, mutationRate: -0.1 }, factors, unimodalLine())).toThrow(/mutationRate/);
    expect(() => new GeneticOptimizer({ ...base, eliteCount: 8 }, factors, unimodalLine())).toThrow(/eliteCount/);
    expect(() => new GeneticOptimizer(base, [{ ...factors[0]!, values: [1, Number.NaN] }], unimodalLine())).toThrow(/非有限数值/);
  });
});

describe("golden-16 双因子优化", () => {
  const bufCapacity = (model: PlantLiteModel, value: number): void => {
    const node = model.nodes.find((candidate) => candidate.id === "buf");
    if (!node || (node.kind !== "buffer" && node.kind !== "queue-buffer")) throw new Error("buffer buf 不存在");
    // 缓存容量是离散因子:实数基因经因子 apply 就地离散化为整数(因子自带离散化语义)。
    node.capacity = Math.round(value);
  };
  const factors: PlantExperimentFactor[] = [
    { id: "st-min", label: "工位工时", values: [0.6, 1.6], apply: setStationMinutes },
    { id: "buf-cap", label: "线前缓存", values: [1, 16], apply: bufCapacity },
  ];
  const config: GeneticOptimizationConfig = {
    metricPath: METRIC,
    goal: "maximize",
    populationSize: 10,
    generations: 6,
    crossoverRate: 0.9,
    mutationRate: 0.2,
    seed: "golden-16-ga-2026-09-26",
    replications: 3,
    limits: LIMITS,
  };

  it("2 因子进化收敛到工时下界邻域,最优解指纹前 8 位锁定", () => {
    const result = new GeneticOptimizer(config, factors, golden16GeneticOptimization()).optimize();
    expect(result.evaluations).toBe(10 + 5 * (10 - 1));
    expect(result.best.genes["st-min"]).toBeLessThanOrEqual(0.65);
    expect(result.best.genes["buf-cap"]).toBeGreaterThanOrEqual(1);
    expect(result.best.genes["buf-cap"]).toBeLessThanOrEqual(16);
    // 工时收敛到 0.6146 附近时,吞吐上限即 60/工时 ≈ 97.6/小时。
    expect(result.best.metricValue).toBeGreaterThan(96);
    // 黄金锁定:基因+种子+结果任一漂移都会改变该前缀。
    expect(result.best.fingerprint.slice(0, 8)).toBe("b8234274");
  });
});
