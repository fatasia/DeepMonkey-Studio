export const RESIDENCY_DIAGNOSTIC_DOMAINS = Object.freeze([
  "shader", "pipeline", "resource",
] as const);

export type ResidencyDiagnosticDomain = typeof RESIDENCY_DIAGNOSTIC_DOMAINS[number];
export type ResidencyCacheActivity = "hit" | "miss" | "reuse" | "evict";
export type ResidencyTransactionActivity = "commit" | "rollback" | "abort";
export type ResidencyActivity = ResidencyCacheActivity | ResidencyTransactionActivity;
export type ResidencyTimedOperation = "compile" | "upload";
export type ResidencyOperationOutcome = "success" | "aborted" | "failure";

export interface ResidencyDiagnosticScope {
  readonly generation: number;
  readonly deviceEpoch: string;
}

interface ScopedSample extends ResidencyDiagnosticScope {
  readonly domain: ResidencyDiagnosticDomain;
}

export interface ResidencyActivitySample extends ScopedSample {
  readonly kind: "activity";
  readonly activity: ResidencyActivity;
  readonly count?: number;
}

export interface ResidencyTimingSample extends ScopedSample {
  readonly kind: "timing";
  readonly operation: ResidencyTimedOperation;
  readonly outcome: ResidencyOperationOutcome;
  readonly durationMs: number;
}

export interface ResidencyStateSample extends ScopedSample {
  readonly kind: "residency";
  readonly residentBytes: number;
  readonly budgetBytes: number;
}

export type ResidencyDiagnosticSample =
  | ResidencyActivitySample
  | ResidencyTimingSample
  | ResidencyStateSample;

export interface ResidencyDiagnosticsRecorder {
  readonly enabled: boolean;
  beginGeneration(scope: ResidencyDiagnosticScope): void;
  record(sample: ResidencyDiagnosticSample): void;
}

export interface ResidencyDiagnosticsClock { now(): number }

export interface ResidencyDiagnosticsHooks {
  readonly recorder: ResidencyDiagnosticsRecorder;
  readonly clock: ResidencyDiagnosticsClock;
}

export interface ResidencyTimingPercentiles {
  readonly samples: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
}

export interface ResidencyTimingSnapshot {
  readonly coldMs: number | null;
  readonly warm: ResidencyTimingPercentiles | null;
  readonly outcomes: Readonly<Record<ResidencyOperationOutcome, number>>;
}

export interface ResidencyDomainSnapshot {
  readonly activity: Readonly<Record<ResidencyActivity, number>>;
  readonly residentBytes: number | null;
  readonly peakResidentBytes: number;
  readonly budgetBytes: number | null;
  readonly budgetPressure: number | null;
  readonly peakBudgetPressure: number;
}

export interface ResidencyDiagnosticsSnapshot {
  readonly enabled: boolean;
  readonly capacity: number;
  readonly generation: number | null;
  readonly deviceEpoch: string | null;
  readonly retainedSamples: number;
  readonly lateSamples: number;
  readonly domains: Readonly<Record<ResidencyDiagnosticDomain, ResidencyDomainSnapshot>>;
  readonly timings: Readonly<Record<ResidencyTimedOperation, ResidencyTimingSnapshot>>;
}
