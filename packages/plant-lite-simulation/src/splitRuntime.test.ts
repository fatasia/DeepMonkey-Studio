/**
 * Split 分流节点单测。
 * 覆盖:份额长程收敛、满载溢出兜底路、全满阻塞保件、校验失败族、同 seed 顺序确定性。
 */

import { describe, expect, it } from "vitest";
import type { PlantLiteModel } from "./modelTypes.js";
import { validatePlantLiteModel } from "./modelValidation.js";
import { runPlantLiteExperiment } from "./engine.js";

const LIMITS = { durationMinutes: 2_000, warmupMinutes: 0, maxEvents: 1_000_000, maxResources: 100 } as const;

function runModel(model: PlantLiteModel, seed: string | number = "split-test") {
  return runPlantLiteExperiment({ model, seed, replications: 1, limits: { ...LIMITS } });
}

function routeDeliveredOf(model: PlantLiteModel, result: ReturnType<typeof runModel>, nodeId: string) {
  const split = result.replications[0]?.nodes.find((node) => node.nodeId === nodeId);
  return new Map((split?.routeDelivered ?? []).map((route) => [route.to, route.items]));
}

describe("split 基本流", () => {
  it("60/40 份额长程收敛在 ±1% 且投递总数与完工数守恒", () => {
    const model: PlantLiteModel = {
      id: "split-shares",
      name: "份额分流",
      nodes: [
        { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
        { id: "div", name: "分流", kind: "split", routes: [{ to: "snk-a", share: 0.6 }, { to: "snk-b", share: 0.4 }] },
        { id: "snk-a", name: "出货 A", kind: "sink" },
        { id: "snk-b", name: "出货 B", kind: "sink" },
      ],
      edges: [{ id: "e1", from: "src", to: "div" }],
    };
    const result = runModel(model);
    const delivered = routeDeliveredOf(model, result, "div");
    const toA = delivered.get("snk-a") ?? 0;
    const toB = delivered.get("snk-b") ?? 0;
    expect(toA + toB).toBe(result.replications[0]?.completedItems);
    const shareA = toA / (toA + toB);
    expect(shareA).toBeGreaterThanOrEqual(0.59);
    expect(shareA).toBeLessThanOrEqual(0.61);
  });
});

describe("split 满载溢出", () => {
  it("份额目标满时按 priority 溢到兜底路,件数不丢失", () => {
    const model: PlantLiteModel = {
      id: "split-spill",
      name: "满载溢出",
      nodes: [
        { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.5 } },
        { id: "div", name: "分流", kind: "split", routes: [{ to: "cap", share: 1 }, { to: "snk-spill", priority: 1 }] },
        { id: "cap", name: "受限缓存", kind: "queue-buffer", capacity: 1 },
        { id: "slow", name: "慢工位", kind: "station", processingTime: { kind: "deterministic", value: 100 }, queueCapacity: 1 },
        { id: "snk-slow", name: "出货主线", kind: "sink" },
        { id: "snk-spill", name: "溢流出口", kind: "sink" },
      ],
      edges: [
        { id: "e1", from: "src", to: "div" },
        { id: "e2", from: "cap", to: "slow" },
        { id: "e3", from: "slow", to: "snk-slow" },
      ],
    };
    const result = runModel(model, "split-spill");
    const delivered = routeDeliveredOf(model, result, "div");
    expect(delivered.get("cap") ?? 0).toBeGreaterThanOrEqual(2);
    expect(delivered.get("snk-spill") ?? 0).toBeGreaterThan(100);
    // 溢流件直达 sink;cap 路在慢工位上至少完成 1 件,其余在制不超过 cap+slow 的 3 个槽位。
    const mainOutput = result.replications[0]?.completedItems ?? 0;
    expect(mainOutput).toBeGreaterThanOrEqual((delivered.get("snk-spill") ?? 0) + 1);
  });
});

describe("split 全满阻塞", () => {
  it("全部目标满时节点阻塞计时且不再投放,系统零完工", () => {
    const model: PlantLiteModel = {
      id: "split-blocked",
      name: "全满阻塞",
      nodes: [
        { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 0.1 } },
        { id: "div", name: "分流", kind: "split", routes: [{ to: "qa", share: 0.5 }, { to: "qb", share: 0.5 }] },
        { id: "qa", name: "缓存 A", kind: "queue-buffer", capacity: 1 },
        { id: "qb", name: "缓存 B", kind: "queue-buffer", capacity: 1 },
        { id: "slow-a", name: "停摆工位 A", kind: "station", processingTime: { kind: "deterministic", value: 1_000_000 }, queueCapacity: 1 },
        { id: "slow-b", name: "停摆工位 B", kind: "station", processingTime: { kind: "deterministic", value: 1_000_000 }, queueCapacity: 1 },
        { id: "snk-a", name: "出货 A", kind: "sink" },
        { id: "snk-b", name: "出货 B", kind: "sink" },
      ],
      edges: [
        { id: "e1", from: "src", to: "div" },
        { id: "e2", from: "qa", to: "slow-a" },
        { id: "e3", from: "slow-a", to: "snk-a" },
        { id: "e4", from: "qb", to: "slow-b" },
        { id: "e5", from: "slow-b", to: "snk-b" },
      ],
    };
    const result = runModel(model, "split-blocked");
    const first = result.replications[0];
    const div = first?.nodes.find((node) => node.nodeId === "div");
    expect(first?.completedItems).toBe(0);
    expect((div?.blockedMinutes ?? 0)).toBeGreaterThan(100);
    expect((div?.averageQueueLength ?? 0)).toBeGreaterThan(0);
  });
});

describe("split 校验", () => {
  const base: PlantLiteModel = {
    id: "split-validation",
    name: "校验基线",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 1 } },
      { id: "div", name: "分流", kind: "split", routes: [{ to: "snk", share: 1 }] },
      { id: "snk", name: "出货", kind: "sink" },
    ],
    edges: [{ id: "e1", from: "src", to: "div" }],
  };

  it("routes 为空数组被拒绝", () => {
    const result = validatePlantLiteModel({
      ...base,
      nodes: base.nodes.map((node) => node.kind === "split" ? { ...node, routes: [] } : node),
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("至少一条路由"))).toBe(true);
  });

  it("路由目标指向 source 被拒绝", () => {
    const result = validatePlantLiteModel({
      ...base,
      nodes: base.nodes.map((node) => node.kind === "split" ? { ...node, routes: [{ to: "src", share: 1 }] } : node),
    });
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("不得指向 source"))).toBe(true);
  });

  it("已配份额合计不为 1 与全 0 均被拒绝", () => {
    const partial = validatePlantLiteModel({
      ...base,
      nodes: base.nodes.map((node) => node.kind === "split" ? { ...node, routes: [{ to: "snk", share: 0.6 }] } : node),
    });
    expect(partial.valid).toBe(false);
    expect(partial.issues.some((issue) => issue.message.includes("合计必须为 1"))).toBe(true);
    const allZero = validatePlantLiteModel({
      ...base,
      nodes: base.nodes.map((node) => node.kind === "split"
        ? { ...node, routes: [{ to: "snk", share: 0 }, { to: "snk", share: 0 }] }
        : node),
    });
    expect(allZero.valid).toBe(false);
    expect(allZero.issues.some((issue) => issue.message.includes("全为 0"))).toBe(true);
  });

  it("share 越界与 split 声明 edges 出边均被拒绝", () => {
    const outOfRange = validatePlantLiteModel({
      ...base,
      nodes: base.nodes.map((node) => node.kind === "split" ? { ...node, routes: [{ to: "snk", share: 1.5 }] } : node),
    });
    expect(outOfRange.valid).toBe(false);
    const doubled = validatePlantLiteModel({
      ...base,
      edges: [{ id: "e1", from: "src", to: "div" }, { id: "e2", from: "div", to: "snk" }],
    });
    expect(doubled.valid).toBe(false);
    expect(doubled.issues.some((issue) => issue.message.includes("不得再配置出边"))).toBe(true);
  });
});

describe("split 顺序确定性", () => {
  const model: PlantLiteModel = {
    id: "split-determinism",
    name: "确定性",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "uniform", minimum: 0.4, maximum: 0.9 } },
      { id: "div", name: "分流", kind: "split", routes: [{ to: "st-a", share: 0.5 }, { to: "st-b", share: 0.5 }] },
      { id: "st-a", name: "加工 A", kind: "station", processingTime: { kind: "deterministic", value: 0.7 } },
      { id: "st-b", name: "加工 B", kind: "station", processingTime: { kind: "deterministic", value: 0.9 } },
      { id: "snk-a", name: "出货 A", kind: "sink" },
      { id: "snk-b", name: "出货 B", kind: "sink" },
    ],
    edges: [
      { id: "e1", from: "src", to: "div" },
      { id: "e2", from: "st-a", to: "snk-a" },
      { id: "e3", from: "st-b", to: "snk-b" },
    ],
  };

  it("同 seed 双跑全部节点指标与路由分布逐位一致", () => {
    const first = runModel(model, "split-seed-1");
    const second = runModel(model, "split-seed-1");
    expect(JSON.stringify(first.replications)).toBe(JSON.stringify(second.replications));
    const other = runModel(model, "split-seed-2");
    expect(JSON.stringify(other.replications)).not.toBe(JSON.stringify(first.replications));
  });
});
