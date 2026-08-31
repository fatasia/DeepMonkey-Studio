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
  });

  it("reports missing links, cycles and isolated operations without pretending a schedule exists", () => {
    const input = plan();
    input.operations[0]!.componentRefs = [{ componentId: "missing-part", role: "output" }];
    input.operations.push({ id: "orphan", name: "孤立返工", standardTimeMinutes: 2, componentRefs: [{ componentId: "frame", role: "in-process" }] });
    input.precedenceRelations.push({ id: "cycle", predecessorOperationId: "finish", successorOperationId: "cut" });
    input.precedenceRelations.push({ id: "missing-op", predecessorOperationId: "cut", successorOperationId: "missing" });
    input.resourceAssignments.push({ id: "missing-resource", operationId: "cut", resourceId: "gone" });

    const result = analyzePprBopVersion(input);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "missing-component-reference", entityId: "cut" }),
      expect.objectContaining({ code: "missing-operation-reference", entityId: "missing-op" }),
      expect.objectContaining({ code: "missing-assignment-reference", entityId: "missing-resource" }),
      expect.objectContaining({ code: "precedence-cycle", entityId: "bop-v1" }),
      expect.objectContaining({ code: "isolated-operation", entityId: "orphan", severity: "warning" }),
    ]));
    expect(result.schedule).toEqual([]);
  });

  it("compares snapshots and marks direct scheduling regressions and their affected entities", () => {
    const before = plan();
    const after = plan();
    after.id = "bop-v2";
    after.version = "2.0";
    after.basedOnVersionId = before.id;
    after.operations.find((item) => item.id === "inspect")!.standardTimeMinutes = 9;
    after.resourceAssignments.find((item) => item.id === "inspect-robot")!.resourceId = "robot";

    const result = comparePprBopVersions(before, after);
    expect(result.changes).toEqual(expect.arrayContaining([
      { entityType: "operation", entityId: "inspect", changeType: "modified", changedFields: ["standardTimeMinutes"] },
      { entityType: "assignment", entityId: "inspect-robot", changeType: "modified", changedFields: ["resourceId"] },
    ]));
    expect(result.impact).toEqual({ componentIds: ["frame"], operationIds: ["inspect"], resourceIds: ["quality", "robot"] });
    expect(result.regressions.map((item) => item.code)).toEqual(expect.arrayContaining([
      "critical-path-increased", "standard-time-increased", "resource-conflict-introduced",
    ]));
  });
});

function plan(): PprBopVersion {
  return {
    id: "bop-v1", planId: "vehicle-door", version: "1.0", name: "车门装配 BOP", createdAt: "2026-08-31T08:00:00.000Z",
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
