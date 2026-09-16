import {
  RESIDENCY_DIAGNOSTIC_DOMAINS,
  type ResidencyActivity,
  type ResidencyDiagnosticDomain,
  type ResidencyDiagnosticSample,
  type ResidencyDiagnosticScope,
  type ResidencyDiagnosticsRecorder,
  type ResidencyDiagnosticsSnapshot,
  type ResidencyDomainSnapshot,
  type ResidencyOperationOutcome,
  type ResidencyTimedOperation,
  type ResidencyTimingPercentiles,
  type ResidencyTimingSnapshot,
} from "./residencyDiagnosticsTypes.js";

export * from "./residencyDiagnosticsTypes.js";

type StoredSample = ResidencyDiagnosticSample & Readonly<{ cold: boolean }>;
type MutableActivity = Record<ResidencyActivity, number>;
type MutableOutcomes = Record<ResidencyOperationOutcome, number>;

const ACTIVITIES = Object.freeze([
  "hit", "miss", "reuse", "evict", "commit", "rollback", "abort",
] as const);
const OPERATIONS = Object.freeze(["compile", "upload"] as const);
const OUTCOMES = Object.freeze(["success", "aborted", "failure"] as const);
const DOMAIN_SET = new Set<string>(RESIDENCY_DIAGNOSTIC_DOMAINS);
const ACTIVITY_SET = new Set<string>(ACTIVITIES);
const OPERATION_SET = new Set<string>(OPERATIONS);
const OUTCOME_SET = new Set<string>(OUTCOMES);

/** A bounded, opt-in observation window shared by shader, pipeline, and resource producers. */
export class ResidencyDiagnosticsWindow implements ResidencyDiagnosticsRecorder {
  private readonly samples: StoredSample[] = [];
  private generationValue: number | null = null;
  private deviceEpochValue: string | null = null;
  private late = 0;
  private coldCompile: number | null = null;
  private coldUpload: number | null = null;

  constructor(readonly capacity = 128, public enabled = false) {
    if (!Number.isSafeInteger(capacity) || capacity < 4 || capacity > 4096) {
      throw new RangeError("Residency diagnostics capacity must be an integer from 4 through 4096.");
    }
  }

  beginGeneration(scope: ResidencyDiagnosticScope): void {
    if (!this.enabled) return;
    validateScope(scope);
    if (scope.generation === this.generationValue && scope.deviceEpoch === this.deviceEpochValue) return;
    if (scope.deviceEpoch === this.deviceEpochValue && this.generationValue !== null
      && scope.generation < this.generationValue) {
      throw new RangeError("Residency diagnostics generation cannot move backwards within a device epoch.");
    }
    this.generationValue = scope.generation;
    this.deviceEpochValue = scope.deviceEpoch;
    this.samples.length = 0;
    this.late = 0;
    this.coldCompile = null;
    this.coldUpload = null;
  }

  record(sample: ResidencyDiagnosticSample): void {
    if (!this.enabled) return;
    validateSample(sample);
    if (this.generationValue === null || this.deviceEpochValue === null) {
      throw new Error("Residency diagnostics generation must be started before recording samples.");
    }
    if (sample.generation !== this.generationValue || sample.deviceEpoch !== this.deviceEpochValue) {
      this.late += 1;
      return;
    }
    let cold = false;
    if (sample.kind === "timing" && sample.outcome === "success") {
      if (sample.operation === "compile" && this.coldCompile === null) {
        this.coldCompile = sample.durationMs; cold = true;
      } else if (sample.operation === "upload" && this.coldUpload === null) {
        this.coldUpload = sample.durationMs; cold = true;
      }
    }
    this.samples.push(Object.freeze({ ...sample, cold }));
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  snapshot(): ResidencyDiagnosticsSnapshot {
    const domains = Object.fromEntries(RESIDENCY_DIAGNOSTIC_DOMAINS.map(domain => [
      domain, this.domainSnapshot(domain),
    ])) as Record<ResidencyDiagnosticDomain, ResidencyDomainSnapshot>;
    return Object.freeze({ enabled: this.enabled, capacity: this.capacity,
      generation: this.generationValue, deviceEpoch: this.deviceEpochValue,
      retainedSamples: this.samples.length, lateSamples: this.late,
      domains: Object.freeze(domains), timings: Object.freeze({
        compile: this.timingSnapshot("compile", this.coldCompile),
        upload: this.timingSnapshot("upload", this.coldUpload),
      }) });
  }

  private domainSnapshot(domain: ResidencyDiagnosticDomain): ResidencyDomainSnapshot {
    const activity = emptyActivity();
    let residentBytes: number | null = null, budgetBytes: number | null = null;
    let peakResidentBytes = 0, peakBudgetPressure = 0;
    for (const sample of this.samples) {
      if (sample.domain !== domain) continue;
      if (sample.kind === "activity") activity[sample.activity] += sample.count ?? 1;
      else if (sample.kind === "residency") {
        residentBytes = sample.residentBytes; budgetBytes = sample.budgetBytes;
        peakResidentBytes = Math.max(peakResidentBytes, residentBytes);
        peakBudgetPressure = Math.max(peakBudgetPressure, residentBytes / budgetBytes);
      }
    }
    return Object.freeze({ activity: Object.freeze(activity), residentBytes, peakResidentBytes,
      budgetBytes, budgetPressure: residentBytes === null ? null : residentBytes / budgetBytes!,
      peakBudgetPressure });
  }

  private timingSnapshot(operation: ResidencyTimedOperation, coldMs: number | null): ResidencyTimingSnapshot {
    const outcomes = emptyOutcomes();
    const warm: number[] = [];
    for (const sample of this.samples) {
      if (sample.kind !== "timing" || sample.operation !== operation) continue;
      outcomes[sample.outcome] += 1;
      if (sample.outcome === "success" && !sample.cold) warm.push(sample.durationMs);
    }
    return Object.freeze({ coldMs, warm: percentiles(warm), outcomes: Object.freeze(outcomes) });
  }
}

function percentiles(values: readonly number[]): ResidencyTimingPercentiles | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (fraction: number): number => sorted[Math.ceil(fraction * sorted.length) - 1]!;
  return Object.freeze({ samples: sorted.length,
    p50Ms: at(0.5), p95Ms: at(0.95), p99Ms: at(0.99) });
}

function emptyActivity(): MutableActivity {
  return { hit: 0, miss: 0, reuse: 0, evict: 0, commit: 0, rollback: 0, abort: 0 };
}
function emptyOutcomes(): MutableOutcomes { return { success: 0, aborted: 0, failure: 0 }; }

function validateScope(scope: ResidencyDiagnosticScope): void {
  if (!scope || !Number.isSafeInteger(scope.generation) || scope.generation < 0
    || typeof scope.deviceEpoch !== "string" || scope.deviceEpoch.length < 1 || scope.deviceEpoch.length > 128) {
    throw new RangeError("Residency diagnostics scope requires a generation and bounded device epoch.");
  }
}

function validateSample(sample: ResidencyDiagnosticSample): void {
  validateScope(sample);
  if (!DOMAIN_SET.has(sample.domain)) throw new RangeError("Unknown residency diagnostics domain.");
  if (sample.kind === "activity") {
    if (!ACTIVITY_SET.has(sample.activity) || (sample.count !== undefined
      && (!Number.isSafeInteger(sample.count) || sample.count < 1))) {
      throw new RangeError("Invalid residency cache activity sample.");
    }
  } else if (sample.kind === "timing") {
    if (!OPERATION_SET.has(sample.operation) || !OUTCOME_SET.has(sample.outcome)
      || !Number.isFinite(sample.durationMs) || sample.durationMs < 0) {
      throw new RangeError("Invalid residency timing sample.");
    }
  } else if (sample.kind === "residency") {
    if (!Number.isSafeInteger(sample.residentBytes) || sample.residentBytes < 0
      || !Number.isSafeInteger(sample.budgetBytes) || sample.budgetBytes < 1) {
      throw new RangeError("Invalid residency byte sample.");
    }
  } else throw new RangeError("Unknown residency diagnostics sample kind.");
}
