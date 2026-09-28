import { describe, expect, it } from "vitest";
import type { PprBopVersionDraft } from "@bim-studio/contracts";
import { validatePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { preparePlantLiteDraftFromPpr } from "./pprPlantLiteDraft";

describe("PPR to Plant Lite draft adapter", () => {
  it("derives a deterministic editable flow and throughput target from explicit takt", () => {
    const result = preparePlantLiteDraftFromPpr(serialPlan());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.request.model?.id).toMatch(/-flow-draft$/);
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
    expect(result.report.admission).toEqual([
      {
        semantics: "sequential-flow",
        verdict: "direct",
        sourceIds: ["operation-1", "operation-2"],
        reason: expect.stringContaining("顺序直连"),
      },
    ]);
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

  it("maps an unconditional branch into a placeholder split with an explicit review", () => {
    const result = preparePlantLiteDraftFromPpr(branchPlan());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.request.model?.id).toMatch(/-review-only$/);
    const split = result.request.model?.nodes.find((node) => node.id === "split-1");
    expect(split).toMatchObject({
      kind: "split",
      routes: [
        { to: "station-2", share: 0.5 },
        { to: "station-3", share: 0.5 },
      ],
    });
    const edges = result.request.model?.edges ?? [];
    expect(edges).toHaveLength(4);
    expect(edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "source", to: "station-1" }),
      expect.objectContaining({ from: "station-1", to: "split-1" }),
      expect.objectContaining({ from: "station-2", to: "sink" }),
      expect.objectContaining({ from: "station-3", to: "sink" }),
    ]));
    expect(result.report.reviewItems).toEqual([expect.objectContaining({
      code: "multiple-successors",
      message: expect.stringContaining("占位"),
    })]);
    expect(result.report.admission).toEqual([expect.objectContaining({
      semantics: "branch-split",
      verdict: "mapped-review",
    })]);
    expect(validatePlantLiteModel(result.request.model).valid).toBe(true);
  });

  it("does not let a branch mapping mask a blocked minimum lag on the same plan", () => {
    const draft = branchPlan();
    draft.precedenceRelations[0]!.minimumLagMinutes = 5;
    const result = preparePlantLiteDraftFromPpr(draft);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.request.model?.id).toMatch(/-review-only$/);
    expect(result.report.admission.map((entry) => [entry.semantics, entry.verdict])).toEqual(expect.arrayContaining([
      ["minimum-lag", "blocked"],
      ["branch-split", "mapped-review"],
    ]));
    expect(result.report.reviewItems.some((item) => item.code === "minimum-lag" && item.message.includes("阻断"))).toBe(true);
  });

  it("blocks AND join convergence with rebuild guidance instead of assuming multi-edge joins", () => {
    const result = preparePlantLiteDraftFromPpr(joinPlan());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.request.model?.id).toMatch(/-review-only$/);
    const joinReview = result.report.reviewItems.find((item) => item.code === "multiple-predecessors");
    expect(joinReview?.message).toContain("阻断");
    expect(joinReview?.message).toContain("重建");
    expect(result.report.admission).toEqual(expect.arrayContaining([
      expect.objectContaining({ semantics: "and-join-convergence", verdict: "blocked" }),
      expect.objectContaining({ semantics: "branch-split", verdict: "mapped-review" }),
    ]));
    expect(validatePlantLiteModel(result.request.model).valid).toBe(true);
  });

  it("maps equipment plus person joint occupancy in the supported whitelist and keeps the draft formal", () => {
    const draft = jointPlan();
    const result = preparePlantLiteDraftFromPpr(draft);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    // 白名单内联合占用语义等价：模型保持 -flow-draft，可进入正式预测。
    expect(result.request.model?.id).toMatch(/-flow-draft$/);
    expect(result.report.reviewItems).toEqual([]);
    expect(result.report.mappedOperations.find((item) => item.operationId === "operation-1")).toMatchObject({
      resourceId: "equipment-1",
      workerResourceId: "worker-1",
    });
    expect(result.request.model?.resources).toEqual(expect.arrayContaining([
      { id: "equipment-1", name: "定位设备", kind: "equipment", capacity: 2 },
      { id: "worker-1", name: "操作员", kind: "worker", capacity: 1 },
    ]));
    const station = result.request.model?.nodes.find((node) => node.id === "station-1");
    expect(station).toMatchObject({ resourceId: "equipment-1", workerResourceId: "worker-1" });
    expect(result.report.admission).toEqual(expect.arrayContaining([
      expect.objectContaining({ semantics: "sequential-flow", verdict: "direct" }),
      expect.objectContaining({ semantics: "joint-equipment-worker", verdict: "direct" }),
    ]));
    expect(validatePlantLiteModel(result.request.model).valid).toBe(true);
  });

  it("blocks multi-resource atomic locks outside the joint occupancy whitelist", () => {
    const draft = serialPlan();
    draft.resourceAssignments = [
      { id: "assignment-1", operationId: "operation-1", resourceId: "equipment-raw" },
      { id: "assignment-1b", operationId: "operation-1", resourceId: "robot-raw" },
      { id: "assignment-2", operationId: "operation-2", resourceId: "robot-raw", requiredCapacity: 1 },
    ];
    const result = preparePlantLiteDraftFromPpr(draft);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.request.model?.id).toMatch(/-review-only$/);
    const lockReview = result.report.reviewItems.find((item) => item.code === "multiple-resources");
    expect(lockReview?.message).toContain("阻断");
    expect(lockReview?.message).toContain("分解");
    expect(result.report.admission).toEqual(expect.arrayContaining([
      expect.objectContaining({ semantics: "multi-resource-atomic-lock", verdict: "blocked" }),
    ]));
    expect(result.report.mappedOperations.find((item) => item.operationId === "operation-1")).not.toHaveProperty("resourceId");
    expect(validatePlantLiteModel(result.request.model).valid).toBe(true);
  });

  it("blocks minimum lag with rebuild guidance instead of folding it into processing time", () => {
    const draft = serialPlan();
    draft.precedenceRelations[0]!.minimumLagMinutes = 5;
    const result = preparePlantLiteDraftFromPpr(draft);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.request.model?.id).toMatch(/-review-only$/);
    const lagReview = result.report.reviewItems.find((item) => item.code === "minimum-lag");
    expect(lagReview?.message).toContain("阻断");
    expect(lagReview?.message).toContain("重建");
    expect(lagReview?.message).not.toContain("未写入加工时间");
    expect(result.report.admission).toEqual(expect.arrayContaining([
      expect.objectContaining({ semantics: "minimum-lag", verdict: "blocked", sourceIds: ["relation-1"] }),
    ]));
  });

  it("reports blocked semantics as review-only while still mapping whitelisted joint occupancy", () => {
    const result = preparePlantLiteDraftFromPpr(reviewPlan());

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.request.model?.id).toMatch(/-review-only$/);
    const codes = result.report.reviewItems.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining([
      "conditional-scope",
      "disconnected-flow",
      "minimum-lag",
      "multiple-predecessors",
      "resource-capacity",
      "unsupported-resource",
    ]));
    // 联合占用已在白名单内映射，不再误报为多资源原子锁。
    expect(codes).not.toContain("multiple-resources");
    const jointOperation = result.report.mappedOperations.find((item) => item.operationId === "operation-1");
    expect(jointOperation).toMatchObject({ resourceId: "equipment-1", workerResourceId: "worker-1" });
    expect(result.request.model?.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "equipment-1", kind: "equipment" }),
      expect.objectContaining({ id: "worker-1", kind: "worker" }),
    ]));
    expect(result.report.admission).toEqual(expect.arrayContaining([
      expect.objectContaining({ semantics: "and-join-convergence", verdict: "blocked" }),
      expect.objectContaining({ semantics: "minimum-lag", verdict: "blocked" }),
      expect.objectContaining({ semantics: "joint-equipment-worker", verdict: "direct" }),
    ]));
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

function branchPlan(): PprBopVersionDraft {
  return {
    planId: "pd-lite-project-1",
    name: "分流工艺",
    targetTaktMinutes: 6,
    components: [{ id: "product-1", name: "整机", kind: "product" }],
    operations: [
      { id: "operation-1", name: "总装", standardTimeMinutes: 2, componentRefs: [{ componentId: "product-1", role: "in-process" }] },
      { id: "operation-2", name: "检验A", standardTimeMinutes: 1, componentRefs: [{ componentId: "product-1", role: "output" }] },
      { id: "operation-3", name: "检验B", standardTimeMinutes: 3, componentRefs: [{ componentId: "product-1", role: "output" }] },
    ],
    precedenceRelations: [
      { id: "relation-1", predecessorOperationId: "operation-1", successorOperationId: "operation-2" },
      { id: "relation-2", predecessorOperationId: "operation-1", successorOperationId: "operation-3" },
    ],
    resources: [
      { id: "equipment-a", name: "总装设备", kind: "equipment", capacity: 1 },
      { id: "equipment-b", name: "检验设备A", kind: "equipment", capacity: 1 },
      { id: "equipment-c", name: "检验设备B", kind: "equipment", capacity: 1 },
    ],
    resourceAssignments: [
      { id: "assignment-1", operationId: "operation-1", resourceId: "equipment-a", requiredCapacity: 1 },
      { id: "assignment-2", operationId: "operation-2", resourceId: "equipment-b", requiredCapacity: 1 },
      { id: "assignment-3", operationId: "operation-3", resourceId: "equipment-c", requiredCapacity: 1 },
    ],
  };
}

function joinPlan(): PprBopVersionDraft {
  const draft = branchPlan();
  draft.operations.push(
    { id: "operation-4", name: "终检", standardTimeMinutes: 2, componentRefs: [{ componentId: "product-1", role: "output" }] },
  );
  draft.precedenceRelations = [
    ...draft.precedenceRelations,
    { id: "relation-3", predecessorOperationId: "operation-2", successorOperationId: "operation-4" },
    { id: "relation-4", predecessorOperationId: "operation-3", successorOperationId: "operation-4" },
  ];
  return draft;
}

function jointPlan(): PprBopVersionDraft {
  const draft = serialPlan();
  draft.resources.push({ id: "person-raw", name: "操作员", kind: "person", capacity: 1 });
  draft.resourceAssignments = [
    { id: "assignment-1", operationId: "operation-1", resourceId: "equipment-raw", requiredCapacity: 1 },
    { id: "assignment-1b", operationId: "operation-1", resourceId: "person-raw", requiredCapacity: 1 },
    { id: "assignment-2", operationId: "operation-2", resourceId: "robot-raw", requiredCapacity: 1 },
  ];
  return draft;
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
