import { describe, expect, it } from "vitest";
import { calculateLineBalance } from "./lineBalancing.js";
import { rankPositionalWeights, solveLineBalance } from "./lineBalancingSolve.js";
import type { PprOperation } from "@bim-studio/contracts";

function ops(...entries: Array<[string, number]>): Pick<PprOperation, "id" | "standardTimeMinutes">[] {
  return entries.map(([id, standardTimeMinutes]) => ({ id, standardTimeMinutes }));
}

describe("rankPositionalWeights", () => {
  it("权重=自身+全部下游工时(链式 1→2→3)", () => {
    const { weights } = rankPositionalWeights(ops([ "a", 1 ], [ "b", 2 ], [ "c", 3 ]),
      [ { predecessorOperationId: "a", successorOperationId: "b" },
        { predecessorOperationId: "b", successorOperationId: "c" } ]);
    expect(weights.get("a")).toBe(6);
    expect(weights.get("b")).toBe(5);
    expect(weights.get("c")).toBe(3);
  });

  it("前置环显式拒绝", () => {
    expect(() => rankPositionalWeights(ops([ "a", 1 ], [ "b", 1 ]),
      [ { predecessorOperationId: "a", successorOperationId: "b" },
        { predecessorOperationId: "b", successorOperationId: "a" } ])).toThrow("环");
  });
});

describe("solveLineBalance", () => {
  it("教科书例:5 工序 takt=5,RPW 分配尊重前置且每工位不超节拍", () => {
    // 经典装配线例(a=3,b=2,c=3,d=2,e=3; a→b,c; b→d; c→d; d→e)
    const solution = solveLineBalance({
      operations: ops([ "a", 3 ], [ "b", 2 ], [ "c", 3 ], [ "d", 2 ], [ "e", 3 ]),
      precedenceRelations: [
        { predecessorOperationId: "a", successorOperationId: "b" },
        { predecessorOperationId: "a", successorOperationId: "c" },
        { predecessorOperationId: "b", successorOperationId: "d" },
        { predecessorOperationId: "c", successorOperationId: "d" },
        { predecessorOperationId: "d", successorOperationId: "e" },
      ],
      targetTaktMinutes: 5,
    });
    expect(solution.unscheduledOperationIds).toEqual([]);
    const byStation = new Map<string, number>();
    for (const assignment of solution.assignments) {
      byStation.set(assignment.stationId, (byStation.get(assignment.stationId) ?? 0) + 1);
    }
    // 前置顺序:a 在 b/c 前,b/c 在 d 前,d 在 e 前
    const position = new Map(solution.assignments.map((item) => [item.operationId, item.stationId]));
    expect(position.get("b")).toBeDefined();
    const stationOf = (id: string) => solution.assignments.find((item) => item.operationId === id)!.stationId;
    expect(stationOf("a") === stationOf("b") || Number(stationOf("a").split("-")[1]) < Number(stationOf("b").split("-")[1])).toBe(true);
    // 每工位装载 ≤ takt
    const loads = new Map<string, number>();
    const time = new Map([["a", 3], ["b", 2], ["c", 3], ["d", 2], ["e", 3]]);
    for (const assignment of solution.assignments) {
      loads.set(assignment.stationId, (loads.get(assignment.stationId) ?? 0) + time.get(assignment.operationId)!);
    }
    for (const load of loads.values()) expect(load).toBeLessThanOrEqual(5);
    expect(solution.cycleMinutes).toBeLessThanOrEqual(5);
  });

  it("单工序超节拍如实进 unscheduled,不塞入任何工位", () => {
    const solution = solveLineBalance({
      operations: ops([ "small", 2 ], [ "huge", 8 ]),
      precedenceRelations: [],
      targetTaktMinutes: 5,
    });
    expect(solution.unscheduledOperationIds).toEqual([ "huge" ]);
    expect(solution.assignments.map((item) => item.operationId)).toEqual([ "small" ]);
  });

  it("同输入两次求解逐位一致(确定性)", () => {
    const input = {
      operations: ops([ "o1", 4 ], [ "o2", 3 ], [ "o3", 5 ], [ "o4", 1 ]),
      precedenceRelations: [ { predecessorOperationId: "o1", successorOperationId: "o2" },
        { predecessorOperationId: "o1", successorOperationId: "o3" } ],
      targetTaktMinutes: 6,
    };
    expect(solveLineBalance(input)).toEqual(solveLineBalance(input));
  });

  it("闭环:solve 的分配喂给 calculateLineBalance,效率与过载结论自洽", () => {
    const operations: PprOperation[] = [
      { id: "a", name: "A", standardTimeMinutes: 3, componentRefs: [] },
      { id: "b", name: "B", standardTimeMinutes: 2, componentRefs: [] },
      { id: "c", name: "C", standardTimeMinutes: 3, componentRefs: [] },
    ];
    const precedence = [
      { id: "p1", predecessorOperationId: "a", successorOperationId: "b" },
      { id: "p2", predecessorOperationId: "a", successorOperationId: "c" },
    ];
    const solution = solveLineBalance({ operations, precedenceRelations: precedence, targetTaktMinutes: 5 });
    const version = {
      targetTaktMinutes: 5,
      operations: operations.map((operation) => ({ ...operation })),
      resources: [...new Set(solution.assignments.map((item) => item.stationId))].map((stationId) => ({
        id: stationId, name: stationId, kind: "station" as const, capacity: 1,
      })),
      resourceAssignments: solution.assignments.map((assignment) => ({
        operationId: assignment.operationId, resourceId: assignment.stationId, requiredCapacity: 1,
      })),
      precedenceRelations: precedence,
    };
    const evaluation = calculateLineBalance(version, new Map(operations.map((operation) => [operation.id, operation])));
    expect(evaluation.overloadedResourceIds).toEqual([]);
    expect(evaluation.balanceEfficiency ?? 0).toBeGreaterThan(0.5);
    expect(evaluation.unassignedOperationIds).toEqual([]);
  });
});
