import { describe, expect, it } from "vitest";
import type { PprBopVersionDraft } from "@bim-studio/contracts";
import { proposePprRpw } from "./pprRpwProposal";

function draft(): PprBopVersionDraft {
  return {
    planId: "plan-1", name: "生产线", targetTaktMinutes: 4,
    components: [{ id: "p", name: "产品", kind: "product" }],
    operations: [
      { id: "a", name: "定位", standardTimeMinutes: 2, componentRefs: [] },
      { id: "b", name: "装配", standardTimeMinutes: 2, componentRefs: [] },
    ],
    precedenceRelations: [{ id: "ab", predecessorOperationId: "a", successorOperationId: "b" }],
    resources: [{ id: "s", name: "工位", kind: "station" }, { id: "r", name: "机器人", kind: "robot" }],
    resourceAssignments: [{ id: "robot-a", operationId: "a", resourceId: "r" }],
  };
}

describe("PPR RPW consumer", () => {
  it("offers deterministic station allocations preserving non-station assignments and source", () => {
    const source = draft();
    const first = proposePprRpw(source);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;
    expect(first.assignments).toEqual([
      { id: "robot-a", operationId: "a", resourceId: "r" },
      { id: "rpw-a", operationId: "a", resourceId: "s", requiredCapacity: 1 },
      { id: "rpw-b", operationId: "b", resourceId: "s", requiredCapacity: 1 },
    ]);
    expect(proposePprRpw(source)).toEqual(first);
    expect(source.resourceAssignments).toHaveLength(1);
  });

  it("refuses infeasible, conditional and unsupported-capacity allocations", () => {
    const impossible = draft();
    impossible.operations[0]!.standardTimeMinutes = 5;
    expect(proposePprRpw(impossible)).toMatchObject({ status: "blocked" });
    const conditional = draft();
    conditional.precedenceRelations[0]!.condition = { expression: "EU" };
    expect(proposePprRpw(conditional)).toMatchObject({ status: "blocked", reason: expect.stringContaining("条件") });
    const parallel = draft();
    parallel.resources[0]!.capacity = 2;
    expect(proposePprRpw(parallel)).toMatchObject({ status: "blocked", reason: expect.stringContaining("多并行") });
    const noTarget = draft();
    delete noTarget.targetTaktMinutes;
    expect(proposePprRpw(noTarget)).toMatchObject({ status: "blocked" });
    const loop = draft();
    loop.precedenceRelations.push({ id: "ba", predecessorOperationId: "b", successorOperationId: "a" });
    expect(proposePprRpw(loop)).toMatchObject({ status: "blocked", reason: expect.stringContaining("环") });
  });
});
