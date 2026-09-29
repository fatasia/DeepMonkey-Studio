export type AgentRunStatus =
  | "running"
  | "awaiting-approval"
  | "awaiting-input"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled"
  | "budget-exhausted";

export type AgentToolEffect = "read" | "analyze" | "simulate" | "write" | "control";
export type AgentToolRisk = "low" | "medium" | "high" | "critical";

export interface AgentBudget {
  maxSteps: number;
  maxDurationMs: number;
  maxToolCalls: number;
}

export interface AgentToolResource {
  kind: string;
  id: string;
  projectId?: string;
}

export interface AgentToolCall {
  toolId: string;
  arguments: Record<string, unknown>;
  resources: AgentToolResource[];
}

export interface AgentApproval {
  approvedBy: string;
  approvedAt: string;
  scopeFingerprint: string;
}

export interface AgentToolDefinition {
  id: string;
  label: string;
  description: string;
  effect: AgentToolEffect;
  risk: AgentToolRisk;
  requiresApproval: boolean;
  inputSchema?: unknown;
}

export interface AgentEvidence {
  id: string;
  kind: string;
  label: string;
  source: string;
  fingerprint?: string;
}

export interface AgentToolOutcome {
  status: "completed" | "failed" | "blocked";
  output?: unknown;
  evidence: AgentEvidence[];
  /** 写入和控制类工具必须返回独立的执行后验证证据。 */
  verificationEvidence: AgentEvidence[];
  error?: { code: string; message: string; retryable: boolean };
  /** 非致命警告（如账本写失败但结果有效）：completed 态也必须透传，禁止静默丢弃。 */
  warnings?: readonly string[];
}

export type AgentDecision =
  | {
      kind: "request-input";
      rationale: string;
      question: string;
      options: AgentSelectionOption[];
    }
  | {
      kind: "call-tool";
      rationale: string;
      call: AgentToolCall;
    }
  | {
      kind: "finish";
      rationale: string;
      summary: string;
      decisionStatus: "production" | "shadow" | "insufficient-data";
      evidenceIds: string[];
    }
  | {
      kind: "stop";
      rationale: string;
      code: string;
      message: string;
    };

export interface AgentDecisionRecord {
  step: number;
  decidedAt: string;
  decision: AgentDecision;
  execution?: AgentExecutionReceipt;
}

/** Provider transport metadata, never parsed from model-authored decision JSON. */
export interface AgentExecutionReceipt {
  protocol: "responses" | "chat-completions";
  requestedModel: string;
  reportedModel?: string;
  reasoningEffortSent?: string;
  reasoningEffortReported?: string;
  servedBy?: "primary" | "fallback";
  failoverCategory?: string;
}

export interface AgentToolRecord {
  step: number;
  fingerprint: string;
  call: AgentToolCall;
  effect: AgentToolEffect;
  startedAt: string;
  completedAt: string;
  outcome: AgentToolOutcome;
}

export interface AgentPendingTool {
  step: number;
  fingerprint: string;
  call: AgentToolCall;
  effect: AgentToolEffect;
  state: "ready" | "awaiting-approval" | "executing";
  approval?: AgentApproval;
}

export interface AgentCheckpoint {
  schemaVersion: 1;
  id: string;
  projectId: string;
  principal: string;
  role?: string;
  objective: string;
  modelOptions?: { model?: string; reasoningEffort?: "minimal" | "standard" | "deep" };
  context: unknown;
  status: AgentRunStatus;
  /** H-C1 plan 档：true 时工具面收敛为 read/analyze，finish 不允许 production 结论。 */
  planMode?: boolean;
  /** H-C2 保安状态：变体拒绝计数与熔断记录（持久化在 checkpoint，随恢复语义走）。 */
  guards?: AgentGuardState;
  budget: AgentBudget;
  usage: { steps: number; toolCalls: number; activeDurationMs: number };
  allowedToolIds: string[];
  decisions: AgentDecisionRecord[];
  toolRecords: AgentToolRecord[];
  seenToolFingerprints: string[];
  pendingTool?: AgentPendingTool;
  pendingSelection?: { step: number; question: string; options: AgentSelectionOption[] };
  selections?: Array<{ step: number; option: AgentSelectionOption; selectedBy: string; selectedAt: string }>;
  decisionRecoveries?: Array<{ revision: number; resumedAt: string; failure: NonNullable<AgentCheckpoint["failure"]> }>;
  completion?: Extract<AgentDecision, { kind: "finish" }>;
  failure?: { code: string; message: string; retryable: boolean; phase?: "decision" | "tool" };
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface AgentSelectionOption { id: string; label: string; description?: string }
export interface ResumeAgentRunOptions {
  approval?: AgentApproval;
  expectedRevision?: number;
  selectionId?: string;
  selectedBy?: string;
  signal?: AbortSignal;
}

/**
 * H-C2 受控挂载点（增强 1）：循环内恰好两处确定性回调，不是 hook 框架。
 * 实现方只能是仓内确定性模块（保安/记忆），不暴露用户自定义脚本；
 * 硬性 allow/deny 仍归工具网关，挂载点只做增值检查与记录。
 */
export interface AgentGuardPreExecuteContext {
  checkpoint: AgentCheckpoint;
  call: AgentToolCall;
  effect: AgentToolEffect;
  signal: AbortSignal;
}

/** pre-execute 拒绝：拒绝的工具不执行；variantKey 用于同变体连续拒绝的熔断计数。 */
export interface AgentGuardRejection {
  code: string;
  message: string;
  retryable?: boolean;
  variantKey?: string;
}

export interface AgentGuardPostExecuteContext {
  checkpoint: AgentCheckpoint;
  call: AgentToolCall;
  effect: AgentToolEffect;
  outcome: AgentToolOutcome;
}

export interface AgentGuardHooks {
  /** tool.pre-execute：语义预检等增值检查。返回 undefined 放行；返回拒绝即不执行。 */
  preExecute?: (context: AgentGuardPreExecuteContext) => Promise<AgentGuardRejection | undefined>;
  /** tool.post-execute：verdict 回灌等增值记录。抛错不阻断执行链（由实现侧落审计）。 */
  postExecute?: (context: AgentGuardPostExecuteContext) => Promise<void>;
}

/** 同变体拒绝计数；熔断一旦打开即终态，随 checkpoint 持久化。 */
export interface AgentGuardState {
  variantDenials?: Record<string, { count: number; lastCode: string; lastMessage: string; lastDeniedAt: string }>;
  circuit?: { variantKey: string; reasonCode: string; message: string; openedAt: string; denials: number };
}

export interface StartAgentRunInput {
  projectId: string;
  principal: string;
  role?: string;
  objective: string;
  modelOptions?: AgentCheckpoint["modelOptions"];
  context?: unknown;
  allowedToolIds: string[];
  /** 计划模式：只读/分析探索并输出计划文档（finish-with-plan），不执行 simulate/write/control。 */
  planMode?: boolean;
  budget?: Partial<AgentBudget>;
  signal?: AbortSignal;
}

export interface AgentDecisionRequest {
  checkpoint: AgentCheckpoint;
  availableTools: AgentToolDefinition[];
  signal: AbortSignal;
  reportExecution?: (receipt: AgentExecutionReceipt) => void;
}

export interface AgentDecisionProvider {
  decide(request: AgentDecisionRequest): Promise<unknown>;
}

export interface AgentToolExecutionContext {
  checkpoint: AgentCheckpoint;
  approval?: AgentApproval;
  signal: AbortSignal;
}

export interface AgentToolGateway {
  list(): AgentToolDefinition[];
  fingerprint(call: AgentToolCall): string;
  execute(call: AgentToolCall, context: AgentToolExecutionContext): Promise<AgentToolOutcome>;
}

export interface AgentCheckpointStore {
  get(id: string): Promise<AgentCheckpoint | undefined>;
  save(checkpoint: AgentCheckpoint): Promise<void>;
}
