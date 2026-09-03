import { describe, expect, it } from "vitest";
import { createAgvLinePlantLiteModel, runPlantLiteExperiment, validatePlantLiteModel } from "./index.js";

describe("Plant Lite production orders", () => {
  it("releases a finite order, preserves lineage and measures delivery against planned quantity", () => {
    const model = createAgvLinePlantLiteModel({ agvCount: 1 });
    model.nodes = [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 10 } },
      { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 5 } },
      { id: "sink", name: "成品", kind: "sink" },
    ];
    model.edges = [
      { id: "source-station", from: "source", to: "station" },
      { id: "station-sink", from: "station", to: "sink" },
    ];
    model.resources = [];
    model.energyEconomics = undefined;
    model.productTypes = [{ id: "a", name: "A 型", share: 0.5 }, { id: "b", name: "B 型", share: 0.5 }];
    model.productionOrders = [{ id: "order-1", name: "订单 1", sourceNodeId: "source", productTypeId: "b", quantity: 3, releaseMinute: 0, dueMinute: 15, priority: 10 }];

    const result = runPlantLiteExperiment({ model, seed: "orders", replications: 2, limits: { durationMinutes: 60 }, trace: { replication: 0 } });

    expect(result.replications[0]?.productionOrders[0]).toMatchObject({
      orderId: "order-1", plannedItems: 3, releasedItems: 3, completedItems: 3,
      completedOnTimeItems: 2, completionRate: 1, onTimeFulfillmentRate: 2 / 3,
      fullyCompleted: true, completionMinute: 25, observedTardinessMinutes: 10,
    });
    expect(result.productionOrderMetrics95["order-1"]).toMatchObject({
      completedItems: { mean: 3, samples: 2 },
      completionRate: { mean: 1 },
      onTimeFulfillmentRate: { mean: 2 / 3 },
      fullyCompletedRate: { mean: 1 },
      observedTardinessMinutes: { mean: 10 },
    });
    expect(result.representativeTrace?.events).toContainEqual(expect.objectContaining({ orderId: "order-1", productTypeId: "b" }));
  });

  it("rejects broken order references and inverted dates", () => {
    const model = createAgvLinePlantLiteModel();
    model.productionOrders = [{ id: "bad", name: "错误订单", sourceNodeId: "station-a", productTypeId: "missing", quantity: 0, releaseMinute: 20, dueMinute: 10 }];
    expect(validatePlantLiteModel(model)).toMatchObject({
      valid: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "$.productionOrders[0].sourceNodeId", message: "必须引用来料源" }),
        expect.objectContaining({ path: "$.productionOrders[0].productTypeId", message: "未知产品类型" }),
        expect.objectContaining({ path: "$.productionOrders[0].quantity" }),
        expect.objectContaining({ path: "$.productionOrders[0].dueMinute", message: "交期不得早于释放时间" }),
      ]),
    });
  });

  it("shares one source takt across orders and dispatches ready work by priority", () => {
    const model = createAgvLinePlantLiteModel({ agvCount: 1 });
    model.nodes = [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 10 } },
      { id: "sink", name: "成品", kind: "sink" },
    ];
    model.edges = [{ id: "source-sink", from: "source", to: "sink" }];
    model.resources = [];
    model.energyEconomics = undefined;
    model.productionOrders = [
      { id: "low", name: "低优先级", sourceNodeId: "source", quantity: 2, releaseMinute: 0, dueMinute: 100, priority: 1 },
      { id: "high", name: "高优先级", sourceNodeId: "source", quantity: 2, releaseMinute: 0, dueMinute: 100, priority: 10 },
    ];

    const result = runPlantLiteExperiment({ model, seed: "shared-source-takt", replications: 2, limits: { durationMinutes: 40 }, trace: { replication: 0 } });
    const arrivals = result.representativeTrace?.events
      .filter((event) => event.type === "item-enter" && event.nodeId === "source")
      .map((event) => ({ atMinute: event.atMinute, orderId: event.orderId }));

    expect(arrivals).toEqual([
      { atMinute: 0, orderId: "high" },
      { atMinute: 10, orderId: "high" },
      { atMinute: 20, orderId: "low" },
      { atMinute: 30, orderId: "low" },
    ]);
  });

  it("interprets order release and due minutes relative to the measurement window", () => {
    const model = createAgvLinePlantLiteModel({ agvCount: 1 });
    model.nodes = [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 10 } },
      { id: "station", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 5 } },
      { id: "sink", name: "成品", kind: "sink" },
    ];
    model.edges = [
      { id: "source-station", from: "source", to: "station" },
      { id: "station-sink", from: "station", to: "sink" },
    ];
    model.resources = [];
    model.energyEconomics = undefined;
    model.productionOrders = [{ id: "order", name: "订单", sourceNodeId: "source", quantity: 1, releaseMinute: 0, dueMinute: 5 }];

    const result = runPlantLiteExperiment({ model, seed: "warmup-order", replications: 2, limits: { durationMinutes: 40, warmupMinutes: 20 }, trace: { replication: 0 } });
    const order = result.replications[0]?.productionOrders[0];

    expect(result.representativeTrace?.events).toContainEqual(expect.objectContaining({ type: "item-enter", nodeId: "source", atMinute: 20, orderId: "order" }));
    expect(order).toMatchObject({ completedItems: 1, completedOnTimeItems: 1, completionMinute: 5, observedTardinessMinutes: 0 });
  });

  it("preserves reserved-looking order IDs in aggregate metric keys", () => {
    const model = createAgvLinePlantLiteModel({ agvCount: 1 });
    model.nodes = [
      { id: "source", name: "来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 10 } },
      { id: "sink", name: "成品", kind: "sink" },
    ];
    model.edges = [{ id: "source-sink", from: "source", to: "sink" }];
    model.resources = [];
    model.energyEconomics = undefined;
    model.productionOrders = [{ id: "__proto__", name: "保留键订单", sourceNodeId: "source", quantity: 1, releaseMinute: 0, dueMinute: 10 }];

    const result = runPlantLiteExperiment({ model, seed: "reserved-order-id", replications: 2, limits: { durationMinutes: 20 } });

    expect(Object.keys(result.productionOrderMetrics95)).toContain("__proto__");
  });
});
