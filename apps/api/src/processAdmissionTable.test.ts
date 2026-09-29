import { describe, expect, it } from "vitest";
import type { ProcessAdmissionPlan, ProcessAdmissionReport } from "@bim-studio/contracts";
import { ProcessAdmissionBlockedError, assertFormalPredictionAdmissible, evaluateProcessAdmission } from "./processAdmissionTable.js";

function plan(versionId: string, overrides: Partial<ProcessAdmissionPlan> = {}): ProcessAdmissionPlan {
  return {
    planId: "admission-plan",
    versionId,
    operations: [],
    precedenceRelations: [],
    resources: [],
    resourceAssignments: [],
    ...overrides,
  };
}

function op(id: string, name: string): ProcessAdmissionPlan["operations"][number] {
  return { id, name, standardTimeMinutes: 5, componentRefs: [] };
}

function rel(id: string, predecessorOperationId: string, successorOperationId: string, minimumLagMinutes?: number): ProcessAdmissionPlan["precedenceRelations"][number] {
  return minimumLagMinutes === undefined
    ? { id, predecessorOperationId, successorOperationId }
    : { id, predecessorOperationId, successorOperationId, minimumLagMinutes };
}

function res(id: string, kind: ProcessAdmissionPlan["resources"][number]["kind"]): ProcessAdmissionPlan["resources"][number] {
  return { id, name: `${kind}-${id}`, kind };
}

function asg(id: string, operationId: string, resourceId: string, requiredCapacity?: number): ProcessAdmissionPlan["resourceAssignments"][number] {
  return requiredCapacity === undefined ? { id, operationId, resourceId } : { id, operationId, resourceId, requiredCapacity };
}

describe("非线性工艺映射准入表（C2）", () => {
  it("顺序基线：单前置单后继链产出唯一 direct 顺序行，放行正式预测", () => {
    const report = evaluateProcessAdmission(plan("v1", {
      operations: [op("A", "下料"), op("B", "加工"), op("C", "检验")],
      precedenceRelations: [rel("r1", "A", "B"), rel("r2", "B", "C")],
    }));
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ structure: "sequential-flow", verdict: "direct", reasonCode: "sequential-direct" });
    expect(report.formalPredictionAllowed).toBe(true);
    expect(report.blockingReasonCodes).toEqual([]);
    expect(report.counts).toEqual({ total: 1, direct: 1, mappedReview: 0, blocked: 0 });
  });

  it("AND 汇合（验收原文独立成测）：两个不同前置构成 AND 汇合，判 blocked 且报无等价表达", () => {
    const report = evaluateProcessAdmission(plan("v2", {
      operations: [op("A", "件1装配准备"), op("B", "件2装配准备"), op("D", "合装")],
      precedenceRelations: [rel("r1", "A", "D"), rel("r2", "B", "D")],
    }));
    const join = report.entries.find((entry) => entry.structure === "and-join-convergence");
    expect(join).toBeDefined();
    expect(join).toMatchObject({ verdict: "blocked", reasonCode: "multiple-predecessors" });
    expect(join!.message).toContain("无等价表达");
    expect(join!.subjectIds).toEqual(["D", "A", "B"]);
    expect(report.formalPredictionAllowed).toBe(false);
    expect(report.blockingReasonCodes).toEqual(["multiple-predecessors"]);
  });

  it("AND 汇合阻断门：准入报告阻断级结论使正式预测门抛 ProcessAdmissionBlockedError（fail-closed）", () => {
    const report = evaluateProcessAdmission(plan("v3", {
      operations: [op("A", "备料"), op("B", "齐套"), op("D", "合装")],
      precedenceRelations: [rel("r1", "A", "D"), rel("r2", "B", "D")],
    }));
    expect(() => assertFormalPredictionAdmissible(report)).toThrow(ProcessAdmissionBlockedError);
    try {
      assertFormalPredictionAdmissible(report);
      expect.unreachable("阻断门必须抛出");
    } catch (error) {
      expect(error).toBeInstanceOf(ProcessAdmissionBlockedError);
      expect((error as ProcessAdmissionBlockedError).reasonCodes).toEqual(["multiple-predecessors"]);
      expect((error as ProcessAdmissionBlockedError).report.formalPredictionAllowed).toBe(false);
    }
  });

  it("阻断与命名无关：去掉 -review-only 后缀的版本 ID 无法绕过结构级阻断门", () => {
    const bypassed = plan("v1-release-candidate", {
      operations: [op("A", "备料"), op("B", "齐套"), op("D", "合装")],
      precedenceRelations: [rel("r1", "A", "D"), rel("r2", "B", "D")],
    });
    expect(bypassed.versionId).not.toContain("-review-only");
    expect(() => assertFormalPredictionAdmissible(bypassed)).toThrow(ProcessAdmissionBlockedError);
  });

  it("阻断门对全 direct 报告放行并原样返回报告；也接受直接传入 BOP 投影", () => {
    const clean = plan("v4", { operations: [op("A", "下料"), op("B", "检验")], precedenceRelations: [rel("r1", "A", "B")] });
    const fromPlan = assertFormalPredictionAdmissible(clean);
    expect(fromPlan.formalPredictionAllowed).toBe(true);
    const fromReport: ProcessAdmissionReport = evaluateProcessAdmission(clean);
    expect(assertFormalPredictionAdmissible(fromReport)).toBe(fromReport);
  });

  it("分流：≥2 后继映射为占位分流（mapped-review），正式预测保持阻断直到份额人工校正", () => {
    const report = evaluateProcessAdmission(plan("v5", {
      operations: [op("A", "分派"), op("B", "车削"), op("C", "铣削"), op("D", "磨削")],
      precedenceRelations: [rel("r1", "A", "B"), rel("r2", "A", "C"), rel("r3", "A", "D")],
    }));
    const split = report.entries.find((entry) => entry.structure === "branch-split");
    expect(split).toMatchObject({ verdict: "mapped-review", reasonCode: "multiple-successors" });
    expect(split!.message).toContain("份额");
    expect(report.formalPredictionAllowed).toBe(false);
    expect(report.blockingReasonCodes).toEqual(["multiple-successors"]);
  });

  it("联合占用白名单：1 台机器人 + 1 名人员各占 1 单位判 direct，放行正式预测", () => {
    const report = evaluateProcessAdmission(plan("v6", {
      operations: [op("W", "人机协作装配")],
      resources: [res("eq", "robot"), res("w1", "person")],
      resourceAssignments: [asg("a1", "W", "eq"), asg("a2", "W", "w1")],
    }));
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ structure: "joint-equipment-worker", verdict: "direct", reasonCode: "joint-occupancy-whitelist" });
    expect(report.formalPredictionAllowed).toBe(true);
  });

  it("白名单外：两台设备联合占用判 blocked multiple-resources，附分解指引", () => {
    const report = evaluateProcessAdmission(plan("v7", {
      operations: [op("X", "双机联合作业")],
      resources: [res("eq1", "equipment"), res("eq2", "equipment")],
      resourceAssignments: [asg("a1", "X", "eq1"), asg("a2", "X", "eq2")],
    }));
    const multi = report.entries.find((entry) => entry.structure === "multi-resource-atomic-lock");
    expect(multi).toMatchObject({ verdict: "blocked", reasonCode: "multiple-resources" });
    expect(multi!.message).toContain("分解工序");
    expect(report.formalPredictionAllowed).toBe(false);
  });

  it("白名单边界：人员占用 2 单位超出各占 1 单位，判 blocked", () => {
    const report = evaluateProcessAdmission(plan("v8", {
      operations: [op("Y", "双人位协作")],
      resources: [res("eq", "equipment"), res("w1", "person")],
      resourceAssignments: [asg("a1", "Y", "eq"), asg("a2", "Y", "w1", 2)],
    }));
    expect(report.entries[0]).toMatchObject({ structure: "multi-resource-atomic-lock", verdict: "blocked", reasonCode: "multiple-resources" });
    expect(report.entries[0]!.message).toContain("占用 2 单位");
    expect(report.formalPredictionAllowed).toBe(false);
  });

  it("未登记资源不能机判等价：分配引用不在资源清单的 ID 时 fail-closed 判 blocked", () => {
    const report = evaluateProcessAdmission(plan("v9", {
      operations: [op("Z", "未知资源作业")],
      resources: [res("w1", "person")],
      resourceAssignments: [asg("a1", "Z", "ghost-equipment"), asg("a2", "Z", "w1")],
    }));
    expect(report.entries[0]).toMatchObject({ structure: "multi-resource-atomic-lock", verdict: "blocked", reasonCode: "multiple-resources" });
    expect(report.entries[0]!.message).toContain("未在 BOP 资源清单登记");
  });

  it("最小滞后：lag>0 判 blocked 且明示禁止折入加工时间；lag=0/缺省不产生滞后行", () => {
    const lagged = evaluateProcessAdmission(plan("v10", {
      operations: [op("P", "喷涂"), op("Q", "固化后包装")],
      precedenceRelations: [rel("r1", "P", "Q", 5)],
    }));
    const lag = lagged.entries.find((entry) => entry.structure === "minimum-lag");
    expect(lag).toMatchObject({ verdict: "blocked", reasonCode: "minimum-lag" });
    expect(lag!.message).toContain("禁止折入加工时间");
    expect(lagged.formalPredictionAllowed).toBe(false);

    const zeroLag = evaluateProcessAdmission(plan("v10b", {
      operations: [op("P", "喷涂"), op("Q", "包装")],
      precedenceRelations: [rel("r1", "P", "Q", 0)],
    }));
    expect(zeroLag.entries.map((entry) => entry.structure)).toEqual(["sequential-flow"]);
    expect(zeroLag.formalPredictionAllowed).toBe(true);
  });

  it("复合结构：分流与滞后并存时各行独立出具结论，滞后不被分流行掩盖", () => {
    const report = evaluateProcessAdmission(plan("v11", {
      operations: [op("A", "分派"), op("B", "热处理"), op("C", "机加")],
      precedenceRelations: [rel("r1", "A", "B", 10), rel("r2", "A", "C")],
    }));
    expect(report.entries.map((entry) => `${entry.structure}/${entry.reasonCode}`).sort()).toEqual([
      "branch-split/multiple-successors",
      "minimum-lag/minimum-lag",
    ]);
    expect(report.formalPredictionAllowed).toBe(false);
  });

  it("计数与阻断码去重：两个分流工序计 mappedReview=2，阻断码只出现一次", () => {
    const report = evaluateProcessAdmission(plan("v12", {
      operations: [op("S1", "分派一"), op("A", "车削"), op("B", "铣削"), op("S2", "分派二"), op("C", "打磨"), op("D", "抛光")],
      precedenceRelations: [rel("r1", "S1", "A"), rel("r2", "S1", "B"), rel("r3", "S2", "C"), rel("r4", "S2", "D")],
    }));
    expect(report.counts).toEqual({ total: 2, direct: 0, mappedReview: 2, blocked: 0 });
    expect(report.blockingReasonCodes).toEqual(["multiple-successors"]);
  });

  it("重复关系边不放大结构判定：同一前置重复两条不构成 AND 汇合", () => {
    const report = evaluateProcessAdmission(plan("v13", {
      operations: [op("A", "下料"), op("B", "加工")],
      precedenceRelations: [rel("r1", "A", "B"), rel("r2", "A", "B")],
    }));
    expect(report.entries.map((entry) => entry.structure)).toEqual(["sequential-flow"]);
    expect(report.formalPredictionAllowed).toBe(true);
  });

  it("条件前置仍构成 AND 汇合：条件不执行无法机判齐套成立", () => {
    const report = evaluateProcessAdmission(plan("v14", {
      operations: [op("B", "标准件装配准备"), op("C", "选配件装配准备"), op("D", "合装")],
      precedenceRelations: [rel("r1", "B", "D"), { id: "r2", predecessorOperationId: "C", successorOperationId: "D", condition: { expression: "order.hasOption=TRUE" } }],
    }));
    expect(report.entries[0]).toMatchObject({ structure: "and-join-convergence", verdict: "blocked", reasonCode: "multiple-predecessors" });
    expect(report.formalPredictionAllowed).toBe(false);
  });

  it("空工艺与悬空前置：空图产出顺序基线行；指向不存在工序的关系不参与判定", () => {
    const empty = evaluateProcessAdmission(plan("v15"));
    expect(empty.entries.map((entry) => entry.structure)).toEqual(["sequential-flow"]);
    expect(empty.formalPredictionAllowed).toBe(true);

    const dangling = evaluateProcessAdmission(plan("v15b", {
      operations: [op("A", "下料"), op("B", "加工")],
      precedenceRelations: [rel("r1", "A", "B"), rel("r2", "A", "ghost"), rel("r3", "ghost", "B")],
    }));
    expect(dangling.entries.map((entry) => entry.structure)).toEqual(["sequential-flow"]);
  });
});
