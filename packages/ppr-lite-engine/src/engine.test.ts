import { describe, expect, it } from "vitest";
import type { PprBopVersion } from "@bim-studio/contracts";
import { analyzePprBopVersion, comparePprBopVersions } from "./engine.js";

describe("PD Lite PPR/BOP engine", () => {
  it("computes a deterministic topology, critical path, load and resource time conflict", () => {
    const input = plan();
    input.resourceAssignments.find((item) => item.id === "inspect-robot")!.resourceId = "robot";
    const result = analyzePprBopVersion(input);

    expect(result.issues.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.topologicalOrder).toEqual(["cut", "weld", "inspect", "finish"]);
    expect(result.criticalPath).toEqual({ operationIds: ["cut", "inspect", "finish"], durationMinutes: 21 });
    expect(result.resourceLoads).toContainEqual({ resourceId: "robot", assignedMinutes: 12, availableMinutes: 21, utilization: 12 / 21 });
    expect(result.resourceConflicts).toEqual([{
      resourceId: "robot", startMinutes: 10, endMinutes: 15,
      operationIds: ["weld", "inspect"], requiredCapacity: 2, availableCapacity: 1,
    }]);
    expect(result.lineBalance).toMatchObject({
      targetTaktMinutes: 10,
      totalWorkContentMinutes: 26,
      configuredStationUnits: 1,
      theoreticalMinimumStationUnits: 3,
      balanceEfficiency: 2.6,
      overloadedResourceIds: ["station"],
      unassignedOperationIds: ["weld", "inspect"],
    });
    expect(result.lineBalance.stationLoads[0]).toMatchObject({
      resourceId: "station", assignedMinutes: 14, loadPerUnitMinutes: 14, taktUtilization: 1.4,
    });
  });

  it("reports missing links, cycles and isolated operations without pretending a schedule exists", () => {
    const input = plan();
    input.operations[0]!.componentRefs = [{ componentId: "missing-part", role: "output" }];
    input.operations.push({ id: "orphan", name: "孤立返工", standardTimeMinutes: 2, componentRefs: [{ componentId: "frame", role: "in-process" }] });
    input.precedenceRelations.push({ id: "cycle", predecessorOperationId: "finish", successorOperationId: "cut" });
    input.precedenceRelations.push({ id: "missing-op", predecessorOperationId: "cut", successorOperationId: "missing" });
    input.resourceAssignments.push({ id: "missing-resource", operationId: "cut", resourceId: "gone" });
    input.targetTaktMinutes = 0;

    const result = analyzePprBopVersion(input);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-component-reference", entityId: "cut" }),
      expect.objectContaining({ code: "missing-operation-reference", entityId: "missing-op" }),
      expect.objectContaining({ code: "missing-assignment-reference", entityId: "missing-resource" }),
      expect.objectContaining({ code: "precedence-cycle", entityId: "bop-v1" }),
      expect.objectContaining({ code: "isolated-operation", entityId: "orphan", severity: "warning" }),
      expect.objectContaining({ code: "invalid-target-takt", entityId: "bop-v1", severity: "error" }),
    ]));
    expect(result.schedule).toEqual([]);
  });

  it("runs an explicit product variant without scheduling excluded operations or resources", () => {
    const input = plan();
    input.variantIds = ["EU", "US"];
    input.operations.find((item) => item.id === "weld")!.variantIds = ["EU"];
    input.operations.find((item) => item.id === "inspect")!.variantIds = ["US"];
    input.operations.find((item) => item.id === "weld")!.condition = {
      expression: "market == 'regulated'",
      description: "仍需由上游规则解析",
    };
    input.resources.find((item) => item.id === "robot")!.variantIds = ["EU"];
    input.resources.find((item) => item.id === "quality")!.variantIds = ["US"];

    const result = analyzePprBopVersion(input, "EU");

    expect(result.issues.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "variant-condition-not-evaluated" }));
    expect(result.topologicalOrder).toEqual(["cut", "weld", "finish"]);
    expect(result.criticalPath).toEqual({ operationIds: ["cut", "weld", "finish"], durationMinutes: 19 });
    expect(result.variantScope).toMatchObject({
      activeVariantId: "EU",
      knownVariant: true,
      included: { operationIds: ["cut", "weld", "finish"] },
      excluded: { operationIds: ["inspect"], resourceIds: ["quality"] },
      unresolvedConditionIds: ["weld"],
    });
  });

  it("rejects an undeclared analysis variant instead of silently treating it as a base plan", () => {
    const result = analyzePprBopVersion(plan(), "right-hand-drive");
    expect(result.schedule).toEqual([]);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "unknown-active-variant",
      severity: "error",
    }));
    expect(result.variantScope.knownVariant).toBe(false);
  });

  it("compares snapshots and marks direct scheduling regressions and their affected entities", () => {
    const before = plan();
    before.targetTaktMinutes = 20;
    const after = plan();
    after.id = "bop-v2";
    after.version = "2.0";
    after.basedOnVersionId = before.id;
    after.operations.find((item) => item.id === "inspect")!.standardTimeMinutes = 9;
    after.resourceAssignments.find((item) => item.id === "inspect-robot")!.resourceId = "robot";
    after.targetTaktMinutes = 10;

    const result = comparePprBopVersions(before, after);
    expect(result.changes).toEqual(expect.arrayContaining([
      { entityType: "operation", entityId: "inspect", changeType: "modified", changedFields: ["standardTimeMinutes"] },
      { entityType: "assignment", entityId: "inspect-robot", changeType: "modified", changedFields: ["resourceId"] },
      { entityType: "plan", entityId: "vehicle-door", changeType: "modified", changedFields: ["targetTaktMinutes"] },
    ]));
    expect(result.impact).toEqual({ componentIds: ["frame"], operationIds: ["inspect"], resourceIds: ["quality", "robot"] });
    expect(result.regressions.map((item) => item.code)).toEqual(expect.arrayContaining([
      "critical-path-increased", "standard-time-increased", "resource-conflict-introduced", "takt-overload-introduced",
    ]));
  });
});

function plan(): PprBopVersion {
  return {
    id: "bop-v1", planId: "vehicle-door", version: "1.0", name: "车门装配 BOP", createdAt: "2026-08-31T08:00:00.000Z", targetTaktMinutes: 10,
    variantIds: ["left-hand-drive"], references: [{ kind: "study", id: "study-cycle-time" }],
    components: [
      { id: "door", name: "车门总成", kind: "product", references: [{ kind: "scene", id: "assembly-scene" }] },
      { id: "frame", name: "门框", kind: "part", parentComponentId: "door" },
    ],
    operations: [
      { id: "cut", name: "下料", standardTimeMinutes: 10, componentRefs: [{ componentId: "frame", role: "output" }], references: [{ kind: "object", id: "laser-01" }] },
      { id: "weld", name: "焊接", standardTimeMinutes: 5, componentRefs: [{ componentId: "frame", role: "in-process" }] },
      { id: "inspect", name: "检测", standardTimeMinutes: 7, componentRefs: [{ componentId: "frame", role: "in-process" }] },
      { id: "finish", name: "总成完成", standardTimeMinutes: 4, componentRefs: [{ componentId: "door", role: "output" }] },
    ],
    precedenceRelations: [
      { id: "cut-weld", predecessorOperationId: "cut", successorOperationId: "weld" },
      { id: "cut-inspect", predecessorOperationId: "cut", successorOperationId: "inspect" },
      { id: "weld-finish", predecessorOperationId: "weld", successorOperationId: "finish" },
      { id: "inspect-finish", predecessorOperationId: "inspect", successorOperationId: "finish" },
    ],
    resources: [
      { id: "station", name: "装配工位", kind: "station", references: [{ kind: "script", id: "station-status" }] },
      { id: "robot", name: "焊接机器人", kind: "robot" },
      { id: "quality", name: "检测人员", kind: "person" },
    ],
    resourceAssignments: [
      { id: "cut-station", operationId: "cut", resourceId: "station" },
      { id: "weld-robot", operationId: "weld", resourceId: "robot" },
      { id: "inspect-robot", operationId: "inspect", resourceId: "quality" },
      { id: "finish-station", operationId: "finish", resourceId: "station" },
    ],
  };
}
