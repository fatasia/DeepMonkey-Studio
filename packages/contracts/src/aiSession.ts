export type AiSessionMessageStatus = "streaming" | "completed" | "stopped" | "failed" | "interrupted";
/**
 * 有界的回答可靠性快照。它只记录页面已展示的元数据，不能替代重新执行
 * Capability；保存它的目的在于刷新后仍能解释回答来自哪些证据。
 */
export interface AiSessionReliability {
  contextDelivery?: import("./index.js").AiContextDelivery;
  contextSourceLabels?: Record<string, string>;
  grade: "capability-verified" | "context-supported" | "limited" | "unverified";
  contextTrust: "client-snapshot" | "server-evidence" | "capability-result";
  traceId?: string;
  contextFingerprint?: string;
  evidenceCount: number;
  inputRisk: "low" | "medium" | "high";
  writePolicy: "read-only" | "confirm-required";
  warnings: string[];
  sourceLabels: string[];
  fallbackReason?: "no-capability-evidence";
}
export interface AiSessionSummary {
  id: string;
  projectId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
/** A message is one question/answer turn; sequence is the client's monotonic snapshot version. */
export interface AiSessionMessageInput {
  sequence: number;
  question: string;
  answer: string;
  mode: "platform" | "operations" | "vision" | "bim" | "scene" | "component" | "dashboard" | "sql";
  status: Exclude<AiSessionMessageStatus, "interrupted">;
  model?: string;
  execution?: import("./index.js").AiAssistantResponse["execution"];
  reliability?: AiSessionReliability;
  scope?: string;
}
export interface AiSessionMessage extends Omit<AiSessionMessageInput, "status"> {
  id: string;
  status: AiSessionMessageStatus;
  createdAt: string;
  updatedAt: string;
}
export interface AiSessionList { items: AiSessionSummary[]; nextCursor?: string }
export interface AiSessionMessages { session: AiSessionSummary; messages: AiSessionMessage[]; nextCursor?: string }
