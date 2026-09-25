/**
 * 实验矩阵分析断言:敏感性方向、Welch t + Hedges' g 的已知值校准、top-k 排序可复现。
 * 已知值校准用教科书数字:t=4、df=8 双侧 p=0.0039498(200 万区间 Simpson 数值积分裁定);
 * 构造均值差远大于噪声的两组与重叠两组,分别校准"显著"与"不显著"两侧。
 */

import { describe, expect, it } from "vitest";
import type { PlantExperimentFactor } from "@bim-studio/contracts";
import { runExperimentMatrix, type PlantExperimentPointRecord, type PlantExperimentRunSpec } from "./experimentDesign.js";
import { analyzeSensitivity, candidateInputs, comparePoints, rankPoints, readMetricPath } from "./experimentAnalysis.js";
import { golden13ExperimentMatrix } from "./golden/goldenModels.js";
import type { PlantLiteExperimentResult, PlantLiteModel } from "./model.js";

const SEED = "golden-2026-09-25";
const RUN: PlantExperimentRunSpec = { seed: SEED, replications: 5, limits: { durationMinutes: 480, warmupMinutes: 60 } };

function analysisLine(): PlantLiteModel {
  return {
    id: "experiment-analysis-line",
    name: "实验分析 · 单线",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.5 } },
      { id: "buf", name: "线前缓存", kind: "queue-buffer", capacity: 16 },
      { id: "st", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: 0.95 }, resourceId: "mc" },
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

const minutesFactor: PlantExperimentFactor = {
  id: "st-min",
  label: "工位工时",
  values: [0.6, 0.95, 1.4],
  apply: (model, value) => {
    const node = model.nodes.find((candidate) => candidate.id === "st");
    if (!node || node.kind !== "station") throw new Error("station st 不存在");
    node.processingTime = { kind: "deterministic", value };
  },
};

const capacityFactor: PlantExperimentFactor = {
  id: "buf-cap",
  label: "线前缓存",
  values: [1, 4, 16, 64],
  apply: (model, value) => {
    const node = model.nodes.find((candidate) => candidate.id === "buf");
    if (!node || (node.kind !== "buffer" && node.kind !== "queue-buffer")) throw new Error("buffer buf 不存在");
    node.capacity = value;
  },
};

/** 合成实验点:直接注入每 replication 的样本值,用于教科书数字校准。 */
function fakeRecord(index: number, params: Record<string, number>, samples: number[]): PlantExperimentPointRecord {
  const result = {
    engineId: "plant-lite-des",
    engineVersion: "1.0.0",
    deterministic: true,
    seed: "fake",
    replications: samples.map((throughputPerHour, replication) => ({
      replication,
      seed: 1000 + replication,
      termination: "completed",
      throughputPerHour,
    })),
  } as unknown as PlantLiteExperimentResult;
  return { point: { index, params }, fingerprint: `fake-${index}`, result };
}

const stbFactor: PlantExperimentFactor = {
  id: "stb-min",
  label: "后段工时",
  values: [0.9, 1.05, 1.2],
  apply: (model, value) => {
    const node = model.nodes.find((candidate) => candidate.id === "st-b");
    if (!node || node.kind !== "station") throw new Error("station st-b 不存在");
    node.processingTime = { kind: "deterministic", value };
  },
};

const golden13Factors = [
  stbFactor,
  {
    id: "buf-cap",
    label: "线间缓存",
    values: [2, 8, 32],
    apply: (model: PlantLiteModel, value: number) => {
      const node = model.nodes.find((candidate) => candidate.id === "buf");
      if (!node || (node.kind !== "buffer" && node.kind !== "queue-buffer")) throw new Error("buffer buf 不存在");
      node.capacity = value;
    },
  },
];

describe("指标路径读取", () => {
  const record = fakeRecord(0, {}, [1]);

  it("按点分路径读取嵌套数值,缺失或非数值立即抛错", () => {
    expect(readMetricPath(record.result, "replications.0.throughputPerHour")).toBe(1);
    expect(() => readMetricPath(record.result, "confidence95.missing.mean")).toThrow(/指标路径不存在/);
    expect(() => readMetricPath(record.result, "engineId")).toThrow(/不是有限数值/);
  });
});

describe("敏感性筛查", () => {
  const minutesMatrix = runExperimentMatrix(analysisLine(), [minutesFactor], { kind: "sweep" }, RUN);
  const capacityMatrix = runExperimentMatrix(analysisLine(), [capacityFactor], { kind: "sweep" }, RUN);

  it("工时增大 → 吞吐强单调下降(实测 100 / 63.16 / 42.86)", () => {
    const report = analyzeSensitivity(minutesMatrix.points, [minutesFactor], "confidence95.throughputPerHour.mean");
    const factor = report.factors[0]!;
    expect(factor.direction).toBe("decreasing");
    expect(factor.strength).toBe("strong");
    expect(factor.spearman).toBe(-1);
    // 3 个水平的吞吐=60/t 呈双曲线,有限点下 Pearson 真值即约 -0.972,不是 -1。
    expect(factor.pearson).toBeLessThan(-0.95);
    const levels = minutesMatrix.points.map((record) => record.result.confidence95.throughputPerHour.mean);
    expect(levels[0]).toBeGreaterThan(95);
    expect(levels[1]).toBeGreaterThan(61);
    expect(levels[1]).toBeLessThan(65);
    expect(levels[2]).toBeGreaterThan(41);
    expect(levels[2]).toBeLessThan(45);
  });

  it("缓存增大 → 吞吐不变(非降),但缓存水位强单调上升", () => {
    const throughput = analyzeSensitivity(capacityMatrix.points, [capacityFactor], "confidence95.throughputPerHour.mean").factors[0]!;
    expect(throughput.direction).toBe("none");
    const queue = analyzeSensitivity(capacityMatrix.points, [capacityFactor], "nodeMetrics95.buf.averageQueueLength.mean").factors[0]!;
    expect(queue.direction).toBe("increasing");
    expect(queue.strength).toBe("strong");
    expect(queue.spearman).toBe(1);
  });

  it("设计点不足或因子取值恒定时直接拒绝", () => {
    expect(() => analyzeSensitivity(minutesMatrix.points.slice(0, 2), [minutesFactor], "confidence95.throughputPerHour.mean")).toThrow(/至少需要 3 个设计点/);
    const flatRecords = [0, 1, 2].map((index) => fakeRecord(index, { flat: 5 }, [10 + index, 12 + index]));
    const flat: PlantExperimentFactor = { id: "flat", label: "flat", values: [5], apply: () => {} };
    expect(() => analyzeSensitivity(flatRecords, [flat], "replications.0.throughputPerHour")).toThrow(/取值相同/);
  });
});

describe("显著性(Welch t + Hedges' g)", () => {
  it("教科书数字校准:差 8、噪声 sd 2.83、n=5 → t=4、df=8、p=0.0039498、g=2.285", () => {
    const a = fakeRecord(0, { x: 1 }, [10, 12, 14, 16, 18]);
    const b = fakeRecord(1, { x: 2 }, [2, 4, 6, 8, 10]);
    const comparison = comparePoints(a, b, "throughputPerHour");
    expect(comparison.welchT).toBeCloseTo(4, 6);
    expect(comparison.degreesOfFreedom).toBeCloseTo(8, 6);
    expect(comparison.pValue).toBeCloseTo(0.0039498, 6);
    expect(comparison.hedgesG).toBeCloseTo(2.2847, 3);
    expect(comparison.gLower95).toBeLessThan(comparison.hedgesG);
    expect(comparison.gUpper95).toBeGreaterThan(comparison.hedgesG);
    expect(comparison.pairedSeeds).toBe(true);
  });

  it("重叠样本:均值差落在噪声内 → p > 0.05", () => {
    const a = fakeRecord(0, { x: 1 }, [1, 2, 3, 4, 5]);
    const b = fakeRecord(1, { x: 2 }, [1.1, 2.1, 3.1, 4.1, 5.1]);
    expect(comparePoints(a, b, "throughputPerHour").pValue).toBeGreaterThan(0.05);
  });

  it("完全相同两组(CRN 同点):零方差守卫给出 p=1、g=0", () => {
    const a = fakeRecord(0, { x: 1 }, [10, 12, 14, 16, 18]);
    const comparison = comparePoints(a, a, "throughputPerHour");
    expect(comparison.pValue).toBe(1);
    expect(comparison.hedgesG).toBe(0);
    expect(comparison.pairedSeeds).toBe(true);
  });

  it("golden-13 实测两端:均值差远大于噪声 → p<0.05 且 |g|>0.8", () => {
    const matrix = runExperimentMatrix(golden13ExperimentMatrix(), golden13Factors, { kind: "grid" }, RUN);
    const pick = (stb: number, cap: number) => matrix.points.find((record) => record.point.params["stb-min"] === stb && record.point.params["buf-cap"] === cap)!;
    const fast = pick(0.9, 32);
    const slow = pick(1.2, 32);
    const comparison = comparePoints(fast, slow, "throughputPerHour");
    expect(comparison.difference).toBeGreaterThan(15);
    expect(comparison.pValue).toBeLessThan(0.05);
    expect(Math.abs(comparison.hedgesG)).toBeGreaterThan(0.8);
    expect(comparison.pairedSeeds).toBe(true);
  });
});

describe("最优候选排序", () => {
  const matrix = runExperimentMatrix(golden13ExperimentMatrix(), golden13Factors, { kind: "grid" }, RUN);

  it("按吞吐最大化排序:前三名全部是 0.9 行,破平按点序号,指标随条目返回", () => {
    const ranking = rankPoints(matrix.points, { metricPath: "confidence95.throughputPerHour.mean", goal: "maximize", k: 3 });
    expect(ranking.goal).toBe("maximize");
    expect(ranking.entries.map((entry) => entry.params["stb-min"])).toEqual([0.9, 0.9, 0.9]);
    expect(ranking.entries.map((entry) => entry.index)).toEqual([0, 1, 2]);
    for (const entry of ranking.entries) {
      expect(entry.metric).toBeCloseTo(66.6286, 3);
      expect(entry.fingerprint).toBe(matrix.points[entry.index]!.fingerprint);
    }
  });

  it("按缓存水位最小化排序:目标方向翻转会改变第一名", () => {
    const least = rankPoints(matrix.points, { metricPath: "nodeMetrics95.buf.averageQueueLength.mean", goal: "minimize", k: 1 }).entries[0]!;
    expect(least.params).toEqual({ "stb-min": 0.9, "buf-cap": 2 });
    const most = rankPoints(matrix.points, { metricPath: "nodeMetrics95.buf.averageQueueLength.mean", goal: "maximize", k: 1 }).entries[0]!;
    expect(most.params).toEqual({ "stb-min": 1.2, "buf-cap": 32 });
  });

  it("candidateInputs 还原完整可复现输入:模型携带参数值且基准模型未被改写", () => {
    const ranking = rankPoints(matrix.points, { metricPath: "confidence95.throughputPerHour.mean", goal: "maximize", k: 1 });
    const baseline = JSON.stringify(golden13ExperimentMatrix());
    const [candidate] = candidateInputs(ranking, golden13Factors, golden13ExperimentMatrix());
    const stb = candidate!.model.nodes.find((node) => node.id === "st-b");
    const buf = candidate!.model.nodes.find((node) => node.id === "buf");
    expect(stb?.kind === "station" && stb.processingTime.value).toBe(0.9);
    expect(buf?.kind !== "sink" && buf!.capacity).toBe(2);
    expect(JSON.stringify(golden13ExperimentMatrix())).toBe(baseline);
  });
});
