/**
 * 看板拉动（queue-buffer + kanban）单测。
 * 覆盖:基本流与取走统计、门控压水位对照、校验失败族、长程不锁死回归、同 seed 确定性。
 */

import { describe, expect, it } from "vitest";
import type { PlantLiteModel } from "./modelTypes.js";
import { validatePlantLiteModel } from "./modelValidation.js";
import { runPlantLiteExperiment } from "./engine.js";

const LIMITS = { durationMinutes: 480, warmupMinutes: 60, maxEvents: 1_000_000, maxResources: 100 } as const;

function runModel(model: PlantLiteModel, seed: string | number = "kanban-test") {
  return runPlantLiteExperiment({ model, seed, replications: 3, limits: { ...LIMITS } });
}

function kanbanLine(cardCount: number, cardQuantity: number, stationMinutes: number, interarrival: number): PlantLiteModel {
  return {
    id: "kanban-line",
    name: "看板流水线",
    nodes: [
      { id: "src", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: interarrival } },
      { id: "kb", name: "看板超市", kind: "queue-buffer", capacity: cardCount * cardQuantity, kanban: { cardCount, cardQuantity } },
      { id: "st", name: "加工", kind: "station", processingTime: { kind: "deterministic", value: stationMinutes }, queueCapacity: 1 },
      { id: "snk", name: "出货", kind: "sink" },
    ],
    edges: [
      { id: "e1", from: "src", to: "kb" },
      { id: "e2", from: "kb", to: "st" },
      { id: "e3", from: "st", to: "snk" },
    ],
  };
}

function kbMetric(result: ReturnType<typeof runModel>, selector: "averageQueueLength" | "kanbanWithdrawn"): number[] {
  return result.replications.map((replication) =>
    replication.nodes.find((node) => node.nodeId === "kb")?.[selector] ?? 0);
}

describe("kanban 基本流", () => {
  it("拉动线持续产出,取走件数被统计且不少于窗口完工", () => {
    const result = runModel(kanbanLine(3, 2, 0.5, 0.4));
    for (const replication of result.replications) {
      expect(replication.completedItems).toBeGreaterThan(100);
      const withdrawn = replication.nodes.find((node) => node.nodeId === "kb")?.kanbanWithdrawn ?? 0;
      expect(withdrawn).toBeGreaterThanOrEqual(replication.completedItems);
    }
  });

  it("看板唤醒不绕过 source 的 maxItems 限额", () => {
    const model = kanbanLine(2, 2, 0.5, 0.4);
    const limited: PlantLiteModel = {
      ...model,
      nodes: model.nodes.map((node) => node.kind === "source" ? { ...node, maxItems: 5 } : node),
    };
    const result = runModel(limited);
    for (const replication of result.replications) {
      expect(replication.completedItems).toBeLessThanOrEqual(5);
    }
  });
});

describe("kanban 门控压水位", () => {
  it("门控版超市均值水位低于无门控反压版,且严格低于最大在库", () => {
    const gated = runModel(kanbanLine(2, 3, 2, 0.2));
    const ungatedModel = kanbanLine(2, 3, 2, 0.2);
    const ungated = runModel({
      ...ungatedModel,
      nodes: ungatedModel.nodes.map((node) => node.kind === "buffer" || node.kind === "queue-buffer" ? { ...node, kanban: undefined } : node),
    } as PlantLiteModel);
    const gatedQueues = kbMetric(gated, "averageQueueLength");
    const ungatedQueues = kbMetric(ungated, "averageQueueLength");
    for (const [gatedQueue, ungatedQueue] of gatedQueues.map((value, index) => [value, ungatedQueues[index] ?? 0] as const)) {
      expect(gatedQueue).toBeGreaterThan(0);
      expect(gatedQueue).toBeLessThan(6);
      expect(gatedQueue).toBeLessThan(ungatedQueue);
    }
  });
});

describe("kanban 长程不锁死回归", () => {
  it("取走累计远超卡容量后源仍被持续唤醒(旧累计口径会永久锁死)", () => {
    const result = runModel(kanbanLine(2, 3, 0.5, 0.4));
    for (const replication of result.replications) {
      // 累计取走(≈840)远超在库上限 6,若卡被长程耗尽则完工会停在个位数。
      expect(replication.completedItems).toBeGreaterThan(400);
      expect((replication.nodes.find((node) => node.nodeId === "kb")?.kanbanWithdrawn ?? 0)).toBeGreaterThan(400);
    }
  });
});

describe("kanban 校验", () => {
  it("cardCount / cardQuantity 必须为正整数,kanban 必须是对象", () => {
    const zeroCards = validatePlantLiteModel(kanbanLine(0, 3, 1, 1));
    expect(zeroCards.valid).toBe(false);
    expect(zeroCards.issues.some((issue) => issue.path.endsWith("kanban.cardCount"))).toBe(true);
    const zeroQuantity = validatePlantLiteModel(kanbanLine(2, 0, 1, 1));
    expect(zeroQuantity.valid).toBe(false);
    expect(zeroQuantity.issues.some((issue) => issue.path.endsWith("kanban.cardQuantity"))).toBe(true);
    const notObject = validatePlantLiteModel({
      ...kanbanLine(2, 3, 1, 1),
      nodes: kanbanLine(2, 3, 1, 1).nodes.map((node) =>
        node.kind === "queue-buffer"
          ? { ...node, kanban: 3 as unknown as { cardCount: number; cardQuantity: number } }
          : node),
    });
    expect(notObject.valid).toBe(false);
    expect(notObject.issues.some((issue) => issue.message.includes("必须是对象"))).toBe(true);
  });
});

describe("kanban 顺序确定性", () => {
  it("同 seed 双跑全部重复逐位一致,不同 seed 结果不同", () => {
    const model = kanbanLine(2, 3, 1, 0.6);
    const first = runModel(model, "kanban-seed-1");
    const second = runModel(model, "kanban-seed-1");
    expect(JSON.stringify(first.replications)).toBe(JSON.stringify(second.replications));
    const other = runModel(model, "kanban-seed-2");
    expect(JSON.stringify(other.replications)).not.toBe(JSON.stringify(first.replications));
  });
});
