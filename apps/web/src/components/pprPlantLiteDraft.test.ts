import { describe, expect, it } from "vitest";
import type { PprBopVersionDraft } from "@bim-studio/contracts";
import { validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { preparePlantLiteDraftFromPpr } from "./pprPlantLiteDraft";

describe("PPR to Plant Lite draft adapter", () => {
  it("derives a deterministic editable flow and throughput target from explicit takt", () => {
    const result = preparePlantLiteDraftFromPpr(serialPlan());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.request.acceptanceTargets).toMatchObject({ minimumThroughputPerHour: 10 });
    expect(result.request.model?.nodes).toEqual([
      { id: "source", name: "按目标节拍来料", kind: "source", interarrivalTime: { kind: "deterministic", value: 6 } },
      { id: "station-1", name: "定位", kind: "station", processingTime: { kind: "deterministic", value: 2 }, capacity: 2, resourceId: "equipment-1" },
      { id: "station-2", name: "装配", kind: "station", processingTime: { kind: "deterministic", value: 3 }, capacity: 1, resourceId: "equipment-2" },
      { id: "sink", name: "完成品", kind: "sink" },
    ]);
    expect(result.request.model?.edges).toEqual([
      { id: "edge-1", from: "source", to: "station-1" },
      { id: "edge-2", from: "station-1", to: "station-2" },
      { id: "edge-3", from: "station-2", to: "sink" },
    ]);
    expect(result.request.model?.resources).toEqual([
      { id: "equipment-1", name: "定位设备", kind: "equipment", capacity: 2 },
      { id: "equipment-2", name: "装配机器人", kind: "equipment", capacity: 1 },
    ]);
    expect(result.request.model).not.toHaveProperty("energyEconomics");
    expect(result.request.model).not.toHaveProperty("productTypes");
    expect(result.request).not.toHaveProperty("limits");
    expect(result.report).toMatchObject({
      kind: "editable-draft",
      targetTaktMinutes: 6,
      arrivalIntervalMinutes: 6,
      minimumThroughputPerHour: 10,
      reviewItems: [],
    });
    expect(validatePlantLiteModel(result.request.model).valid).toBe(true);
  });

  it("blocks conversion until the user supplies a positive target and fixes PPR errors", () => {
    const noTarget = serialPlan();
    delete noTarget.targetTaktMinutes;
    const missing = preparePlantLiteDraftFromPpr(noTarget);
    expect(missing).toMatchObject({ status: "blocked", blockers: [expect.objectContaining({ code: "missing-target-takt" })] });

    const invalid = serialPlan();
    invalid.operations[0]!.standardTimeMinutes = 0;
    const blocked = preparePlantLiteDraftFromPpr(invalid);
    expect(blocked.status).toBe("blocked");
    if (blocked.status === "blocked") {
      expect(blocked.blockers).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "invalid-ppr", sourceId: "operation-1" }),
      ]));
    }
  });

  it("reports semantics that cannot be represented instead of inventing equivalence", () => {
    const draft = reviewPlan();
    const result = preparePlantLiteDraftFromPpr(draft);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.report.reviewItems.map((item) => item.code)).toEqual(expect.arrayContaining([
      "conditional-scope",
      "disconnected-flow",
      "minimum-lag",
      "multiple-predecessors",
      "multiple-resources",
      "resource-capacity",
      "unsupported-resource",
    ]));
    expect(result.request.model?.resources).toBeUndefined();
    expect(result.report.mappedOperations).toHaveLength(3);
    expect(result.report.mappedOperations.every((item) => item.resourceId === undefined)).toBe(true);
    expect(result.report.retainedInProcessPlan).toEqual(["产品与 BOM", "电子作业指导书", "质量与安全内容"]);
    expect(validatePlantLiteModel(result.request.model).valid).toBe(true);
  });

  it("does not bind a variant-scoped machine as an unconditional DES resource", () => {
    const draft = serialPlan();
    draft.resources[0]!.variantIds = ["EU"];
    const result = preparePlantLiteDraftFromPpr(draft);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.report.reviewItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "conditional-resource", sourceIds: ["operation-1", "equipment-raw"] }),
    ]));
    expect(result.report.mappedOperations[0]).not.toHaveProperty("resourceId");
    expect(result.report.mappedOperations[1]).toHaveProperty("resourceId", "equipment-1");
  });
});

function serialPlan(): PprBopVersionDraft {
  return {
    planId: "pd-lite-project-1",
    name: "总装工艺",
    targetTaktMinutes: 6,
    components: [{ id: "product-1", name: "整机", kind: "product" }],
    operations: [
      { id: "operation-1", name: "定位", standardTimeMinutes: 2, componentRefs: [{ componentId: "product-1", role: "in-process" }] },
      { id: "operation-2", name: "装配", standardTimeMinutes: 3, componentRefs: [{ componentId: "product-1", role: "output" }] },
    ],
    precedenceRelations: [{ id: "relation-1", predecessorOperationId: "operation-1", successorOperationId: "operation-2" }],
    resources: [
      { id: "equipment-raw", name: "定位设备", kind: "equipment", capacity: 2 },
      { id: "robot-raw", name: "装配机器人", kind: "robot", capacity: 1 },
    ],
    resourceAssignments: [
      { id: "assignment-1", operationId: "operation-1", resourceId: "equipment-raw", requiredCapacity: 1 },
      { id: "assignment-2", operationId: "operation-2", resourceId: "robot-raw", requiredCapacity: 1 },
    ],
  };
}

function reviewPlan(): PprBopVersionDraft {
  const draft = serialPlan();
  draft.condition = { expression: "variant == 'EU'" };
  draft.operations.push({ id: "operation-3", name: "检查", standardTimeMinutes: 1, componentRefs: [{ componentId: "product-1", role: "output" }] });
  draft.precedenceRelations = [
    { id: "relation-1", predecessorOperationId: "operation-1", successorOperationId: "operation-3", minimumLagMinutes: 2 },
    { id: "relation-2", predecessorOperationId: "operation-2", successorOperationId: "operation-3" },
  ];
  draft.resources.push(
    { id: "person-raw", name: "操作员", kind: "person", capacity: 1 },
    { id: "tool-raw", name: "扭矩工具", kind: "tool", capacity: 1 },
  );
  draft.resourceAssignments = [
    { id: "assignment-1", operationId: "operation-1", resourceId: "equipment-raw" },
    { id: "assignment-2", operationId: "operation-1", resourceId: "person-raw" },
    { id: "assignment-3", operationId: "operation-2", resourceId: "tool-raw" },
    { id: "assignment-4", operationId: "operation-3", resourceId: "robot-raw", requiredCapacity: 2 },
  ];
  return draft;
}
