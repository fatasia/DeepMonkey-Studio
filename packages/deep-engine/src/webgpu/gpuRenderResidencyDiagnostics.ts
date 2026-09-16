import type {
  ResidencyActivity, ResidencyDiagnosticScope, ResidencyDiagnosticsHooks,
  ResidencyOperationOutcome,
} from "../residencyDiagnostics.js";
import type {
  GpuRenderResidencyFrameResult, GpuRenderResidencyRequest,
} from "./gpuRenderResidencyRuntimeTypes.js";
import type { GpuRenderResidencyTelemetrySnapshot } from "./gpuRenderResidencyTelemetry.js";

export interface GpuRenderResidencyDiagnosticTrace {
  readonly generation: number;
  readonly deviceEpoch: string;
  readonly requestedCount: number;
  readonly startedAt: number;
}

let epochSequence = 0;
export function nextGpuRenderResidencyEpoch(): string {
  epochSequence += 1;
  return `browser-render-residency-${epochSequence}`;
}

/** Emits observations only; the controller/executor remain the sole residency authority. */
export class GpuRenderResidencyDiagnostics {
  private hooks: ResidencyDiagnosticsHooks | undefined;
  private generation = 0;
  private latestRecordedExecution = 0;
  private closed = false;

  constructor(hooks: ResidencyDiagnosticsHooks | undefined, private readonly deviceEpoch: string) {
    this.hooks = enabledHooks(hooks);
    this.safely(() => this.hooks!.recorder.beginGeneration(this.scope()));
  }

  get enabled(): boolean { return this.hooks !== undefined && !this.closed; }

  begin(requests: readonly GpuRenderResidencyRequest[], isHit: (request: GpuRenderResidencyRequest) => boolean):
  GpuRenderResidencyDiagnosticTrace | undefined {
    if (!this.hooks || this.closed) return undefined;
    const startedAt = this.readClock();
    if (startedAt === undefined) return undefined;
    let hits = 0;
    for (const request of requests) if (isHit(request)) hits += 1;
    if (hits) { this.activity("hit", hits, this.generation); this.activity("reuse", hits, this.generation); }
    if (hits < requests.length) this.activity("miss", requests.length - hits, this.generation);
    return Object.freeze({ ...this.scope(), requestedCount: requests.length, startedAt });
  }

  complete(trace: GpuRenderResidencyDiagnosticTrace | undefined,
    result: GpuRenderResidencyFrameResult,
    snapshot: GpuRenderResidencyTelemetrySnapshot): void {
    if (!trace || !this.hooks || this.closed) return;
    const executionGeneration = result.execution?.generation;
    if (executionGeneration !== undefined && executionGeneration <= this.latestRecordedExecution) {
      this.activity("reuse", trace.requestedCount, trace.generation);
      return;
    }
    if (result.status === "applied" && result.execution) {
      this.latestRecordedExecution = executionGeneration!;
      const failedUploads = result.execution.commit.failedUploads.length;
      const uploadWork = result.execution.commit.appliedUploads.length + failedUploads;
      if (uploadWork) this.timing(failedUploads ? "failure" : "success", trace);
      this.activity("commit", 1, trace.generation);
      if (failedUploads) {
        this.activity("rollback", failedUploads, trace.generation);
      }
      if (result.execution.commit.evicted.length) {
        this.activity("evict", result.execution.commit.evicted.length, trace.generation);
      }
      this.residency(snapshot, trace.generation);
      return;
    }
    if (result.status === "superseded") {
      if (result.execution) this.timing("aborted", trace);
      this.activity("abort", 1, trace.generation);
      if (result.execution?.cancelledUploadCount || result.execution?.commit.failedUploads.length) {
        this.activity("rollback", Math.max(1, result.execution.cancelledUploadCount), trace.generation);
      }
      return;
    }
    this.timing("failure", trace);
    this.activity("rollback", 1, trace.generation);
  }

  fail(trace: GpuRenderResidencyDiagnosticTrace | undefined, aborted: boolean): void {
    if (!trace || !this.hooks || this.closed) return;
    this.timing(aborted ? "aborted" : "failure", trace);
    if (aborted) this.activity("abort", 1, trace.generation);
    this.activity("rollback", 1, trace.generation);
  }

  close(snapshot: GpuRenderResidencyTelemetrySnapshot, evictedCount: number): void {
    if (!this.hooks || this.closed) return;
    this.closed = true;
    this.generation += 1;
    this.safely(() => this.hooks!.recorder.beginGeneration(this.scope()));
    if (evictedCount) this.activity("evict", evictedCount, this.generation);
    this.residency(snapshot, this.generation);
  }

  private scope(): ResidencyDiagnosticScope {
    return { generation: this.generation, deviceEpoch: this.deviceEpoch };
  }

  private activity(activity: ResidencyActivity, count: number, generation: number): void {
    this.safely(() => this.hooks!.recorder.record({ kind: "activity", domain: "resource",
      activity, count, generation, deviceEpoch: this.deviceEpoch }));
  }

  private residency(snapshot: GpuRenderResidencyTelemetrySnapshot, generation: number): void {
    this.safely(() => this.hooks!.recorder.record({ kind: "residency", domain: "resource",
      residentBytes: snapshot.residentBytes, budgetBytes: snapshot.budgets.maxResidentBytes,
      generation, deviceEpoch: this.deviceEpoch }));
  }

  private timing(outcome: ResidencyOperationOutcome, trace: GpuRenderResidencyDiagnosticTrace): void {
    const endedAt = this.readClock();
    if (endedAt === undefined || endedAt < trace.startedAt) { this.hooks = undefined; return; }
    this.safely(() => this.hooks!.recorder.record({ kind: "timing", domain: "resource",
      operation: "upload", outcome, durationMs: endedAt - trace.startedAt,
      generation: trace.generation, deviceEpoch: trace.deviceEpoch }));
  }

  private readClock(): number | undefined {
    if (!this.hooks) return undefined;
    try {
      const value = this.hooks.clock.now();
      if (!Number.isFinite(value) || value < 0) throw new Error("Invalid diagnostics clock.");
      return value;
    } catch { this.hooks = undefined; return undefined; }
  }

  private safely(operation: () => void): void {
    if (!this.hooks) return;
    try { operation(); } catch { this.hooks = undefined; }
  }
}

function enabledHooks(value: ResidencyDiagnosticsHooks | undefined): ResidencyDiagnosticsHooks | undefined {
  if (!value) return undefined;
  if (!value.recorder || typeof value.recorder.enabled !== "boolean"
    || typeof value.recorder.beginGeneration !== "function" || typeof value.recorder.record !== "function"
    || typeof value.clock?.now !== "function") return undefined;
  return value.recorder.enabled ? value : undefined;
}
