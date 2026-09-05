export class AgentRunError extends Error {
  constructor(
    readonly code: "not-found" | "invalid-input" | "invalid-state" | "run-busy" | "approval-mismatch" | "checkpoint-conflict",
    message: string,
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}

/** 只有可信提供方适配器可以将传输失败标记为可恢复决策失败。 */
export class AgentDecisionUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = "AgentDecisionUnavailableError"; }
}
