export type LoadingStage = "asset-read" | "load-and-parse" | "scene-attach";
export type LoadOutcome = "ok" | "failed" | "cancelled";
export type SharedLoadState = "none" | "miss" | "pending" | "ready";
export interface LoadingSample {
  sequence: number; stage: LoadingStage; startedAtMs: number; durationMs: number; outcome: LoadOutcome;
  format?: string; shared?: SharedLoadState; decodedBytes?: number;
}

/** 只保存耗时与格式，不记录模型名称、URL、项目 ID 或错误中的业务内容。 */
export class LoadingTimeline {
  private sequence = 0;
  private readonly samples: LoadingSample[] = [];
  constructor(private readonly now = () => performance.now(), private readonly limit = 128) {}
  begin(stage: LoadingStage, details: Pick<LoadingSample, "format" | "shared"> = {}) {
    const startedAtMs = this.now(); const sequence = ++this.sequence; let finished = false;
    return (outcome: LoadOutcome, decodedBytes?: number) => {
      if (finished) return; finished = true;
      this.samples.push({ sequence, stage, startedAtMs, durationMs: Math.max(0, this.now() - startedAtMs), outcome, ...details,
        ...(decodedBytes !== undefined && Number.isFinite(decodedBytes) && decodedBytes >= 0 ? { decodedBytes } : {}) });
      if (this.samples.length > this.limit) this.samples.splice(0, this.samples.length - this.limit);
    };
  }
  snapshot() { return { sampleLimit: this.limit, totalStarted: this.sequence, samples: this.samples.map(sample => ({ ...sample })) }; }
}
export const loadingTimeline = new LoadingTimeline();
export function loadingFailureOutcome(error: unknown): LoadOutcome {
  return error instanceof Error && (error.name === "AbortError" || error.name === "ModelLoadSupersededError") ? "cancelled" : "failed";
}

export async function measureAssetRead<T>(operation: () => Promise<T>): Promise<T> {
  const finish = loadingTimeline.begin("asset-read");
  try {
    const result = await operation();
    finish("ok", result instanceof ArrayBuffer ? result.byteLength : result instanceof Blob ? result.size : undefined);
    return result;
  } catch (error) { finish(loadingFailureOutcome(error)); throw error; }
}
