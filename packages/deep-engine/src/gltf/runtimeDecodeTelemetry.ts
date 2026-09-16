export const RUNTIME_DECODE_STAGES = Object.freeze([
  "parse", "deformation", "texturedImageDecode", "projection", "total",
] as const);

export type RuntimeDecodeStage = typeof RUNTIME_DECODE_STAGES[number];
export type RuntimeDecodeOutcome = "success" | "aborted" | "failure";
export type RuntimeDecodeInvocation = "glb" | "gltf";
export type RuntimeDecodeStageDurations = Readonly<Record<RuntimeDecodeStage, number | null>>;

export interface RuntimeDecodeTelemetrySample {
  readonly invocation: RuntimeDecodeInvocation;
  readonly outcome: RuntimeDecodeOutcome;
  readonly stagesMs: RuntimeDecodeStageDurations;
  /** Retained deformation, geometry, and image payload bytes completed by this attempt. */
  readonly decodedBytes: number;
  readonly error?: Readonly<{ name: string; message: string }>;
}

export interface RuntimeDecodeMonotonicClock { now(): number }
export interface RuntimeDecodeTelemetryRecorder { record(sample: RuntimeDecodeTelemetrySample): void }
export interface RuntimeDecodeTelemetryHooks {
  readonly clock: RuntimeDecodeMonotonicClock;
  readonly recorder: RuntimeDecodeTelemetryRecorder;
}

export interface RuntimeDecodePercentiles {
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
}

export interface RuntimeDecodeTelemetrySnapshot {
  readonly capacity: number;
  readonly totalSamples: number;
  readonly retainedSamples: number;
  readonly coldFirst: RuntimeDecodeTelemetrySample | null;
  readonly outcomes: Readonly<Record<RuntimeDecodeOutcome, number>>;
  readonly warm: Readonly<{
    successfulSamples: number;
    stagesMs: Readonly<Record<RuntimeDecodeStage, RuntimeDecodePercentiles | null>>;
    decodedBytes: RuntimeDecodePercentiles | null;
  }>;
}

/** Fixed-capacity diagnostics sink. Cold-first is preserved; warm percentiles use successful later attempts. */
export class RuntimeDecodeTelemetryWindow implements RuntimeDecodeTelemetryRecorder {
  private readonly samples: RuntimeDecodeTelemetrySample[] = [];
  private first: RuntimeDecodeTelemetrySample | null = null;
  private total = 0;
  private readonly counts: Record<RuntimeDecodeOutcome, number> = { success: 0, aborted: 0, failure: 0 };

  constructor(readonly capacity = 128) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) {
      throw new Error("Runtime decode telemetry capacity must be an integer from 1 to 4096.");
    }
  }

  record(sample: RuntimeDecodeTelemetrySample): void {
    validateSample(sample);
    const owned = snapshotSample(sample);
    this.total += 1; this.counts[owned.outcome] += 1;
    if (!this.first) this.first = owned;
    else {
      this.samples.push(owned);
      if (this.samples.length > this.capacity - 1) this.samples.shift();
    }
  }

  snapshot(): RuntimeDecodeTelemetrySnapshot {
    const successful = this.samples.filter(sample => sample.outcome === "success");
    const stages = Object.fromEntries(RUNTIME_DECODE_STAGES.map(stage => [stage,
      percentileSet(successful.flatMap(sample => sample.stagesMs[stage] === null ? [] : [sample.stagesMs[stage]])),
    ])) as Record<RuntimeDecodeStage, RuntimeDecodePercentiles | null>;
    return Object.freeze({ capacity: this.capacity, totalSamples: this.total,
      retainedSamples: this.samples.length + (this.first ? 1 : 0),
      coldFirst: this.first, outcomes: Object.freeze({ ...this.counts }), warm: Object.freeze({
        successfulSamples: successful.length, stagesMs: Object.freeze(stages),
        decodedBytes: percentileSet(successful.map(sample => sample.decodedBytes)),
      }) });
  }
}

export class RuntimeDecodeTrace {
  readonly invocation: RuntimeDecodeInvocation;
  private readonly values: Record<RuntimeDecodeStage, number | null> = {
    parse: null, deformation: null, texturedImageDecode: null, projection: null, total: null,
  };
  private readonly startedAt: number;
  private lastNow: number;
  private done = false;

  constructor(private readonly hooks: RuntimeDecodeTelemetryHooks, invocation: RuntimeDecodeInvocation) {
    if (!hooks || typeof hooks !== "object" || typeof hooks.clock?.now !== "function"
      || typeof hooks.recorder?.record !== "function") throw new Error("Invalid runtime decode telemetry hooks.");
    this.invocation = invocation;
    this.startedAt = this.readNow(); this.lastNow = this.startedAt;
  }

  get finished(): boolean { return this.done; }

  measure<T>(stage: Exclude<RuntimeDecodeStage, "total">, operation: () => T): T {
    const start = this.readNow();
    try { return operation(); }
    finally { this.values[stage] = this.readNow() - start; }
  }

  async measureAsync<T>(stage: Exclude<RuntimeDecodeStage, "total">, operation: () => Promise<T>): Promise<T> {
    const start = this.readNow();
    try { return await operation(); }
    finally { this.values[stage] = this.readNow() - start; }
  }

  finish(outcome: RuntimeDecodeOutcome, decodedBytes: number, error?: unknown): void {
    if (this.done) return;
    this.values.total = this.readNow() - this.startedAt; this.done = true;
    const detail = outcome === "success" ? undefined : errorDetail(error);
    this.hooks.recorder.record(Object.freeze({ invocation: this.invocation, outcome,
      stagesMs: Object.freeze({ ...this.values }), decodedBytes, ...(detail ? { error: detail } : {}) }));
  }

  private readNow(): number {
    const value = this.hooks.clock.now();
    if (!Number.isFinite(value) || value < 0 || (this.lastNow !== undefined && value < this.lastNow)) {
      throw new Error("Runtime decode telemetry clock must be finite, non-negative, and monotonic.");
    }
    this.lastNow = value; return value;
  }
}

function percentileSet(values: readonly number[]): RuntimeDecodePercentiles | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (percentile: number) => sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
  return Object.freeze({ p50: at(0.5), p95: at(0.95), p99: at(0.99) });
}

function validateSample(sample: RuntimeDecodeTelemetrySample): void {
  if (!sample || !["glb", "gltf"].includes(sample.invocation)
    || !["success", "aborted", "failure"].includes(sample.outcome)
    || !Number.isSafeInteger(sample.decodedBytes) || sample.decodedBytes < 0) {
    throw new Error("Invalid runtime decode telemetry sample.");
  }
  for (const stage of RUNTIME_DECODE_STAGES) {
    const value = sample.stagesMs?.[stage];
    if (value !== null && (!Number.isFinite(value) || value < 0)) throw new Error(`Invalid ${stage} runtime decode timing.`);
  }
}

function snapshotSample(sample: RuntimeDecodeTelemetrySample): RuntimeDecodeTelemetrySample {
  return Object.freeze({ invocation: sample.invocation, outcome: sample.outcome,
    stagesMs: Object.freeze({ ...sample.stagesMs }), decodedBytes: sample.decodedBytes,
    ...(sample.error ? { error: Object.freeze({ name: sample.error.name, message: sample.error.message }) } : {}) });
}

function errorDetail(value: unknown): Readonly<{ name: string; message: string }> {
  if (value instanceof Error) return Object.freeze({ name: value.name, message: value.message.slice(0, 512) });
  return Object.freeze({ name: "Error", message: String(value).slice(0, 512) });
}
