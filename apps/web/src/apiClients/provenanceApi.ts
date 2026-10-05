import type {
  AiProvenanceActionExecutionNode,
  AiProvenanceActionPlanNode,
  AiProvenanceActionReceiptNode,
  AiProvenanceChainSummary,
  AiProvenanceHypothesisNode,
  AiProvenanceKernelRunNode,
  AiProvenanceReportNode,
  AiProvenanceTrace,
  AiProvenanceVerdictNode,
} from "@bim-studio/contracts";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

/**
 * H-C3 档案室浏览器端调用边界：列表 + 三跳查询 + Semantica 刀1 决策链三只读端点，
 * 避免组件自行拼接项目作用域。
 *
 * 决策链响应类型是 apps/api `decisionChainQueries.ts` 输出的镜像（contracts 侧无此类型，
 * web 不跨应用 import API 内部模块——字段以路由返回体为准，此处只做只读视图型）。
 */
export function createProvenanceApi(request: ApiRequest) {
  return {
    listProvenanceChains: (projectId: string, signal?: AbortSignal) =>
      request<ProvenanceChainList>(
        `/api/projects/${encodeURIComponent(projectId)}/ai/provenance`,
        signal ? { signal } : undefined,
      ),
    traceProvenance: (projectId: string, query: ProvenanceTraceQuery = {}, signal?: AbortSignal) =>
      request<AiProvenanceTrace>(provenanceTracePath(projectId, query), signal ? { signal } : undefined),
    /** Semantica 刀1① 决策链回放：从任一账本节点回放完整链，断链如实标注（found=false 未命中）。 */
    traceDecisionChain: (projectId: string, nodeId: string, signal?: AbortSignal) =>
      request<DecisionChainTrace>(
        `/api/projects/${encodeURIComponent(projectId)}/ai/provenance/decision-chain/${encodeURIComponent(nodeId)}`,
        signal ? { signal } : undefined,
      ),
    /** Semantica 刀1② 先例检索：同指纹或同理由码的既有判定，时间倒序（matched=false 如实为空）。 */
    findSimilarDecisions: (projectId: string, query: SimilarDecisionsQuery, signal?: AbortSignal) => {
      const params = new URLSearchParams();
      if (query.fingerprint) params.set("fingerprint", query.fingerprint);
      if (query.reasonCode) params.set("reasonCode", query.reasonCode);
      if (query.limit !== undefined) params.set("limit", String(query.limit));
      return request<SimilarDecisionsResult>(
        `/api/projects/${encodeURIComponent(projectId)}/ai/provenance/similar-decisions?${params.toString()}`,
        signal ? { signal } : undefined,
      );
    },
    /** Semantica 刀1③ 影响面反查：锚节点指纹出现在哪些下游判定/报告（只读清单）。 */
    analyzeDecisionImpact: (projectId: string, nodeId: string, signal?: AbortSignal) =>
      request<DecisionImpactResult>(
        `/api/projects/${encodeURIComponent(projectId)}/ai/provenance/decision-impact/${encodeURIComponent(nodeId)}`,
        signal ? { signal } : undefined,
      ),
  };
}

export interface ProvenanceChainList {
  chains: AiProvenanceChainSummary[];
  integrity: { intact: boolean; brokenNodes: string[] };
}

export interface ProvenanceTraceQuery {
  resultFingerprint?: string;
  proposalFingerprint?: string;
  since?: string;
  until?: string;
  limit?: number;
}

// --- Semantica 刀1 决策链响应视图型（镜像 apps/api decisionChainQueries 输出） ---

export type DecisionChainNodeKind =
  | "hypothesis" | "kernel-run" | "verdict" | "report"
  | "action-plan" | "action-execution" | "action-receipt" | "study-run";

export type DecisionChainNode =
  | { kind: "hypothesis"; node: AiProvenanceHypothesisNode }
  | { kind: "kernel-run"; node: AiProvenanceKernelRunNode }
  | { kind: "verdict"; node: AiProvenanceVerdictNode }
  | { kind: "report"; node: AiProvenanceReportNode }
  | { kind: "action-plan"; node: AiProvenanceActionPlanNode }
  | { kind: "action-execution"; node: AiProvenanceActionExecutionNode }
  | { kind: "action-receipt"; node: AiProvenanceActionReceiptNode }
  | { kind: "study-run"; node: StudyRunRecordView };

/** 长跑运行段记录（账本 study-run；字段按路由返回体最小面收窄）。 */
export interface StudyRunRecordView {
  nodeId: string;
  proposalFingerprint: string;
  inputFingerprint: string;
  status: string;
  completedRepeats: number;
  totalRepeats: number;
}

export interface DecisionChainGap {
  afterNodeId: string;
  code: string;
  detail: string;
}

export interface DecisionChainEdge {
  from: string;
  to: string;
  relation: "executed" | "judged" | "reported" | "plan-executed" | "plan-receipted";
}

export interface DecisionChainTrace {
  anchor: { nodeId: string; found: boolean; kind?: DecisionChainNodeKind };
  chainType: "verification" | "action" | "none";
  nodes: DecisionChainNode[];
  edges: DecisionChainEdge[];
  gaps: DecisionChainGap[];
}

export interface SimilarDecisionsQuery {
  fingerprint?: string;
  reasonCode?: string;
  limit?: number;
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
  matched: boolean;
  hits: SimilarDecisionHit[];
}

export interface DecisionImpactResult {
  anchor: { nodeId: string; found: boolean; kind?: DecisionChainNodeKind };
  fingerprints: string[];
  downstream: {
    verdicts: Array<{
      nodeId: string;
      proposalFingerprint: string;
      resultFingerprint: string;
      verdict: AiProvenanceVerdictNode["verdict"];
      reasonCode: string;
      judgedAt: string;
    }>;
    reports: Array<{
      nodeId: string;
      label: string;
      proposalFingerprint?: string;
      resultFingerprint?: string;
      reportedAt: string;
    }>;
  };
}

function provenanceTracePath(projectId: string, query: ProvenanceTraceQuery): string {
  const params = new URLSearchParams();
  if (query.resultFingerprint) params.set("resultFingerprint", query.resultFingerprint);
  if (query.proposalFingerprint) params.set("proposalFingerprint", query.proposalFingerprint);
  if (query.since) params.set("since", query.since);
  if (query.until) params.set("until", query.until);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return `/api/projects/${encodeURIComponent(projectId)}/ai/provenance/trace${suffix}`;
}
