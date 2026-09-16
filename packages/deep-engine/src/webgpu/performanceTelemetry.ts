export const ENGINE_TIMING_STAGES = Object.freeze([
  "cold-start",
  "asset-parse",
  "scene-extract",
  "frame-encode",
  "queue-submit",
  "gpu-frame",
  "present-acquire",
] as const);

export type EngineTimingStage = typeof ENGINE_TIMING_STAGES[number];

export interface EngineTimingQuantiles {
  readonly samples: number;
  readonly coverage: number;
  readonly minimumMs: number;
  readonly meanMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maximumMs: number;
}

export interface EnginePerformanceTelemetrySnapshot {
  readonly capacity: number;
  readonly retainedFrameCount: number;
  readonly firstFrame: number | null;
  readonly lastFrame: number | null;
  readonly stages: Readonly<Partial<Record<EngineTimingStage, EngineTimingQuantiles>>>;
}

export interface EngineFrameTimingSample {
  readonly frame: number;
  readonly timings: Readonly<Partial<Record<EngineTimingStage, number>>>;
}

const STAGES = new Set<string>(ENGINE_TIMING_STAGES);

/**
 * Bounded diagnostics window. GPU timings may arrive after CPU timings and are
 * merged into the same frame; a conflicting second value fails closed.
 */
export class EnginePerformanceTelemetry {
  private readonly frames = new Map<number, Map<EngineTimingStage, number>>();
  private evictedThrough = -1;

  constructor(readonly capacity = 256, public enabled = false) {
    if (!Number.isSafeInteger(capacity) || capacity < 16 || capacity > 4096) {
      throw new RangeError("Performance telemetry capacity must be an integer from 16 to 4096.");
    }
  }

  record(sample: EngineFrameTimingSample): void {
    if (!this.enabled) return;
    assertFrame(sample.frame);
    if (sample.frame <= this.evictedThrough) {
      throw new RangeError("Performance timing arrived after its frame was evicted.");
    }
    const entries = Object.entries(sample.timings);
    if (!entries.length) throw new RangeError("Performance timing sample must contain at least one stage.");
    const validated = entries.map(([stage, milliseconds]) => {
      if (!STAGES.has(stage)) throw new RangeError(`Unknown performance timing stage: ${stage}.`);
      assertMilliseconds(milliseconds, stage);
      return [stage as EngineTimingStage, milliseconds] as const;
    });
    const frame = this.frames.get(sample.frame) ?? new Map<EngineTimingStage, number>();
    for (const [stage, milliseconds] of validated) {
      const previous = frame.get(stage);
      if (previous !== undefined && previous !== milliseconds) {
        throw new Error(`Performance timing already recorded for frame ${sample.frame}, stage ${stage}.`);
      }
    }
    for (const [stage, milliseconds] of validated) frame.set(stage, milliseconds);
    this.frames.set(sample.frame, frame);
    this.trim();
  }

  recordStage(frame: number, stage: EngineTimingStage, milliseconds: number): void {
    this.record({ frame, timings: { [stage]: milliseconds } });
  }

  snapshot(): EnginePerformanceTelemetrySnapshot {
    const frameIds = [...this.frames.keys()].sort((left, right) => left - right);
    const stageSummaries: Partial<Record<EngineTimingStage, EngineTimingQuantiles>> = {};
    for (const stage of ENGINE_TIMING_STAGES) {
      const samples = frameIds.flatMap(frame => {
        const value = this.frames.get(frame)?.get(stage);
        return value === undefined ? [] : [value];
      });
      if (samples.length) stageSummaries[stage] = summarize(samples, frameIds.length);
    }
    return Object.freeze({
      capacity: this.capacity,
      retainedFrameCount: frameIds.length,
      firstFrame: frameIds[0] ?? null,
      lastFrame: frameIds.at(-1) ?? null,
      stages: Object.freeze(stageSummaries),
    });
  }

  /** Clears retained values while keeping a barrier against late samples from the old window. */
  reset(): void {
    for (const frame of this.frames.keys()) this.evictedThrough = Math.max(this.evictedThrough, frame);
    this.frames.clear();
  }

  private trim(): void {
    if (this.frames.size <= this.capacity) return;
    const oldest = Math.min(...this.frames.keys());
    this.frames.delete(oldest);
    this.evictedThrough = Math.max(this.evictedThrough, oldest);
  }
}

function summarize(values: readonly number[], retainedFrameCount: number): EngineTimingQuantiles {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return Object.freeze({
    samples: sorted.length,
    coverage: sorted.length / retainedFrameCount,
    minimumMs: sorted[0]!,
    meanMs: total / sorted.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
    maximumMs: sorted.at(-1)!,
  });
}

function assertFrame(frame: number): void {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new RangeError("Performance telemetry frame must be a non-negative safe integer.");
  }
}

function assertMilliseconds(value: unknown, stage: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`Performance timing for ${stage} must be finite and non-negative.`);
  }
}
