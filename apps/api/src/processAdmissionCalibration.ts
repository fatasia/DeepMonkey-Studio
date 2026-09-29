import { createHash } from "node:crypto";
import type {
  PprOperation,
  PprOperationResourceAssignment,
  PprPrecedenceRelation,
  PprResource,
  ProcessAdmissionPlan,
  ProcessAdmissionReasonCode,
  ProcessAdmissionStructure,
  ProcessAdmissionVerdict,
} from "@bim-studio/contracts";
import { evaluateProcessAdmission } from "./processAdmissionTable.js";

/**
 * 独立校准集（C2 后半项）：训练/保留两分，保留集误差如实输出，不粉饰。
 *
 * - 标签独立于实现：每个用例的期望只到结论纪律级（结构 + verdict + 理由码），
 *   出处标注 N8 语义准入表对应行或验收原文判据；标签不读实现、实现不读标签。
 * - 训练集（training）：映射规则开发时对照的 N8 表逐行正例；
 *   保留集（holdout）：规则冻结后评估的复合/边界用例，只测不改。
 * - 确定性可重放：语料为字面量纯构建（无时钟、无随机），指纹对排序键规范化后取 SHA-256。
 */

export interface ProcessAdmissionExpectationRow {
  structure: ProcessAdmissionStructure;
  verdict: ProcessAdmissionVerdict;
  reasonCode: ProcessAdmissionReasonCode;
}

export interface ProcessAdmissionExpectation {
  /** 期望的结构行多重集（不含顺序基线行；空数组 = 纯顺序，评估器应恰好产出顺序基线行）。 */
  structures: ProcessAdmissionExpectationRow[];
  formalPredictionAllowed: boolean;
}

export interface ProcessAdmissionCalibrationCase {
  id: string;
  /** 标签出处：N8 语义准入表对应行或验收原文判据。 */
  basis: string;
  plan: ProcessAdmissionPlan;
  expectation: ProcessAdmissionExpectation;
}

export interface ProcessAdmissionCalibrationCorpus {
  training: ProcessAdmissionCalibrationCase[];
  holdout: ProcessAdmissionCalibrationCase[];
}

export interface ProcessAdmissionCaseResult {
  caseId: string;
  pass: boolean;
  expectedStructures: ProcessAdmissionExpectationRow[];
  actualStructures: ProcessAdmissionExpectationRow[];
  expectedFormalPredictionAllowed: boolean;
  actualFormalPredictionAllowed: boolean;
  mismatches: string[];
}

export interface ProcessAdmissionSplitResult {
  split: "training" | "holdout";
  total: number;
  passed: number;
  /** 误差如实计数：期望与实际结论纪律不一致的用例数，不因任何一方被粉饰。 */
  errorCount: number;
  errorRate: number;
  cases: ProcessAdmissionCaseResult[];
}

export interface ProcessAdmissionCalibrationSummary {
  corpusFingerprint: string;
  training: ProcessAdmissionSplitResult;
  holdout: ProcessAdmissionSplitResult;
  /** 准入表覆盖的结构行数（含顺序基线行）。 */
  coveredStructures: number;
  /** 校准集中期望被阻断正式预测的用例数。 */
  rejectionCases: number;
  /** 校准集中期望的 mapped-review + blocked 结构行数。 */
  rejectionEntries: number;
}

export function buildProcessAdmissionCalibrationCorpus(): ProcessAdmissionCalibrationCorpus {
  return {
    training: [
      caseRow(
        "T1-sequential-baseline",
        "N8 表：顺序工序 direct（单前置单后继直连）",
        plan("v1", [operation("A", "下料"), operation("B", "加工"), operation("C", "检验")], [relation("r1", "A", "B"), relation("r2", "B", "C")], [], []),
        { structures: [], formalPredictionAllowed: true },
      ),
      caseRow(
        "T2-split-three-branch",
        "N8 表：分流 mapped-review（BOP 不含路由份额，均分占位）",
        plan("v2", [operation("A", "分派"), operation("B", "车削"), operation("C", "铣削"), operation("D", "磨削")], [relation("r1", "A", "B"), relation("r2", "A", "C"), relation("r3", "A", "D")], [], []),
        { structures: [row("branch-split", "mapped-review", "multiple-successors")], formalPredictionAllowed: false },
      ),
      caseRow(
        "T3-and-join-two-preds",
        "验收原文：AND 汇合无等价表达则阻断正式预测",
        plan("v3", [operation("A", "件1装配准备"), operation("B", "件2装配准备"), operation("D", "合装")], [relation("r1", "A", "D"), relation("r2", "B", "D")], [], []),
        { structures: [row("and-join-convergence", "blocked", "multiple-predecessors")], formalPredictionAllowed: false },
      ),
      caseRow(
        "T4-joint-occupancy-whitelist",
        "N8 表：设备与人工联合占用白名单（1 设备 + 1 人员各占 1 单位）direct",
        plan("v4", [operation("W", "人机协作装配")], [], [resource("eq", "协作机器人", "robot"), resource("w1", "装配工", "person")], [assignment("a1", "W", "eq"), assignment("a2", "W", "w1")]),
        { structures: [row("joint-equipment-worker", "direct", "joint-occupancy-whitelist")], formalPredictionAllowed: true },
      ),
      caseRow(
        "T5-multi-resource-two-equipment",
        "N8 表：白名单外多资源原子锁 blocked",
        plan("v5", [operation("X", "双机联合作业")], [], [resource("eq1", "压力机", "equipment"), resource("eq2", "翻转机", "equipment")], [assignment("a1", "X", "eq1"), assignment("a2", "X", "eq2")]),
        { structures: [row("multi-resource-atomic-lock", "blocked", "multiple-resources")], formalPredictionAllowed: false },
      ),
      caseRow(
        "T6-minimum-lag",
        "N8 表：最小滞后 blocked（禁止折入加工时间偷换语义）",
        plan("v6", [operation("P", "喷涂"), operation("Q", "固化后包装")], [relation("r1", "P", "Q", 5)], [], []),
        { structures: [row("minimum-lag", "blocked", "minimum-lag")], formalPredictionAllowed: false },
      ),
    ],
    holdout: [
      caseRow(
        "H1-split-with-lag-branch",
        "N8 表：滞后按全部关系逐条独立判定，不被分流行掩盖",
        plan("h1", [operation("A", "分派"), operation("B", "热处理"), operation("C", "机加")], [relation("r1", "A", "B", 10), relation("r2", "A", "C")], [], []),
        {
          structures: [row("branch-split", "mapped-review", "multiple-successors"), row("minimum-lag", "blocked", "minimum-lag")],
          formalPredictionAllowed: false,
        },
      ),
      caseRow(
        "H2-join-inside-branch",
        "N8 表：分叉与 AND 汇合并存时各行独立出具结论",
        plan(
          "h2",
          [operation("A", "分派"), operation("B", "支线一"), operation("C", "支线二"), operation("D", "合装")],
          [relation("r1", "A", "B"), relation("r2", "A", "C"), relation("r3", "B", "D"), relation("r4", "C", "D")],
          [], [],
        ),
        {
          structures: [row("branch-split", "mapped-review", "multiple-successors"), row("and-join-convergence", "blocked", "multiple-predecessors")],
          formalPredictionAllowed: false,
        },
      ),
      caseRow(
        "H3-join-with-joint-whitelist",
        "N8 表：联合占用白名单不掩盖 AND 汇合阻断",
        plan(
          "h3",
          [operation("B", "件1装配准备"), operation("C", "件2装配准备"), operation("D", "人机协作合装")],
          [relation("r1", "B", "D"), relation("r2", "C", "D")],
          [resource("eq", "装配机器人", "robot"), resource("w1", "装配工", "person")],
          [assignment("a1", "D", "eq"), assignment("a2", "D", "w1")],
        ),
        {
          structures: [row("joint-equipment-worker", "direct", "joint-occupancy-whitelist"), row("and-join-convergence", "blocked", "multiple-predecessors")],
          formalPredictionAllowed: false,
        },
      ),
      caseRow(
        "H4-whitelist-boundary-person-two-units",
        "N8 白名单边界：各占 1 单位，人员占用 2 单位即白名单外",
        plan("h4", [operation("Y", "双人位协作")], [], [resource("eq", "协作设备", "equipment"), resource("w1", "装配工", "person")], [assignment("a1", "Y", "eq"), assignment("a2", "Y", "w1", 2)]),
        { structures: [row("multi-resource-atomic-lock", "blocked", "multiple-resources")], formalPredictionAllowed: false },
      ),
      caseRow(
        "H5-non-whitelist-tool-person",
        "N8 白名单：仅 设备/机器人 + 人员；tool 类不在白名单",
        plan("h5", [operation("Z", "工装夹持作业")], [], [resource("tl", "专用工装", "tool"), resource("w1", "操作工", "person")], [assignment("a1", "Z", "tl"), assignment("a2", "Z", "w1")]),
        { structures: [row("multi-resource-atomic-lock", "blocked", "multiple-resources")], formalPredictionAllowed: false },
      ),
      caseRow(
        "H6-lag-zero-no-entry",
        "N8 表：最小滞后 0/缺省不阻断",
        plan("h6", [operation("P", "喷涂"), operation("Q", "包装")], [relation("r1", "P", "Q", 0)], [], []),
        { structures: [], formalPredictionAllowed: true },
      ),
      caseRow(
        "H7-conditional-predecessor-still-join",
        "N8 表：含条件前置仍构成 AND 汇合（条件不执行无法机判齐套成立）",
        plan(
          "h7",
          [operation("B", "标准件装配准备"), operation("C", "选配件装配准备"), operation("D", "合装")],
          [relation("r1", "B", "D"), { id: "r2", predecessorOperationId: "C", successorOperationId: "D", condition: { expression: "order.hasOption=TRUE" } }],
          [], [],
        ),
        { structures: [row("and-join-convergence", "blocked", "multiple-predecessors")], formalPredictionAllowed: false },
      ),
    ],
  };
}

export function runProcessAdmissionCalibration(corpus: ProcessAdmissionCalibrationCorpus = buildProcessAdmissionCalibrationCorpus()): ProcessAdmissionCalibrationSummary {
  const training = runSplit("training", corpus.training);
  const holdout = runSplit("holdout", corpus.holdout);
  const allCases = [...corpus.training, ...corpus.holdout];
  const covered = new Set<ProcessAdmissionStructure>();
  for (const calibrationCase of allCases) {
    for (const structureRow of calibrationCase.expectation.structures) covered.add(structureRow.structure);
    if (!calibrationCase.expectation.structures.length) covered.add("sequential-flow");
  }
  return {
    corpusFingerprint: corpusFingerprint(corpus),
    training,
    holdout,
    coveredStructures: covered.size,
    rejectionCases: allCases.filter((calibrationCase) => !calibrationCase.expectation.formalPredictionAllowed).length,
    rejectionEntries: allCases.reduce(
      (count, calibrationCase) => count + calibrationCase.expectation.structures.filter((row) => row.verdict !== "direct").length,
      0,
    ),
  };
}

function runSplit(split: "training" | "holdout", cases: ProcessAdmissionCalibrationCase[]): ProcessAdmissionSplitResult {
  const results = cases.map(matchCase);
  const errorCount = results.filter((result) => !result.pass).length;
  return {
    split,
    total: results.length,
    passed: results.length - errorCount,
    errorCount,
    errorRate: results.length ? errorCount / results.length : 0,
    cases: results,
  };
}

function matchCase(calibrationCase: ProcessAdmissionCalibrationCase): ProcessAdmissionCaseResult {
  const report = evaluateProcessAdmission(calibrationCase.plan);
  const actualStructures = report.entries
    .filter((entry) => entry.structure !== "sequential-flow")
    .map((entry) => ({ structure: entry.structure, verdict: entry.verdict, reasonCode: entry.reasonCode }));
  const expectedStructures = calibrationCase.expectation.structures;
  const mismatches: string[] = [];
  const remaining = [...actualStructures];
  for (const expectedRow of expectedStructures) {
    const index = remaining.findIndex(
      (actualRow) => actualRow.structure === expectedRow.structure && actualRow.verdict === expectedRow.verdict && actualRow.reasonCode === expectedRow.reasonCode,
    );
    if (index === -1) mismatches.push(`缺少期望结构行 ${expectedRow.structure}/${expectedRow.verdict}/${expectedRow.reasonCode}`);
    else remaining.splice(index, 1);
  }
  for (const extraRow of remaining) mismatches.push(`多余结构行 ${extraRow.structure}/${extraRow.verdict}/${extraRow.reasonCode}`);
  const baselineRows = report.entries.filter((entry) => entry.structure === "sequential-flow");
  if (!expectedStructures.length && baselineRows.length !== 1) mismatches.push("纯顺序用例应恰好产出 1 行顺序基线 direct 结论");
  if (expectedStructures.length && baselineRows.length) mismatches.push("存在非线性结构行时不应再产出顺序基线行");
  if (report.formalPredictionAllowed !== calibrationCase.expectation.formalPredictionAllowed) {
    mismatches.push(`formalPredictionAllowed 期望 ${calibrationCase.expectation.formalPredictionAllowed}，实际 ${report.formalPredictionAllowed}`);
  }
  return {
    caseId: calibrationCase.id,
    pass: !mismatches.length,
    expectedStructures,
    actualStructures,
    expectedFormalPredictionAllowed: calibrationCase.expectation.formalPredictionAllowed,
    actualFormalPredictionAllowed: report.formalPredictionAllowed,
    mismatches,
  };
}

/** 语料指纹：排序键规范化 JSON 的 SHA-256，两次独立重放必得同值。 */
function corpusFingerprint(corpus: ProcessAdmissionCalibrationCorpus): string {
  return createHash("sha256").update(stableStringify(corpus)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ---------------------------------------------------------------------------
// 语料构建助手：字面量、零时钟、零随机。
// ---------------------------------------------------------------------------

function caseRow(id: string, basis: string, calibrationPlan: ProcessAdmissionPlan, expectation: ProcessAdmissionExpectation): ProcessAdmissionCalibrationCase {
  return { id, basis, plan: calibrationPlan, expectation };
}

function row(structure: ProcessAdmissionStructure, verdict: ProcessAdmissionVerdict, reasonCode: ProcessAdmissionReasonCode): ProcessAdmissionExpectationRow {
  return { structure, verdict, reasonCode };
}

function plan(versionId: string, operations: PprOperation[], precedenceRelations: PprPrecedenceRelation[], resources: PprResource[], resourceAssignments: PprOperationResourceAssignment[]): ProcessAdmissionPlan {
  return { planId: "calibration-plan", versionId, operations, precedenceRelations, resources, resourceAssignments };
}

function operation(id: string, name: string): PprOperation {
  return { id, name, standardTimeMinutes: 5, componentRefs: [] };
}

function relation(id: string, predecessorOperationId: string, successorOperationId: string, minimumLagMinutes?: number): PprPrecedenceRelation {
  return minimumLagMinutes === undefined
    ? { id, predecessorOperationId, successorOperationId }
    : { id, predecessorOperationId, successorOperationId, minimumLagMinutes };
}

function resource(id: string, name: string, kind: PprResource["kind"]): PprResource {
  return { id, name, kind };
}

function assignment(id: string, operationId: string, resourceId: string, requiredCapacity?: number): PprOperationResourceAssignment {
  return requiredCapacity === undefined ? { id, operationId, resourceId } : { id, operationId, resourceId, requiredCapacity };
}
