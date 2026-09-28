/**
 * H-C3 档案室合同②：Provenance 三跳链（假设→内核运行→判定[→报告]）。
 *
 * AI-harness世界模型升级设计-20260929 §3.4（Provenance 账本）的类型面：
 * 节点 = hypothesis（proposalFingerprint）/ kernel-run（input+result 指纹+种子+goldenHash）/
 * verdict（三态判定+理由码+容差）/ report（Study 证据指纹）；边 = proposal→run→verdict→report。
 * 本文件只有类型、fail-closed 校验、完整性指纹与纯装配函数，不含存储与 I/O
 * （存储在 apps/api provenanceLedger.ts，复用 agentMemory.ts 文档元数据模式）。
 *
 * 证据最小化（§3.4 第 5 条 + aiReliabilityAudit 原则延伸）：账本只存指纹+判定+理由码+
 * 摘要（陈述/理由截断摘要），不存提示词原文与用户数据。
 * 完整性边界（诚实条款）：integrityFingerprint 基于全仓指纹体系（FNV-1a，非密码学），
 * 能如实暴露意外漂移与部分篡改（改判定→链断）；对抗性整体重算指纹不在防线内，
 * 这与 fingerprint.ts 的既定边界一致。
 */

import {
  AI_HYPOTHESIS_REASON_CODES,
  aiHypothesisMetricLocator,
  type AiHypothesisContract,
  type AiHypothesisReasonCode,
  type AiHypothesisTolerance,
  type AiHypothesisVerdict,
  type AiVerificationEnvelope,
} from "./aiHypothesis.js";
import { fingerprint64Labeled } from "./fingerprint.js";

/** 链合同版本；节点字段语义变更必须换版本并同步校验函数。 */
export const AI_PROVENANCE_CHAIN_VERSION = "1" as const;

/** 摘要截断长度（陈述/判定理由进入账本的口径）。 */
export const AI_PROVENANCE_DIGEST_MAX_CHARS = 300;

/** 假设节点：nodeId = proposalFingerprint（同 id 重提以指纹区分版本）。 */
export interface AiProvenanceHypothesisNode {
  kind: "hypothesis";
  nodeId: string;
  proposalFingerprint: string;
  hypothesisId: string;
  targetModel: string;
  metricLocator: string;
  /** 假设陈述摘要（≤300 字符）；不是提示词原文，是提案的结构化陈述。 */
  statementDigest: string;
  registeredAt: string;
  /** 首次落运行时间；只登记未验证时缺省（"登记了但从未验证"是档案的诚实状态）。 */
  verifiedAt?: string;
}

/** 内核运行节点：nodeId = resultFingerprint（同指纹 = 确定性同结果，幂等 upsert）。 */
export interface AiProvenanceKernelRunNode {
  kind: "kernel-run";
  nodeId: string;
  proposalFingerprint: string;
  inputFingerprint: string;
  resultFingerprint: string;
  engineId?: string;
  goldenHash?: string;
  goldenMatch?: boolean;
  /** 运行种子与重复次数：来自 golden 锚，长跑断线恢复后指纹不变的复现口径。种子沿用 plant-lite 的字符串口径。 */
  seed?: string;
  replications?: number;
  executedAt: string;
}

/** 判定节点：nodeId = verdict:<resultFingerprint>，一次运行恰一个判定。 */
export interface AiProvenanceVerdictNode {
  kind: "verdict";
  nodeId: string;
  proposalFingerprint: string;
  resultFingerprint: string;
  verdict: AiHypothesisVerdict;
  reasonCode: AiHypothesisReasonCode;
  tolerance: AiHypothesisTolerance;
  rationaleDigest: string;
  judgedAt: string;
  /** 全字段完整性指纹；读回时重算比对，不一致即链断并如实暴露（不静默修复）。 */
  integrityFingerprint: string;
}

/** 报告节点：Study 证据指纹。第一切片提供落账 API，尚无生产者接线（如实声明）。 */
export interface AiProvenanceReportNode {
  kind: "report";
  nodeId: string;
  proposalFingerprint?: string;
  resultFingerprint?: string;
  evidenceFingerprint: string;
  label: string;
  reportedAt: string;
}

export type AiProvenanceEdgeRelation = "executed" | "judged" | "reported";

export interface AiProvenanceEdge {
  from: string;
  to: string;
  relation: AiProvenanceEdgeRelation;
}

export type AiProvenanceBreakCode =
  | "verdict-integrity-mismatch"
  | "verdict-missing-run"
  | "run-missing-proposal"
  | "report-missing-run";

export interface AiProvenanceBreak {
  nodeId: string;
  code: AiProvenanceBreakCode;
  detail: string;
}

export interface AiProvenanceChain {
  hypothesis: AiProvenanceHypothesisNode;
  runs: AiProvenanceKernelRunNode[];
  verdicts: AiProvenanceVerdictNode[];
  reports: AiProvenanceReportNode[];
  edges: AiProvenanceEdge[];
  integrity: "intact" | "broken";
  breaks: AiProvenanceBreak[];
}

/** 三跳查询：任一维度（result 指纹 / proposal 指纹 / 时间窗）皆可单独或组合使用。 */
export interface AiProvenanceQuery {
  resultFingerprint?: string;
  proposalFingerprint?: string;
  since?: string;
  until?: string;
  limit?: number;
}

export interface AiProvenanceTrace {
  chainVersion: typeof AI_PROVENANCE_CHAIN_VERSION;
  query: AiProvenanceQuery;
  /** false = 未命中：调用方必须如实呈现"无档案记录"，不得伪造链。 */
  matched: boolean;
  chains: AiProvenanceChain[];
  /** 全库完整性核查（不只命中链）：任何判定被改动都在此暴露。 */
  integrity: { intact: boolean; brokenNodes: string[] };
}

export interface AiProvenanceRecords {
  hypotheses: AiProvenanceHypothesisNode[];
  runs: AiProvenanceKernelRunNode[];
  verdicts: AiProvenanceVerdictNode[];
  reports: AiProvenanceReportNode[];
}

/** 档案列表条目（工作区入口的轻量行；三跳详情走 trace）。 */
export interface AiProvenanceChainSummary {
  hypothesis: AiProvenanceHypothesisNode;
  runCount: number;
  reportCount: number;
  latest?: { verdict: AiProvenanceVerdictNode["verdict"]; reasonCode: string; judgedAt: string };
  integrity: "intact" | "broken";
  lastActivityAt: string;
}

export class AiProvenanceContractError extends Error {
  public constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "AiProvenanceContractError";
  }
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** 判定节点完整性指纹：除 integrityFingerprint 外全字段掺入（含判定与理由码）。 */
export function provenanceVerdictIntegrityFingerprint(
  node: Omit<AiProvenanceVerdictNode, "integrityFingerprint">,
): string {
  return fingerprint64Labeled([
    ["ai-provenance-verdict", AI_PROVENANCE_CHAIN_VERSION],
    ["node", node],
  ]);
}

/** 摘要截断：超长加显式截断标记，不静默丢字。 */
export function provenanceDigest(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > AI_PROVENANCE_DIGEST_MAX_CHARS
    ? `${trimmed.slice(0, AI_PROVENANCE_DIGEST_MAX_CHARS)}…[已截断]`
    : trimmed;
}

/** 由已验证的假设合同构建假设节点（登记入口）。 */
export function buildAiProvenanceHypothesisNode(
  contract: AiHypothesisContract,
  proposalFingerprint: string,
  registeredAt: string,
): AiProvenanceHypothesisNode {
  requireFingerprint(proposalFingerprint, "proposalFingerprint");
  requireIso(registeredAt, "registeredAt");
  return {
    kind: "hypothesis",
    nodeId: proposalFingerprint,
    proposalFingerprint,
    hypothesisId: contract.id,
    targetModel: contract.targetModel,
    metricLocator: aiHypothesisMetricLocator(contract.prediction),
    statementDigest: provenanceDigest(contract.statement),
    registeredAt,
  };
}

/** 由验证信封构建内核运行节点（golden 锚种子/重复次数由调用方透传）。 */
export function buildAiProvenanceKernelRunNode(
  envelope: AiVerificationEnvelope,
  meta: { seed?: string; replications?: number; executedAt: string },
): AiProvenanceKernelRunNode {
  requireFingerprint(envelope.proposalFingerprint, "proposalFingerprint");
  requireFingerprint(envelope.resultFingerprint, "resultFingerprint");
  requireIso(meta.executedAt, "executedAt");
  return {
    kind: "kernel-run",
    nodeId: envelope.resultFingerprint,
    proposalFingerprint: envelope.proposalFingerprint,
    inputFingerprint: envelope.inputFingerprint,
    resultFingerprint: envelope.resultFingerprint,
    ...(envelope.engineId ? { engineId: envelope.engineId } : {}),
    ...(envelope.goldenHash ? { goldenHash: envelope.goldenHash } : {}),
    ...(envelope.goldenMatch !== undefined ? { goldenMatch: envelope.goldenMatch } : {}),
    ...(meta.seed !== undefined ? { seed: meta.seed } : {}),
    ...(meta.replications !== undefined ? { replications: meta.replications } : {}),
    executedAt: meta.executedAt,
  };
}

/** 由验证信封构建判定节点，并计算完整性指纹。 */
export function buildAiProvenanceVerdictNode(
  envelope: AiVerificationEnvelope,
  judgedAt: string,
): AiProvenanceVerdictNode {
  requireFingerprint(envelope.proposalFingerprint, "proposalFingerprint");
  requireFingerprint(envelope.resultFingerprint, "resultFingerprint");
  requireIso(judgedAt, "judgedAt");
  const base = {
    kind: "verdict" as const,
    nodeId: `verdict:${envelope.resultFingerprint}`,
    proposalFingerprint: envelope.proposalFingerprint,
    resultFingerprint: envelope.resultFingerprint,
    verdict: envelope.verdict,
    reasonCode: envelope.reasonCode,
    tolerance: envelope.tolerance,
    rationaleDigest: provenanceDigest(envelope.rationale),
    judgedAt,
  };
  return { ...base, integrityFingerprint: provenanceVerdictIntegrityFingerprint(base) };
}

/** fail-closed 校验查询：指纹口径、ISO 时间窗、limit 边界；非法即抛，不让自由查询进账本。 */
export function validateAiProvenanceQuery(value: unknown): AiProvenanceQuery {
  const source = asRecord(value, "query");
  const resultFingerprint = optionalFingerprint(source.resultFingerprint, "query.resultFingerprint");
  const proposalFingerprint = optionalFingerprint(source.proposalFingerprint, "query.proposalFingerprint");
  const since = optionalIso(source.since, "query.since");
  const until = optionalIso(source.until, "query.until");
  let limit: number | undefined;
  if (source.limit !== undefined) {
    if (typeof source.limit !== "number" || !Number.isInteger(source.limit) || source.limit < 1 || source.limit > 100) {
      throw new AiProvenanceContractError("query.limit", "limit 必须是 1 至 100 的整数");
    }
    limit = source.limit;
  }
  if (since && until && since > until) {
    throw new AiProvenanceContractError("query.since", "since 不得晚于 until");
  }
  return {
    ...(resultFingerprint ? { resultFingerprint } : {}),
    ...(proposalFingerprint ? { proposalFingerprint } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

/**
 * 纯装配：把账本记录组装成三跳链集合。
 * - 完整性核查覆盖全库 verdict（不只命中链）：重算完整性指纹，漂移即 brokenNodes；
 * - 断链如实入 breaks（判定缺运行、运行缺假设、报告缺运行），不静默修复、不丢节点；
 * - 未命中返回 matched:false + 空链，查询方必须如实呈现。
 */
export function assembleAiProvenanceTrace(records: AiProvenanceRecords, query: AiProvenanceQuery): AiProvenanceTrace {
  const brokenNodes: string[] = [];
  for (const verdict of records.verdicts) {
    const { integrityFingerprint, ...rest } = verdict;
    if (provenanceVerdictIntegrityFingerprint(rest) !== integrityFingerprint) {
      brokenNodes.push(verdict.nodeId);
    }
  }

  const hypothesesByProposal = new Map(records.hypotheses.map((node) => [node.proposalFingerprint, node]));
  const runsByResult = new Map(records.runs.map((node) => [node.resultFingerprint, node]));
  const runsByProposal = groupBy(records.runs, (node) => node.proposalFingerprint);
  const verdictsByResult = new Map(records.verdicts.map((node) => [node.resultFingerprint, node]));
  const reportsByResult = new Map(
    records.reports.filter((node) => node.resultFingerprint).map((node) => [node.resultFingerprint as string, node]),
  );

  const candidateProposals = selectProposals(records, query, runsByResult, reportsByResult);
  const chains: AiProvenanceChain[] = [];
  for (const proposal of candidateProposals) {
    const hypothesis = hypothesesByProposal.get(proposal);
    if (!hypothesis) continue;
    const runs = (runsByProposal.get(proposal) ?? []).slice().sort(byExecutedAt);
    const verdicts: AiProvenanceVerdictNode[] = [];
    const reports: AiProvenanceReportNode[] = [];
    const breaks: AiProvenanceBreak[] = [];
    const edges: AiProvenanceEdge[] = [];
    for (const run of runs) {
      edges.push({ from: hypothesis.nodeId, to: run.nodeId, relation: "executed" });
      const verdict = verdictsByResult.get(run.resultFingerprint);
      if (verdict) {
        verdicts.push(verdict);
        edges.push({ from: run.nodeId, to: verdict.nodeId, relation: "judged" });
        if (brokenNodes.includes(verdict.nodeId)) {
          breaks.push({
            nodeId: verdict.nodeId,
            code: "verdict-integrity-mismatch",
            detail: "判定完整性指纹与读回重算不一致：判定在落账后被改动，链路如实断开",
          });
        }
        const report = reportsByResult.get(run.resultFingerprint);
        if (report) {
          reports.push(report);
          edges.push({ from: verdict.nodeId, to: report.nodeId, relation: "reported" });
        }
      } else {
        breaks.push({ nodeId: run.nodeId, code: "verdict-missing-run", detail: "运行缺少对应判定节点" });
      }
    }
    // 假设存在但从未有运行（只登记未验证）：链如实呈现空 run 段，不伪造运行。
    if (!runs.length && query.resultFingerprint) continue;
    chains.push({
      hypothesis,
      runs,
      verdicts,
      reports,
      edges,
      integrity: breaks.length ? "broken" : "intact",
      breaks,
    });
  }

  // 孤儿判定（假设被逐出/丢失但判定还在）：独立暴露，不让断链静默消失。
  for (const verdict of records.verdicts) {
    if (!runsByResult.has(verdict.resultFingerprint) && !brokenNodes.includes(verdict.nodeId)) {
      brokenNodes.push(verdict.nodeId);
    }
  }
  const inWindow = chains.filter((chain) => chainInWindow(chain, query)).sort(byLastActivity);
  const limit = Math.min(query.limit ?? 20, 100);
  return {
    chainVersion: AI_PROVENANCE_CHAIN_VERSION,
    query,
    matched: inWindow.length > 0,
    chains: inWindow.slice(0, limit),
    integrity: { intact: brokenNodes.length === 0, brokenNodes },
  };
}

function selectProposals(
  records: AiProvenanceRecords,
  query: AiProvenanceQuery,
  runsByResult: Map<string, AiProvenanceKernelRunNode>,
  reportsByResult: Map<string, AiProvenanceReportNode>,
): string[] {
  const proposals = new Set<string>();
  if (query.resultFingerprint) {
    const run = runsByResult.get(query.resultFingerprint);
    if (run) proposals.add(run.proposalFingerprint);
    const report = reportsByResult.get(query.resultFingerprint);
    if (report?.proposalFingerprint) proposals.add(report.proposalFingerprint);
    return [...proposals];
  }
  if (query.proposalFingerprint) {
    return records.hypotheses.some((node) => node.proposalFingerprint === query.proposalFingerprint)
      ? [query.proposalFingerprint]
      : [];
  }
  for (const node of records.hypotheses) proposals.add(node.proposalFingerprint);
  return [...proposals];
}

/** 时间窗作用于链上任何节点的时点（登记/运行/判定/报告），命中即入窗。 */
function chainInWindow(chain: AiProvenanceChain, query: AiProvenanceQuery): boolean {
  if (!query.since && !query.until) return true;
  const stamps = [
    chain.hypothesis.registeredAt,
    ...(chain.hypothesis.verifiedAt ? [chain.hypothesis.verifiedAt] : []),
    ...chain.runs.map((node) => node.executedAt),
    ...chain.verdicts.map((node) => node.judgedAt),
    ...chain.reports.map((node) => node.reportedAt),
  ];
  return stamps.some((stamp) => (!query.since || stamp >= query.since) && (!query.until || stamp <= query.until));
}

function byExecutedAt(left: AiProvenanceKernelRunNode, right: AiProvenanceKernelRunNode): number {
  return left.executedAt.localeCompare(right.executedAt);
}

function byLastActivity(left: AiProvenanceChain, right: AiProvenanceChain): number {
  return lastActivityOf(right).localeCompare(lastActivityOf(left));
}

function lastActivityOf(chain: AiProvenanceChain): string {
  const stamps = [
    chain.hypothesis.registeredAt,
    ...chain.runs.map((node) => node.executedAt),
    ...chain.verdicts.map((node) => node.judgedAt),
    ...chain.reports.map((node) => node.reportedAt),
  ];
  return stamps.sort().at(-1) ?? chain.hypothesis.registeredAt;
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = map.get(key);
    if (bucket) bucket.push(item);
    else map.set(key, [item]);
  }
  return map;
}

function requireFingerprint(value: string, field: string): string {
  if (!FINGERPRINT_PATTERN.test(value)) {
    throw new AiProvenanceContractError(field, `${field} 必须是 16 位小写十六进制指纹`);
  }
  return value;
}

function requireIso(value: string, field: string): string {
  requireIsoShape(value, field);
  return value;
}

function optionalFingerprint(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    throw new AiProvenanceContractError(field, `${field} 必须是 16 位小写十六进制指纹`);
  }
  return value;
}

function optionalIso(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireIsoShape(value, field);
}

function requireIsoShape(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new AiProvenanceContractError(field, `${field} 必须是 UTC ISO 8601 时间字符串`);
  }
  return value;
}

/** 理由码白名单再导出：账本侧校验与 aiHypothesis 保持单一来源。 */
export const AI_PROVENANCE_REASON_CODES = AI_HYPOTHESIS_REASON_CODES;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AiProvenanceContractError(label, `${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}
