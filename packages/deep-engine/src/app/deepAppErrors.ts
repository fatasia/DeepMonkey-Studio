import type { FrameStageTrace } from "../frameScheduler.js";

export class DeepAppConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Deep application configuration is invalid: ${issues.join("; ")}`);
    this.name = "DeepAppConfigurationError";
  }
}

export class DeepAppInitializationError extends Error {
  constructor(readonly trace: readonly FrameStageTrace[], readonly cleanupErrors: readonly unknown[], cause?: unknown) {
    const failed = trace.find(entry => entry.status === "failed");
    super(`Deep application initialization failed${failed ? ` in plugin ${failed.stage}: ${failed.error ?? "unknown error"}` : "."}`,
      cause === undefined ? undefined : { cause });
    this.name = "DeepAppInitializationError";
  }
}

export class DeepAppCleanupError extends Error {
  constructor(readonly errors: readonly unknown[]) {
    super(`Deep application cleanup failed in ${errors.length} disposer${errors.length === 1 ? "" : "s"}.`);
    this.name = "DeepAppCleanupError";
  }
}

