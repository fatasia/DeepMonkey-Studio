/**
 * 实验矩阵断言:grid/sweep/LHS 设计生成、CRN 指纹可比、golden-13 黄金锁定。
 * 数字口径:seed=golden-2026-09-25、replications=5、480/60 分钟窗口,与探针实测一致;
 * 黄金指纹锁死回归,任何内核统计语义改动都会在此暴露。
 */

import { describe, expect, it } from "vitest";
import type { PlantExperimentFactor } from "@bim-studio/contracts";
import { buildDesignPoints, buildPointModel, experimentPointFingerprint, runExperimentMatrix, type PlantExperimentRunSpec } from "./experimentDesign.js";
import { runPlantLiteExperiment } from "./engine.js";
import type { PlantLiteModel } from "./model.js";
import { golden13ExperimentMatrix } from "./golden/goldenModels.js";

const SEED = "golden-2026-09-25";
const RUN: PlantExperimentRunSpec = { seed: SEED, replications: 5, limits: { durationMinutes: 480, warmupMinutes: 60 } };

/** 单线扫描基准:来料 0.5 分钟 → 线前缓存 → 限速工位 → 出货。 */
function sweepLine(): PlantLiteModel {
  return {
    id: "experiment-sweep-line",
    name: "实验矩阵 · 单线扫描",
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

const setStationMinutes = (nodeId: string) => (model: PlantLiteModel, value: number) => {
  const node = model.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.kind !== "station") throw new Error(`station ${nodeId} 不存在`);
  node.processingTime = { kind: "deterministic", value };
};

const setBufferCapacity = (nodeId: string) => (model: PlantLiteModel, value: number) => {
  const node = model.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || (node.kind !== "buffer" && node.kind !== "queue-buffer")) throw new Error(`buffer ${nodeId} 不存在`);
  node.capacity = value;
};

const capacityFactor: PlantExperimentFactor = { id: "buf-cap", label: "线前缓存", values: [1, 4, 16, 64], apply: setBufferCapacity("buf") };
const minutesFactor: PlantExperimentFactor = { id: "st-min", label: "工位工时", values: [0.6, 0.95, 1.4], apply: setStationMinutes("st") };

describe("设计生成", () => {
  it("sweep:单因子逐水平、其余因子停在基线水平", () => {
    const points = buildDesignPoints([capacityFactor, minutesFactor], { kind: "sweep" });
    // 基线 = values[0]:前四点扫 buf-cap(st-min 停在 0.6),后三点扫 st-min(buf-cap 停在基线 1)。
    expect(points.map((point) => point.params["buf-cap"])).toEqual([1, 4, 16, 64, 1, 1, 1]);
    expect(points.map((point) => point.params["st-min"])).toEqual([0.6, 0.6, 0.6, 0.6, 0.6, 0.95, 1.4]);
  });

  it("grid:3 工时×4 缓存按行主序展开 12 个设计点,首因子最慢", () => {
    const points = buildDesignPoints([minutesFactor, capacityFactor], { kind: "grid" });
    expect(points).toHaveLength(12);
    expect(points.map((point) => point.index)).toEqual([...Array(12).keys()]);
    expect(points[0]!.params).toEqual({ "st-min": 0.6, "buf-cap": 1 });
    expect(points[3]!.params).toEqual({ "st-min": 0.6, "buf-cap": 64 });
    expect(points[11]!.params).toEqual({ "st-min": 1.4, "buf-cap": 64 });
  });

  it("grid 设计点数超过上限立即拒绝", () => {
    const make = (id: string): PlantExperimentFactor => ({ id, label: id, values: Array.from({ length: 11 }, (_, index) => index + 1), apply: () => {} });
    expect(() => buildDesignPoints([make("a"), make("b"), make("c")], { kind: "grid" })).toThrow(RangeError);
  });

  it("LHS:每层恰好一点、全部落在因子值域内", () => {
    const points = buildDesignPoints([minutesFactor, capacityFactor], { kind: "random", levels: 8, seed: "lhs-uniform" });
    expect(points).toHaveLength(8);
    for (const factor of [minutesFactor, capacityFactor]) {
      const low = Math.min(...factor.values);
      const high = Math.max(...factor.values);
      const width = (high - low) / 8;
      const strata = points.map((point) => Math.floor((point.params[factor.id]! - low) / width));
      expect(new Set(strata)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
      for (const point of points) {
        expect(point.params[factor.id]!).toBeGreaterThanOrEqual(low);
        expect(point.params[factor.id]!).toBeLessThanOrEqual(high);
      }
    }
  });

  it("LHS:同 seed 双跑设计矩阵逐位一致,换 seed 即漂移", () => {
    const first = buildDesignPoints([minutesFactor, capacityFactor], { kind: "random", levels: 8, seed: "lhs-det" });
    const second = buildDesignPoints([minutesFactor, capacityFactor], { kind: "random", levels: 8, seed: "lhs-det" });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    const other = buildDesignPoints([minutesFactor, capacityFactor], { kind: "random", levels: 8, seed: "lhs-other" });
    const differs = first.some((point, index) => JSON.stringify(point.params) !== JSON.stringify(other[index]!.params));
    expect(differs).toBe(true);
  });
});

describe("运行矩阵与共同随机数", () => {
  it("每点深拷贝基准模型后 apply,基准模型不被改写", () => {
    const baseline = JSON.stringify(sweepLine());
    const matrix = runExperimentMatrix(sweepLine(), [capacityFactor], { kind: "sweep" }, RUN);
    expect(matrix.points).toHaveLength(4);
    expect(JSON.stringify(sweepLine())).toBe(baseline);
    // 同一点重建模型必须逐位复现(容量确实被写入克隆体,而非改写基准)。
    const rebuilt = JSON.stringify(buildPointModel(sweepLine(), [capacityFactor], { "buf-cap": 16 }));
    expect(JSON.stringify(buildPointModel(sweepLine(), [capacityFactor], { "buf-cap": 16 }))).toBe(rebuilt);
    expect(JSON.parse(rebuilt).nodes.find((node: { id: string }) => node.id === "buf").capacity).toBe(16);
  });

  it("LHS 设计点可端到端运行且全部确定性完成", () => {
    const factors: PlantExperimentFactor[] = [
      { id: "st-min", label: "工位工时", values: [0.6, 1.4], apply: setStationMinutes("st") },
      { id: "stb-min", label: "二站工时", values: [0.5, 1.3], apply: setStationMinutes("st-b") },
    ];
    const line: PlantLiteModel = {
      ...sweepLine(),
      id: "experiment-lhs-line",
      nodes: [
        ...sweepLine().nodes.filter((node) => node.id !== "snk"),
        { id: "st-b", name: "二站", kind: "station", processingTime: { kind: "deterministic", value: 0.8 }, resourceId: "mc-b" },
        { id: "snk-b", name: "出货", kind: "sink" },
      ],
      edges: [...sweepLine().edges.filter((edge) => edge.to !== "snk"), { id: "e4", from: "st", to: "st-b" }, { id: "e5", from: "st-b", to: "snk-b" }],
      resources: [...sweepLine().resources ?? [], { id: "mc-b", name: "机床 B", kind: "equipment", capacity: 1 }],
    };
    const matrix = runExperimentMatrix(line, factors, { kind: "random", levels: 6, seed: "lhs-run" }, {
      seed: SEED, replications: 3, limits: { durationMinutes: 240, warmupMinutes: 30 },
    });
    expect(matrix.points).toHaveLength(6);
    for (const record of matrix.points) {
      expect(record.result.replications).toHaveLength(3);
      for (const replication of record.result.replications) {
        expect(replication.termination).toBe("completed");
        expect(replication.throughputPerHour).toBeGreaterThan(0);
      }
    }
  });

  it("CRN:同点同 seed 的结果与直接 runPlantLiteExperiment 指纹一致,各点 replication 种子逐位相同", () => {
    const matrix = runExperimentMatrix(sweepLine(), [capacityFactor], { kind: "sweep" }, RUN);
    const [first, second] = matrix.points;
    for (const record of matrix.points) {
      const direct = runPlantLiteExperiment({
        model: buildPointModel(sweepLine(), [capacityFactor], record.point.params),
        seed: RUN.seed,
        replications: RUN.replications,
        limits: { ...RUN.limits },
      });
      expect(record.fingerprint).toBe(experimentPointFingerprint(record.point.params, RUN.seed, direct));
    }
    expect(first!.result.replications.map((replication) => replication.seed))
      .toEqual(second!.result.replications.map((replication) => replication.seed));
  });

  it("buildPointModel:缺水平或非有限水平立即抛错", () => {
    expect(() => buildPointModel(sweepLine(), [capacityFactor], {})).toThrow(/buf-cap/);
    expect(() => buildPointModel(sweepLine(), [capacityFactor], { "buf-cap": Number.NaN })).toThrow(/buf-cap/);
  });
});

describe("golden-13 实验矩阵黄金锁定", () => {
  const stbFactor: PlantExperimentFactor = { id: "stb-min", label: "后段工时", values: [0.9, 1.05, 1.2], apply: setStationMinutes("st-b") };
  const bufferFactor: PlantExperimentFactor = { id: "buf-cap", label: "线间缓存", values: [2, 8, 32], apply: setBufferCapacity("buf") };
  const matrix = runExperimentMatrix(golden13ExperimentMatrix(), [stbFactor, bufferFactor], { kind: "grid" }, RUN);
  const throughput = (stb: number) => matrix.points
    .filter((record) => record.point.params["stb-min"] === stb)
    .map((record) => record.result.confidence95.throughputPerHour.mean);

  it("吞吐随后段工时强单调下降(实测 66.63 / 57.14 / 50.00)", () => {
    const row90 = throughput(0.9);
    const row105 = throughput(1.05);
    const row120 = throughput(1.2);
    expect(row90[0]).toBeGreaterThan(64);
    expect(row90[0]).toBeLessThan(69);
    expect(row105[0]).toBeGreaterThan(55);
    expect(row120[0]).toBeGreaterThan(48);
    expect(row120[0]).toBeLessThan(52);
    expect(row90[0]).toBeGreaterThan(row105[0]! + 5);
    expect(row105[0]!).toBeGreaterThan(row120[0]! + 5);
  });

  it("线间缓存不改变串联吞吐(工位产出池无界的内核语义),逐行严格相等", () => {
    for (const stb of [0.9, 1.05, 1.2]) {
      const row = throughput(stb);
      expect(row).toHaveLength(3);
      expect(row[0]).toBeCloseTo(row[1]!, 6);
      expect(row[1]).toBeCloseTo(row[2]!, 6);
    }
  });

  it("top-1 锁定 (stb 0.9, 缓存 2):并列由点序号破平,指纹前 8 位锁死", () => {
    const ranking = matrix.points;
    const fastest = ranking.filter((record) => record.point.params["stb-min"] === 0.9);
    expect(fastest).toHaveLength(3);
    const top = fastest[0]!;
    expect(top.point.index).toBe(0);
    expect(top.point.params).toEqual({ "stb-min": 0.9, "buf-cap": 2 });
    expect(top.fingerprint).toMatch(/^1311c5fd/);
  });
});
