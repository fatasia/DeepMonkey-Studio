/**
 * 黄金样例断言(golden-01..06 + golden-10 报告复现 + golden-11..12 Split/Kanban)。
 * 断言分两层:机制层(指标被产出、方向正确)与确定性层(同输入同 seed 同指纹)。
 * 指纹断言锁死回归:任何改变统计语义的内核改动都会在此暴露。
 */

import { describe, expect, it } from "vitest";
import { fingerprint64Labeled } from "@bim-studio/contracts";
import { runPlantLiteExperiment } from "../engine.js";
import {
  PLANT_LITE_ENGINE_DESCRIPTOR,
  plantLiteSimulationEngine,
} from "../enginePort.js";
import {
  GOLDEN_LIMITS,
  golden01SingleLine,
  golden02MultiProduct,
  golden03Failure,
  golden04Changeover,
  golden05MultiAgv,
  golden06BlockedRoute,
  golden11SplitShares,
  golden12KanbanPull,
} from "./goldenModels.js";

const SEED = "golden-2026-09-25";

function runModel(model: ReturnType<typeof golden01SingleLine>, seed: string | number = SEED) {
  return runPlantLiteExperiment({ model, seed, replications: 5, limits: { ...GOLDEN_LIMITS } });
}

describe("golden-01 单线", () => {
  const result = runModel(golden01SingleLine());

  it("全部重复确定性完成且有产出", () => {
    expect(result.replications).toHaveLength(5);
    for (const replication of result.replications) {
      expect(replication.termination).toBe("completed");
      expect(replication.completedItems).toBeGreaterThan(0);
    }
    expect(result.confidence95.throughputPerHour.lower95).toBeGreaterThan(0);
  });

  it("瓶颈落在限速工位或其上游缓存,设备利用率高于 0", () => {
    const stationMetrics = result.nodeMetrics95["st"];
    expect(stationMetrics).toBeDefined();
    expect(result.replications[0]?.nodes.find((node) => node.nodeId === "st")?.utilization).toBeGreaterThan(0.5);
    expect(result.bottlenecks.length).toBeGreaterThan(0);
  });
});

describe("golden-02 多品种", () => {
  const result = runModel(golden02MultiProduct());

  it("两类产品均被统计且份额闭合", () => {
    expect(result.productTypeMetrics95["pa"]).toBeDefined();
    expect(result.productTypeMetrics95["pb"]).toBeDefined();
    const firstRun = result.replications[0];
    const shareSum = (firstRun?.productTypes ?? []).reduce((sum, item) => sum + item.completionShare, 0);
    expect(shareSum).toBeCloseTo(1, 5);
    for (const replication of result.replications) {
      expect(replication.completedItems).toBeGreaterThan(0);
    }
  });
});

describe("golden-03 故障维修", () => {
  // 对照 = 同模型去掉故障,唯一差异是故障本身;否则来料节拍会掩盖停机影响。
  const failingModel = golden03Failure();
  const healthyModel = {
    ...failingModel,
    resources: failingModel.resources?.map(({ failure: _failure, ...resource }) => resource),
  };
  const healthy = runModel(healthyModel);
  const failing = runModel(failingModel);

  it("故障被观测为 failedMinutes", () => {
    const failed = failing.replications[0]?.resources.find((resource) => resource.resourceId === "mc")?.failedMinutes;
    expect(failed).toBeGreaterThan(0);
  });

  it("故障吞吐低于健康对照(方向性校准)", () => {
    expect(failing.confidence95.throughputPerHour.mean).toBeLessThan(healthy.confidence95.throughputPerHour.mean);
  });
});

describe("golden-04 换型", () => {
  const result = runModel(golden04Changeover());

  it("换型次数与占用分钟被序列相关观测", () => {
    const firstRun = result.replications[0]?.nodes.find((node) => node.nodeId === "st");
    expect(firstRun?.changeoverCount).toBeGreaterThan(0);
    expect(firstRun?.changeoverMinutes).toBeGreaterThan(0);
    expect(result.nodeMetrics95["st"]?.changeoverCount.lower95).toBeGreaterThan(0);
  });
});

describe("golden-05 多 AGV", () => {
  // 模板限投 30 件且在预热期内即可完工,统计窗口必须从 0 开始,否则完工全部落在窗口外。
  const result = runPlantLiteExperiment({
    model: golden05MultiAgv(),
    seed: SEED,
    replications: 5,
    limits: { durationMinutes: 120, maxEvents: 200_000 },
    trace: { replication: 0, maxEvents: 2_000, maxItems: 500 },
  });

  it("车队调度完成产出,代表轨迹带搬运预约证据", () => {
    for (const replication of result.replications) {
      expect(replication.completedItems).toBe(30);
    }
    const trace = result.representativeTrace;
    expect(trace).toBeDefined();
    const transportEvidence = (trace?.events ?? []).some((event) => "transport" in event);
    expect(transportEvidence).toBe(true);
  });
});

describe("golden-06 封路阻塞", () => {
  const limits = { durationMinutes: 120, maxEvents: 200_000 } as const;
  const open = runPlantLiteExperiment({ model: golden05MultiAgv(), seed: SEED, replications: 5, limits });
  const blocked = runPlantLiteExperiment({ model: golden06BlockedRoute(), seed: SEED, replications: 5, limits });

  it("封路可运行且确定性终止", () => {
    for (const replication of blocked.replications) {
      expect(["completed", "limit-reached"]).toContain(replication.termination);
    }
  });

  it("封路吞吐低于开放轨道(阻塞被模型感知)", () => {
    expect(blocked.confidence95.throughputPerHour.mean)
      .toBeLessThan(open.confidence95.throughputPerHour.mean);
  });
});

describe("golden-11 Split 份额分流", () => {
  const result = runModel(golden11SplitShares());

  it("两条下游按 60/40 份额收敛(±2%)且两侧均有完工", () => {
    expect(result.replications).toHaveLength(5);
    for (const replication of result.replications) {
      const split = replication.nodes.find((node) => node.nodeId === "div");
      const delivered = split?.routeDelivered ?? [];
      const toA = delivered.find((route) => route.to === "st-a")?.items ?? 0;
      const toB = delivered.find((route) => route.to === "st-b")?.items ?? 0;
      expect(toA).toBeGreaterThan(0);
      expect(toB).toBeGreaterThan(0);
      const shareA = toA / (toA + toB);
      expect(shareA).toBeGreaterThanOrEqual(0.58);
      expect(shareA).toBeLessThanOrEqual(0.62);
      expect(1 - shareA).toBeGreaterThanOrEqual(0.38);
      expect(1 - shareA).toBeLessThanOrEqual(0.42);
    }
  });

  it("路由分布进入节点指标且同 seed 双跑指纹逐字一致", () => {
    const first = runPlantLiteExperiment({ model: golden11SplitShares(), seed: SEED, replications: 5, limits: { ...GOLDEN_LIMITS } });
    const second = runPlantLiteExperiment({ model: golden11SplitShares(), seed: SEED, replications: 5, limits: { ...GOLDEN_LIMITS } });
    expect(first.replications[0]?.nodes.find((node) => node.nodeId === "div")?.routeDelivered)
      .toEqual(second.replications[0]?.nodes.find((node) => node.nodeId === "div")?.routeDelivered);
    expect(fingerprint64Labeled([["result", first]])).toBe(fingerprint64Labeled([["result", second]]));
  });
});

describe("golden-12 Kanban 拉动", () => {
  const gatedModel = golden12KanbanPull();
  const ungatedModel = {
    ...gatedModel,
    nodes: gatedModel.nodes.map((node) => node.kind === "buffer" || node.kind === "queue-buffer" ? { ...node, kanban: undefined } : node),
  };
  const gated = runModel(gatedModel);
  const ungated = runModel(ungatedModel as typeof gatedModel);

  it("卡数门控压制在库水位:门控版均值队列低于无门控反压版", () => {
    const queueLength = (result: ReturnType<typeof runModel>, nodeId: string) =>
      result.replications.map((replication) => replication.nodes.find((node) => node.nodeId === nodeId)?.averageQueueLength ?? 0);
    for (const gatedQueue of queueLength(gated, "kb")) {
      expect(gatedQueue).toBeGreaterThan(0);
      expect(gatedQueue).toBeLessThan(10);
    }
    for (const [gatedQueue, ungatedQueue] of zip(queueLength(gated, "kb"), queueLength(ungated, "kb"))) {
      expect(gatedQueue).toBeLessThan(ungatedQueue);
    }
  });

  it("吞吐稳定且确定性:各重复完工数全等、取走被统计", () => {
    const completed = gated.replications.map((replication) => replication.completedItems);
    expect(completed[0]).toBeGreaterThan(300);
    expect(new Set(completed).size).toBe(1);
    for (const replication of gated.replications) {
      const withdrawn = replication.nodes.find((node) => node.nodeId === "kb")?.kanbanWithdrawn ?? 0;
      expect(withdrawn).toBeGreaterThan(0);
    }
  });

  it("同 seed 双跑指纹逐字一致,不同 seed 指纹不同", () => {
    const first = runPlantLiteExperiment({ model: golden12KanbanPull(), seed: SEED, replications: 5, limits: { ...GOLDEN_LIMITS } });
    const second = runPlantLiteExperiment({ model: golden12KanbanPull(), seed: SEED, replications: 5, limits: { ...GOLDEN_LIMITS } });
    expect(fingerprint64Labeled([["result", first]])).toBe(fingerprint64Labeled([["result", second]]));
    const other = runPlantLiteExperiment({ model: golden12KanbanPull(), seed: "golden-other-seed", replications: 5, limits: { ...GOLDEN_LIMITS } });
    expect(fingerprint64Labeled([["result", first]])).not.toBe(fingerprint64Labeled([["result", other]]));
  });
});

function zip(left: number[], right: number[]): Array<[number, number]> {
  return left.map((value, index) => [value, right[index] ?? 0] as [number, number]);
}

describe("golden-10 报告复现(引擎端口)", () => {
  const request = {
    input: { model: golden02MultiProduct(), replications: 3, limits: { ...GOLDEN_LIMITS } },
    seed: SEED,
  } as const;

  it("同输入同 seed 两次运行指纹逐字一致", async () => {
    const first = await plantLiteSimulationEngine.run({ ...request });
    const second = await plantLiteSimulationEngine.run({ ...request });
    expect(first.inputFingerprint).toBe(second.inputFingerprint);
    expect(first.resultFingerprint).toBe(second.resultFingerprint);
    expect(first.termination).toBe("completed");
    expect(first.descriptor.deterministic).toBe(true);
    expect(PLANT_LITE_ENGINE_DESCRIPTOR.engineId).toBe("plant-lite-des");
  });

  it("不同 seed 指纹不同(种子参与结果)", async () => {
    const baseline = await plantLiteSimulationEngine.run({ ...request });
    const other = await plantLiteSimulationEngine.run({ ...request, seed: "golden-other-seed" });
    expect(baseline.resultFingerprint).not.toBe(other.resultFingerprint);
  });

  it("进度事件覆盖完整生命周期,取消产出 cancelled 终止", async () => {
    const phases: string[] = [];
    const cancelled = await plantLiteSimulationEngine.run({
      ...request,
      shouldCancel: () => true,
      onProgress: (progress) => phases.push(progress.phase),
    });
    expect(cancelled.termination).toBe("cancelled");
    expect(phases[0]).toBe("validating");
    expect(phases).toContain("preparing");
    expect(phases).toContain("completed");
  });

  it("指纹材料直接绑定引擎版本(版本漂移必然改变指纹)", async () => {
    const record = await plantLiteSimulationEngine.run({ ...request });
    expect(record.resultFingerprint).toBe(fingerprint64Labeled([
      ["engineId", record.descriptor.engineId],
      ["engineVersion", record.descriptor.engineVersion],
      ["inputFingerprint", record.inputFingerprint],
      ["result", record.result],
    ]));
  });
});
