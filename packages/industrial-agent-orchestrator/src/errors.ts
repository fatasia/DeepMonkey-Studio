export class AgentRunError extends Error {
  constructor(
    readonly code: "not-found" | "invalid-input" | "invalid-state" | "run-busy" | "approval-mismatch",
    message: string,
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}
