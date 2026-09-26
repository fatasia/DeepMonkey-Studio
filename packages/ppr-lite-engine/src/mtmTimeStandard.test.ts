/**
 * MTM 工时分解断言:分解求和、部分覆盖桥接、非法输入拒绝、
 * 与 solveLineBalance 端到端(MTM 分解 → 标准工时 → RPW 求解)。
 */

import { describe, expect, it } from "vitest";
import type { MtmCodeApplication } from "@bim-studio/contracts";
import { applyMtmToOperations, resolveStandardTime } from "./mtmTimeStandard.js";
import { solveLineBalance } from "./lineBalancingSolve.js";

describe("resolveStandardTime", () => {
  it("标准工时 = Σ(minutes×count)+固定值,derived=true 并给出分解口径", () => {
    const resolution = resolveStandardTime({
      operationId: "op-1",
      codes: [
        { code: "M10G1", count: 2, minutesPerApplication: 1.3, variant: "MTM-1" },
        { code: "R15E1", count: 1, minutesPerApplication: 0.4 },
      ],
      overrides: { setupMinutes: 1 },
    }, 99);
    expect(resolution.standardTimeMinutes).toBeCloseTo(1.3 * 2 + 0.4 + 1, 10);
    expect(resolution.derived).toBe(true);
    expect(resolution.codeSumMinutes).toBeCloseTo(3, 10);
    expect(resolution.setupMinutes).toBe(1);
    expect(resolution.processingMinutes).toBe(0);
  });

  it("无分解申请时回退手填工时,derived=false", () => {
    const resolution = resolveStandardTime(undefined, 7.5);
    expect(resolution).toEqual({ standardTimeMinutes: 7.5, derived: false });
  });

  it("非法输入拒绝:空代码、count<1、负分钟、负固定值、空 codes、负 fallback", () => {
    const base: MtmCodeApplication = { operationId: "op-1", codes: [{ code: "M10G1", count: 1, minutesPerApplication: 1 }] };
    expect(() => resolveStandardTime({ ...base, codes: [{ code: " ", count: 1, minutesPerApplication: 1 }] }, 1)).toThrow(/空 MTM 代码/);
    expect(() => resolveStandardTime({ ...base, codes: [{ code: "M", count: 0, minutesPerApplication: 1 }] }, 1)).toThrow(/应用次数/);
    expect(() => resolveStandardTime({ ...base, codes: [{ code: "M", count: 1.5, minutesPerApplication: 1 }] }, 1)).toThrow(/应用次数/);
    expect(() => resolveStandardTime({ ...base, codes: [{ code: "M", count: 1, minutesPerApplication: -0.1 }] }, 1)).toThrow(/分钟数/);
    expect(() => resolveStandardTime({ ...base, overrides: { setupMinutes: -1 } }, 1)).toThrow(/setupMinutes/);
    expect(() => resolveStandardTime({ ...base, codes: [] }, 1)).toThrow(/至少需要一条/);
    expect(() => resolveStandardTime(null, -1)).toThrow(/fallback/);
  });
});

describe("applyMtmToOperations", () => {
  it("部分覆盖:被覆盖工序换成 MTM 工时,未覆盖保持原值,原数组不被修改", () => {
    const operations = [
      { id: "a", standardTimeMinutes: 10 },
      { id: "b", standardTimeMinutes: 10 },
    ];
    const bridged = applyMtmToOperations(operations, [
      { operationId: "a", codes: [{ code: "M10G1", count: 2, minutesPerApplication: 2 }] },
    ]);
    expect(bridged).toHaveLength(2);
    expect(bridged[0]!.standardTimeMinutes).toBe(4);
    expect(bridged[1]!.standardTimeMinutes).toBe(10);
    expect(bridged[1]).toBe(operations[1]);
    expect(operations[0]!.standardTimeMinutes).toBe(10);
  });

  it("重复分解与指向不存在工序的分解都拒绝", () => {
    const operations = [{ id: "a", standardTimeMinutes: 1 }];
    const app = { operationId: "a", codes: [{ code: "M", count: 1, minutesPerApplication: 1 }] };
    expect(() => applyMtmToOperations(operations, [app, { ...app }])).toThrow(/口径不唯一/);
    expect(() => applyMtmToOperations(operations, [{ ...app, operationId: "ghost" }])).toThrow(/不存在的工序/);
  });
});

describe("MTM → solveLineBalance 端到端", () => {
  it("MTM 分解后的工时喂给求解器:takt=5 时 3 工序排进 2 工位且不超节拍", () => {
    const raw = [
      { id: "op-a", standardTimeMinutes: 10 },
      { id: "op-b", standardTimeMinutes: 10 },
      { id: "op-c", standardTimeMinutes: 3 },
    ];
    const bridged = applyMtmToOperations(raw, [
      {
        operationId: "op-a",
        codes: [
          { code: "M10G1", count: 2, minutesPerApplication: 1.3 },
          { code: "R15E1", count: 1, minutesPerApplication: 0.4 },
        ],
        overrides: { setupMinutes: 1 },
      },
      { operationId: "op-b", codes: [{ code: "T01", count: 3, minutesPerApplication: 0.5 }] },
    ]);
    expect(bridged.map((operation) => operation.standardTimeMinutes)).toEqual([4, 1.5, 3]);
    const solution = solveLineBalance({
      operations: bridged,
      precedenceRelations: [
        { predecessorOperationId: "op-a", successorOperationId: "op-b" },
        { predecessorOperationId: "op-b", successorOperationId: "op-c" },
      ],
      targetTaktMinutes: 5,
    });
    expect(solution.unscheduledOperationIds).toEqual([]);
    expect(solution.stationsUsed).toBe(2);
    expect(solution.cycleMinutes).toBeCloseTo(4.5, 10);
    const stationOf = (operationId: string): string =>
      solution.assignments.find((assignment) => assignment.operationId === operationId)!.stationId;
    expect(stationOf("op-a")).toBe("Station-1");
    expect(stationOf("op-b")).toBe("Station-2");
    expect(stationOf("op-c")).toBe("Station-2");
    // 对照:未做 MTM 分解的原始手填工时(10/10/3)在 takt=5 下无解;
    // op-a/op-b 超节拍进 unscheduled 后,op-c 因前驱未排同样不可调度。
    const rawSolution = solveLineBalance({
      operations: raw,
      precedenceRelations: [
        { predecessorOperationId: "op-a", successorOperationId: "op-b" },
        { predecessorOperationId: "op-b", successorOperationId: "op-c" },
      ],
      targetTaktMinutes: 5,
    });
    expect(rawSolution.unscheduledOperationIds).toEqual(["op-a", "op-b", "op-c"]);
  });
});
