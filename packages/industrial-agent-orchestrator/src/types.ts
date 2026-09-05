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
  context: unknown;
  status: AgentRunStatus;
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

export interface StartAgentRunInput {
  projectId: string;
  principal: string;
  role?: string;
  objective: string;
  context?: unknown;
  allowedToolIds: string[];
  budget?: Partial<AgentBudget>;
  signal?: AbortSignal;
}

export interface AgentDecisionRequest {
  checkpoint: AgentCheckpoint;
  availableTools: AgentToolDefinition[];
  signal: AbortSignal;
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
