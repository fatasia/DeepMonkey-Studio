import type {
  AiProvenanceActionExecutionNode,
  AiProvenanceActionNode,
  AiProvenanceActionPlanNode,
  AiProvenanceActionReceiptNode,
  AiProvenanceHypothesisNode,
  AiProvenanceKernelRunNode,
  AiProvenanceReportNode,
  AiProvenanceVerdictNode,
} from "@bim-studio/contracts";
import type { AiProvenanceStudyRunRecord } from "./provenanceLedger.js";

/**
 * Semantica 刀1「决策链查询面」：在既有 ProvenanceLedger 文档上的只读回放纯函数。
 *
 * 数据结构零改动（节点与边沿用账本既有形态），只补三种查询能力：
 * ① traceDecisionChain —— 从任一节点沿边回放完整链（仿真链 proposal→run→verdict→report /
 *    行动链 plan→execution→receipt），断链/缺边如实标注（gaps），不伪造连续性；
 * ② findSimilarDecisions —— 同 proposalFingerprint 或同理由码的先例检索（判定节点），时间倒序；
 * ③ analyzeDecisionImpact —— 反查锚节点指纹出现在哪些下游 verdict/报告（影响面清单）。
 *
 * 诚实边界：全部是确定性指纹/理由码匹配，不做语义检索；只读（入参数组不得被改写，
 * 出参一律 fresh 对象），复用账本既有加载/缓存路径，不新增持久化形态。
 */

/** 决策链节点种类：仿真链四族 + 行动链三族 + 长跑运行段记录。 */
export type DecisionChainNodeKind =
  | "hypothesis"
  | "kernel-run"
  | "verdict"
  | "report"
  | "action-plan"
  | "action-execution"
  | "action-receipt"
  | "study-run";

export type DecisionChainNode =
  | { kind: "hypothesis"; node: AiProvenanceHypothesisNode }
  | { kind: "kernel-run"; node: AiProvenanceKernelRunNode }
  | { kind: "verdict"; node: AiProvenanceVerdictNode }
  | { kind: "report"; node: AiProvenanceReportNode }
  | { kind: "action-plan"; node: AiProvenanceActionPlanNode }
  | { kind: "action-execution"; node: AiProvenanceActionExecutionNode }
  | { kind: "action-receipt"; node: AiProvenanceActionReceiptNode }
  | { kind: "study-run"; node: AiProvenanceStudyRunRecord };

/** 缺边/断链标注：断在哪里、断的语义是什么——档案如实呈现不完整，不伪造连续链。 */
export type DecisionChainGapCode =
  | "verdict-missing"
  | "run-missing"
  | "report-missing-run"
  | "execution-receipt-missing"
  | "plan-missing"
  | "run-pending";

export interface DecisionChainGap {
  /** 断点所在节点（缺边的上游/发现点）。 */
  afterNodeId: string;
  code: DecisionChainGapCode;
  detail: string;
}

export interface DecisionChainEdge {
  from: string;
  to: string;
  relation: "executed" | "judged" | "reported" | "plan-executed" | "plan-receipted";
}

export interface DecisionChainTrace {
  anchor: { nodeId: string; found: boolean; kind?: DecisionChainNodeKind };
  /** verification = 仿真假设链；action = 本体行动链；none = 未命中。 */
  chainType: "verification" | "action" | "none";
  /** 回放序：链首在前（假设/计划），下游依次排列；研究运行段记录如实附在仿真链尾。 */
  nodes: DecisionChainNode[];
  edges: DecisionChainEdge[];
  gaps: DecisionChainGap[];
}

export interface DecisionChainDocumentView {
  hypotheses: AiProvenanceHypothesisNode[];
  runs: AiProvenanceKernelRunNode[];
  verdicts: AiProvenanceVerdictNode[];
  reports: AiProvenanceReportNode[];
  studyRuns: AiProvenanceStudyRunRecord[];
  actions: AiProvenanceActionNode[];
}

export interface SimilarDecisionHit {
  matchedBy: "proposal-fingerprint" | "reason-code";
  verdictNodeId: string;
  proposalFingerprint: string;
  resultFingerprint: string;
  verdict: AiProvenanceVerdictNode["verdict"];
  reasonCode: string;
  judgedAt: string;
  rationaleDigest: string;
}

export interface SimilarDecisionsResult {
  query: { fingerprint?: string; reasonCode?: string; limit: number };
  /** false = 无任何命中（先例如实为空，不伪造先例）。 */
  matched: boolean;
  hits: SimilarDecisionHit[];
}

export interface DecisionImpactDownstreamVerdict {
  nodeId: string;
  proposalFingerprint: string;
  resultFingerprint: string;
  verdict: AiProvenanceVerdictNode["verdict"];
  reasonCode: string;
  judgedAt: string;
}

export interface DecisionImpactDownstreamReport {
  nodeId: string;
  label: string;
  proposalFingerprint?: string;
  resultFingerprint?: string;
  reportedAt: string;
}

export interface DecisionImpactResult {
  anchor: { nodeId: string; found: boolean; kind?: DecisionChainNodeKind };
  /** 锚节点携带的全部指纹（proposal/result/evidence）；反查键如实列出。 */
  fingerprints: string[];
  downstream: {
    verdicts: DecisionImpactDownstreamVerdict[];
    reports: DecisionImpactDownstreamReport[];
  };
}

const DECISION_NODE_LIMIT = 200;

// ---------------------------------------------------------------------------
// ① 决策链回放
// ---------------------------------------------------------------------------

export function traceDecisionChain(document: DecisionChainDocumentView, rawNodeId: string): DecisionChainTrace {
  const nodeId = rawNodeId.trim();
  const anchor = findAnchor(document, nodeId);
  if (!anchor) {
    return { anchor: { nodeId, found: false }, chainType: "none", nodes: [], edges: [], gaps: [] };
  }
  if (isActionKind(anchor.kind)) return traceActionChain(document, anchor);
  return traceVerificationChain(document, anchor);
}

function findAnchor(document: DecisionChainDocumentView, nodeId: string): DecisionChainNode | undefined {
  for (const hypothesis of document.hypotheses) {
    if (hypothesis.nodeId === nodeId) return { kind: "hypothesis", node: hypothesis };
  }
  for (const run of document.runs) {
    if (run.nodeId === nodeId) return { kind: "kernel-run", node: run };
  }
  for (const verdict of document.verdicts) {
    if (verdict.nodeId === nodeId) return { kind: "verdict", node: verdict };
  }
  for (const report of document.reports) {
    if (report.nodeId === nodeId) return { kind: "report", node: report };
  }
  for (const record of document.studyRuns) {
    if (record.nodeId === nodeId) return { kind: "study-run", node: record };
  }
  for (const action of document.actions) {
    if (action.nodeId !== nodeId) continue;
    if (action.kind === "action-plan") return { kind: "action-plan", node: action };
    if (action.kind === "action-execution") return { kind: "action-execution", node: action };
    return { kind: "action-receipt", node: action };
  }
  return undefined;
}

function isActionKind(kind: DecisionChainNodeKind): boolean {
  return kind === "action-plan" || kind === "action-execution" || kind === "action-receipt";
}

/** 仿真链回放：以锚节点指纹为线索聚合同一 proposalFingerprint 域的全部节点，缺边如实标注。 */
function traceVerificationChain(document: DecisionChainDocumentView, anchor: DecisionChainNode): DecisionChainTrace {
  const proposalFingerprints = new Set<string>();
  const resultFingerprints = new Set<string>();
  collectFingerprints(anchor, proposalFingerprints, resultFingerprints);
  // 锚点之外，沿既有边继续收集：同域假设/运行/判定/报告互相引用同一组指纹。
  const related = collectVerificationDomain(document, proposalFingerprints, resultFingerprints);

  const hypothesis = related.hypotheses[0];
  const runs = related.runs.slice().sort((left, right) => left.executedAt.localeCompare(right.executedAt));
  const verdicts = related.verdicts.slice().sort((left, right) => left.judgedAt.localeCompare(right.judgedAt));
  const reports = related.reports.slice().sort((left, right) => left.reportedAt.localeCompare(right.reportedAt));

  const nodes: DecisionChainNode[] = [];
  const edges: DecisionChainEdge[] = [];
  const gaps: DecisionChainGap[] = [];

  if (hypothesis) {
    nodes.push({ kind: "hypothesis", node: hypothesis });
    for (const run of runs) edges.push({ from: hypothesis.nodeId, to: run.nodeId, relation: "executed" });
  } else {
    // 链首缺失：运行/判定在场但假设缺席（如被容量逐出）——如实标注断链。
    gaps.push({
      afterNodeId: runs[0]?.nodeId ?? verdicts[0]?.nodeId ?? anchor.node.nodeId,
      code: "run-missing",
      detail: "链中存在运行/判定但假设节点缺席（可能被容量逐出）；链首不可回放",
    });
  }
  for (const run of runs) nodes.push({ kind: "kernel-run", node: run });
  for (const verdict of verdicts) nodes.push({ kind: "verdict", node: verdict });
  for (const report of reports) nodes.push({ kind: "report", node: report });
  for (const verdict of verdicts) {
    if (!runs.some((run) => run.resultFingerprint === verdict.resultFingerprint)) {
      gaps.push({ afterNodeId: verdict.nodeId, code: "run-missing", detail: `判定 ${verdict.nodeId} 引用的运行 ${verdict.resultFingerprint} 不在账本中` });
    }
    edges.push({ from: runs.find((run) => run.resultFingerprint === verdict.resultFingerprint)?.nodeId ?? verdict.resultFingerprint, to: verdict.nodeId, relation: "judged" });
  }
  for (const run of runs) {
    if (!verdicts.some((verdict) => verdict.resultFingerprint === run.resultFingerprint)) {
      gaps.push({ afterNodeId: run.nodeId, code: "verdict-missing", detail: `运行 ${run.nodeId} 尚无对应判定节点` });
    }
  }
  for (const report of reports) {
    if (report.resultFingerprint && !runs.some((run) => run.resultFingerprint === report.resultFingerprint)) {
      gaps.push({ afterNodeId: report.nodeId, code: "report-missing-run", detail: `报告 ${report.nodeId} 引用的运行 ${report.resultFingerprint} 不在账本中` });
    }
    const runNode = runs.find((run) => run.resultFingerprint === report.resultFingerprint)?.nodeId ?? report.proposalFingerprint ?? "unknown";
    edges.push({ from: runNode, to: report.nodeId, relation: "reported" });
  }
  // 长跑进行中记录如实附尾：不是已完成链的一环，标注 run-pending 缺边。
  for (const record of document.studyRuns) {
    if (!proposalFingerprints.has(record.proposalFingerprint)) continue;
    nodes.push({ kind: "study-run", node: record });
    gaps.push({
      afterNodeId: record.nodeId,
      code: "run-pending",
      detail: `长跑 ${record.nodeId} 处于 ${record.status} 态（${record.completedRepeats}/${record.totalRepeats}），尚未收口成真实运行/判定`,
    });
  }
  return {
    anchor: { nodeId: anchor.node.nodeId, found: true, kind: anchor.kind },
    chainType: "verification",
    nodes: nodes.slice(0, DECISION_NODE_LIMIT),
    edges,
    gaps,
  };
}

function collectFingerprints(node: DecisionChainNode, proposals: Set<string>, results: Set<string>): void {
  const value = node.node;
  if ("proposalFingerprint" in value && value.proposalFingerprint) proposals.add(value.proposalFingerprint);
  if ("resultFingerprint" in value && value.resultFingerprint) results.add(value.resultFingerprint);
}

/** 以锚点指纹为种子迭代扩域：run↔verdict 按 resultFingerprint 对齐，报告按双指纹挂接。 */
function collectVerificationDomain(
  document: DecisionChainDocumentView,
  proposals: Set<string>,
  results: Set<string>,
): { hypotheses: AiProvenanceHypothesisNode[]; runs: AiProvenanceKernelRunNode[]; verdicts: AiProvenanceVerdictNode[]; reports: AiProvenanceReportNode[] } {
  const seenProposals = new Set(proposals);
  const seenResults = new Set(results);
  let grew = true;
  while (grew) {
    grew = false;
    for (const run of document.runs) {
      if (seenProposals.has(run.proposalFingerprint) && !seenResults.has(run.resultFingerprint)) {
        seenResults.add(run.resultFingerprint);
        grew = true;
      }
      if (seenResults.has(run.resultFingerprint) && !seenProposals.has(run.proposalFingerprint)) {
        seenProposals.add(run.proposalFingerprint);
        grew = true;
      }
    }
    for (const verdict of document.verdicts) {
      if (seenProposals.has(verdict.proposalFingerprint) && !seenResults.has(verdict.resultFingerprint)) {
        seenResults.add(verdict.resultFingerprint);
        grew = true;
      }
      if (seenResults.has(verdict.resultFingerprint) && !seenProposals.has(verdict.proposalFingerprint)) {
        seenProposals.add(verdict.proposalFingerprint);
        grew = true;
      }
    }
    for (const report of document.reports) {
      if ((report.proposalFingerprint && seenProposals.has(report.proposalFingerprint))
        || (report.resultFingerprint && seenResults.has(report.resultFingerprint))) {
        if (report.proposalFingerprint && !seenProposals.has(report.proposalFingerprint)) {
          seenProposals.add(report.proposalFingerprint);
          grew = true;
        }
        if (report.resultFingerprint && !seenResults.has(report.resultFingerprint)) {
          seenResults.add(report.resultFingerprint);
          grew = true;
        }
      }
    }
    for (const record of document.studyRuns) {
      if (seenProposals.has(record.proposalFingerprint) && !seenResults.has(record.inputFingerprint)) {
        seenResults.add(record.inputFingerprint);
      }
    }
  }
  return {
    hypotheses: document.hypotheses.filter((item) => seenProposals.has(item.proposalFingerprint)),
    runs: document.runs.filter((item) => seenProposals.has(item.proposalFingerprint) || seenResults.has(item.resultFingerprint)),
    verdicts: document.verdicts.filter((item) => seenProposals.has(item.proposalFingerprint) || seenResults.has(item.resultFingerprint)),
    reports: document.reports.filter((item) =>
      (item.proposalFingerprint !== undefined && seenProposals.has(item.proposalFingerprint))
      || (item.resultFingerprint !== undefined && seenResults.has(item.resultFingerprint))),
  };
}

/** 行动链回放：plan→execution→receipt 按 planFingerprint 聚合，缺回执/缺计划如实标注。 */
function traceActionChain(document: DecisionChainDocumentView, anchor: DecisionChainNode): DecisionChainTrace {
  const planFingerprints = new Set<string>();
  const value = anchor.node as AiProvenanceActionNode;
  planFingerprints.add(value.planFingerprint);
  const plans = document.actions.filter((item): item is AiProvenanceActionPlanNode =>
    item.kind === "action-plan" && planFingerprints.has(item.planFingerprint));
  const executions = document.actions.filter((item): item is AiProvenanceActionExecutionNode =>
    item.kind === "action-execution" && planFingerprints.has(item.planFingerprint));
  const receipts = document.actions.filter((item): item is AiProvenanceActionReceiptNode =>
    item.kind === "action-receipt" && planFingerprints.has(item.planFingerprint));
  const nodes: DecisionChainNode[] = [];
  const edges: DecisionChainEdge[] = [];
  const gaps: DecisionChainGap[] = [];
  for (const plan of plans.sort((left, right) => left.plannedAt.localeCompare(right.plannedAt))) {
    nodes.push({ kind: "action-plan", node: plan });
  }
  for (const execution of executions.sort((left, right) => left.executedAt.localeCompare(right.executedAt))) {
    nodes.push({ kind: "action-execution", node: execution });
    edges.push({ from: execution.planFingerprint, to: execution.nodeId, relation: "plan-executed" });
    if (!receipts.some((receipt) => receipt.inputFingerprint === execution.inputFingerprint)) {
      gaps.push({ afterNodeId: execution.nodeId, code: "execution-receipt-missing", detail: `执行 ${execution.nodeId} 尚无对应回执（执行后中断如实呈现）` });
    }
  }
  for (const receipt of receipts.sort((left, right) => left.receiptedAt.localeCompare(right.receiptedAt))) {
    nodes.push({ kind: "action-receipt", node: receipt });
    edges.push({ from: receipt.planFingerprint, to: receipt.nodeId, relation: "plan-receipted" });
  }
  if (!plans.length) {
    gaps.push({
      afterNodeId: anchor.node.nodeId,
      code: "plan-missing",
      detail: "链中存在执行/回执但计划节点缺席（可能被容量逐出）；链首不可回放",
    });
  }
  return {
    anchor: { nodeId: anchor.node.nodeId, found: true, kind: anchor.kind },
    chainType: "action",
    nodes: nodes.slice(0, DECISION_NODE_LIMIT),
    edges,
    gaps,
  };
}

// ---------------------------------------------------------------------------
// ② 先例检索
// ---------------------------------------------------------------------------

export function findSimilarDecisions(
  document: DecisionChainDocumentView,
  query: { fingerprint?: string; reasonCode?: string },
  rawLimit = 20,
): SimilarDecisionsResult {
  const fingerprint = query.fingerprint?.trim() || undefined;
  const reasonCode = query.reasonCode?.trim() || undefined;
  const limit = Math.max(1, Math.min(100, Math.floor(rawLimit) || 20));
  const normalized: SimilarDecisionsResult["query"] = {
    ...(fingerprint ? { fingerprint } : {}),
    ...(reasonCode ? { reasonCode } : {}),
    limit,
  };
  if (!fingerprint && !reasonCode) return { query: normalized, matched: false, hits: [] };
  const hits: SimilarDecisionHit[] = [];
  for (const verdict of document.verdicts) {
    const byFingerprint = fingerprint !== undefined
      && (verdict.proposalFingerprint === fingerprint || verdict.resultFingerprint === fingerprint);
    const byReasonCode = reasonCode !== undefined && verdict.reasonCode === reasonCode;
    if (!byFingerprint && !byReasonCode) continue;
    hits.push({
      matchedBy: byFingerprint ? "proposal-fingerprint" : "reason-code",
      verdictNodeId: verdict.nodeId,
      proposalFingerprint: verdict.proposalFingerprint,
      resultFingerprint: verdict.resultFingerprint,
      verdict: verdict.verdict,
      reasonCode: verdict.reasonCode,
      judgedAt: verdict.judgedAt,
      rationaleDigest: verdict.rationaleDigest,
    });
  }
  hits.sort((left, right) => right.judgedAt.localeCompare(left.judgedAt));
  return { query: normalized, matched: hits.length > 0, hits: hits.slice(0, limit) };
}

// ---------------------------------------------------------------------------
// ③ 影响面反查
// ---------------------------------------------------------------------------

export function analyzeDecisionImpact(document: DecisionChainDocumentView, rawNodeId: string): DecisionImpactResult {
  const nodeId = rawNodeId.trim();
  const anchor = findAnchor(document, nodeId);
  if (!anchor) {
    return { anchor: { nodeId, found: false }, fingerprints: [], downstream: { verdicts: [], reports: [] } };
  }
  const proposals = new Set<string>();
  const results = new Set<string>();
  const evidences = new Set<string>();
  // 锚节点可能是任一节点族：按结构面取指纹字段（union 上直接收窄会塌缩成 never）。
  const value = anchor.node as unknown as { proposalFingerprint?: string | undefined; resultFingerprint?: string | undefined; evidenceFingerprint?: string | undefined };
  if (value.proposalFingerprint) proposals.add(value.proposalFingerprint);
  if (value.resultFingerprint) results.add(value.resultFingerprint);
  if (value.evidenceFingerprint) evidences.add(value.evidenceFingerprint);
  // 锚为假设/运行时，把同域运行的结果指纹一并算入反查键（重跑同 proposal 皆属影响面）。
  if (anchor.kind === "hypothesis" || anchor.kind === "kernel-run") {
    for (const run of document.runs) {
      if (proposals.has(run.proposalFingerprint)) results.add(run.resultFingerprint);
    }
  }
  const fingerprints = [...proposals, ...results, ...evidences];
  const anchorIsVerdict = anchor.kind === "verdict";
  const anchorIsReport = anchor.kind === "report";
  const downstreamVerdicts = document.verdicts
    .filter((item) => !(anchorIsVerdict && item.nodeId === anchor.node.nodeId))
    .filter((item) => proposals.has(item.proposalFingerprint) || results.has(item.resultFingerprint))
    .sort((left, right) => right.judgedAt.localeCompare(left.judgedAt))
    .map((item) => ({
      nodeId: item.nodeId,
      proposalFingerprint: item.proposalFingerprint,
      resultFingerprint: item.resultFingerprint,
      verdict: item.verdict,
      reasonCode: item.reasonCode,
      judgedAt: item.judgedAt,
    }));
  const downstreamReports = document.reports
    .filter((item) => !(anchorIsReport && item.nodeId === anchor.node.nodeId))
    .filter((item) =>
      (item.proposalFingerprint !== undefined && proposals.has(item.proposalFingerprint))
      || (item.resultFingerprint !== undefined && results.has(item.resultFingerprint))
      || evidences.has(item.evidenceFingerprint))
    .sort((left, right) => right.reportedAt.localeCompare(left.reportedAt))
    .map((item) => ({
      nodeId: item.nodeId,
      label: item.label,
      ...(item.proposalFingerprint !== undefined ? { proposalFingerprint: item.proposalFingerprint } : {}),
      ...(item.resultFingerprint !== undefined ? { resultFingerprint: item.resultFingerprint } : {}),
      reportedAt: item.reportedAt,
    }));
  return {
    anchor: { nodeId: anchor.node.nodeId, found: true, kind: anchor.kind },
    fingerprints,
    downstream: { verdicts: downstreamVerdicts, reports: downstreamReports },
  };
}
