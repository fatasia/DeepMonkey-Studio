export type FrameLoopMode = "always" | "demand" | "manual";

export interface FrameLoopStageContext<TContext> {
  readonly context: TContext;
  readonly mode: FrameLoopMode;
  readonly frameIndex: number;
  readonly timeMs: number;
  readonly deltaMs: number;
  readonly invalidationReasons: readonly string[];
  readonly invalidate: (reason: string) => boolean;
}

export interface FrameLoopStage<TContext> {
  readonly id: string;
  readonly priority?: number;
  readonly execute: (frame: FrameLoopStageContext<TContext>) => void | Promise<void>;
}

export interface FrameLoopStageTrace {
  readonly id: string;
  readonly priority: number;
  readonly order: number;
  readonly status: "completed" | "failed";
  readonly error?: string;
}

export type FrameLoopAdvanceStatus = "rendered" | "idle" | "reentrant" | "failed";

export interface FrameLoopAdvanceResult {
  readonly status: FrameLoopAdvanceStatus;
  readonly frameIndex: number | null;
  readonly timeMs: number;
  readonly deltaMs: number;
  readonly invalidationReasons: readonly string[];
  readonly trace: readonly FrameLoopStageTrace[];
}

export interface FrameLoopDiagnostics {
  readonly mode: FrameLoopMode;
  readonly running: boolean;
  /** True only when the host should request a frame. Manual mode is caller-driven. */
  readonly frameRequested: boolean;
  readonly pendingInvalidationReasons: readonly string[];
  readonly attemptedFrames: number;
  readonly renderedFrames: number;
  readonly lastFrame: FrameLoopAdvanceResult | null;
}

interface CompiledFrameLoopStage<TContext> {
  readonly id: string;
  readonly priority: number;
  readonly registrationOrder: number;
  readonly execute: FrameLoopStage<TContext>["execute"];
}

const MAX_INVALIDATION_REASONS = 64;
const MAX_INVALIDATION_REASON_CODE_UNITS = 128;
const ADDITIONAL_INVALIDATIONS = "frame-loop:additional-invalidations";
const EMPTY_REASONS: readonly string[] = Object.freeze([]);
const EMPTY_TRACE: readonly FrameLoopStageTrace[] = Object.freeze([]);

/**
 * Framework-independent frame admission and stage ordering.
 *
 * The host owns its RAF, native message pump, or test clock and injects a
 * timestamp through `advance`. This class deliberately does not own scene or
 * renderer state.
 */
export class FrameLoop<TContext> {
  private modeValue: FrameLoopMode;
  private readonly stages: readonly CompiledFrameLoopStage<TContext>[];
  private pendingReasons = new Set<string>();
  private running = false;
  private attemptedFrames = 0;
  private renderedFrames = 0;
  private lastTimeMs: number | null = null;
  private lastFrame: FrameLoopAdvanceResult | null = null;

  constructor(mode: FrameLoopMode, stages: readonly FrameLoopStage<TContext>[]) {
    assertMode(mode);
    this.modeValue = mode;
    this.stages = compileStages(stages);
  }

  get mode(): FrameLoopMode {
    return this.modeValue;
  }

  setMode(mode: FrameLoopMode): void {
    assertMode(mode);
    this.modeValue = mode;
  }

  /**
   * Coalesces equal reasons. The return value is true only for the clean to
   * dirty transition, so demand-mode hosts can schedule at most one frame.
   */
  invalidate(reason: string): boolean {
    const normalized = normalizeReason(reason);
    const wasDirty = this.pendingReasons.size > 0;
    if (this.pendingReasons.size < MAX_INVALIDATION_REASONS - 1) {
      this.pendingReasons.add(normalized);
    } else if (!this.pendingReasons.has(normalized)) {
      this.pendingReasons.add(ADDITIONAL_INVALIDATIONS);
    }
    return !wasDirty;
  }

  shouldRequestFrame(): boolean {
    return this.modeValue === "always"
      || (this.modeValue === "demand" && this.pendingReasons.size > 0);
  }

  diagnostics(): FrameLoopDiagnostics {
    return Object.freeze({
      mode: this.modeValue,
      running: this.running,
      frameRequested: this.shouldRequestFrame(),
      pendingInvalidationReasons: freezeReasons(this.pendingReasons),
      attemptedFrames: this.attemptedFrames,
      renderedFrames: this.renderedFrames,
      lastFrame: this.lastFrame,
    });
  }

  async advance(timeMs: number, context: TContext): Promise<FrameLoopAdvanceResult> {
    assertTimestamp(timeMs, this.lastTimeMs);
    if (this.running) return this.createPassiveResult("reentrant", timeMs);
    if (this.modeValue === "demand" && this.pendingReasons.size === 0) {
      return this.createPassiveResult("idle", timeMs);
    }

    this.running = true;
    const invalidationReasons = freezeReasons(this.pendingReasons);
    // Swap instead of clearing: invalidations raised by a stage belong to the next frame.
    this.pendingReasons = new Set<string>();
    const frameIndex = this.attemptedFrames++;
    const deltaMs = this.lastTimeMs === null ? 0 : timeMs - this.lastTimeMs;
    const trace: FrameLoopStageTrace[] = [];
    const frame = Object.freeze({
      context,
      mode: this.modeValue,
      frameIndex,
      timeMs,
      deltaMs,
      invalidationReasons,
      invalidate: (reason: string) => this.invalidate(reason),
    });

    let status: FrameLoopAdvanceStatus = "rendered";
    try {
      for (const [order, stage] of this.stages.entries()) {
        try {
          await stage.execute(frame);
          trace.push(Object.freeze({
            id: stage.id,
            priority: stage.priority,
            order,
            status: "completed",
          }));
        } catch (error: unknown) {
          status = "failed";
          trace.push(Object.freeze({
            id: stage.id,
            priority: stage.priority,
            order,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          }));
          break;
        }
      }
    } finally {
      this.running = false;
      this.lastTimeMs = timeMs;
    }

    if (status === "rendered") this.renderedFrames += 1;
    const result = Object.freeze({
      status,
      frameIndex,
      timeMs,
      deltaMs,
      invalidationReasons,
      trace: Object.freeze(trace),
    });
    this.lastFrame = result;
    return result;
  }

  private createPassiveResult(
    status: Extract<FrameLoopAdvanceStatus, "idle" | "reentrant">,
    timeMs: number,
  ): FrameLoopAdvanceResult {
    return Object.freeze({
      status,
      frameIndex: null,
      timeMs,
      deltaMs: 0,
      invalidationReasons: EMPTY_REASONS,
      trace: EMPTY_TRACE,
    });
  }
}

function compileStages<TContext>(
  stages: readonly FrameLoopStage<TContext>[],
): readonly CompiledFrameLoopStage<TContext>[] {
  const seen = new Set<string>();
  const compiled = stages.map((stage, registrationOrder) => {
    if (!stage || typeof stage.id !== "string" || stage.id.trim().length === 0) {
      throw new TypeError("Frame loop stage id must be a non-empty string.");
    }
    if (seen.has(stage.id)) throw new TypeError(`Duplicate frame loop stage: ${stage.id}.`);
    seen.add(stage.id);
    const priority = stage.priority ?? 0;
    if (!Number.isFinite(priority)) {
      throw new TypeError(`Frame loop stage ${stage.id} priority must be finite.`);
    }
    if (typeof stage.execute !== "function") {
      throw new TypeError(`Frame loop stage ${stage.id} must define execute.`);
    }
    return Object.freeze({ id: stage.id, priority, registrationOrder, execute: stage.execute });
  });
  compiled.sort((left, right) => left.priority - right.priority
    || left.registrationOrder - right.registrationOrder);
  return Object.freeze(compiled);
}

function assertMode(mode: FrameLoopMode): void {
  if (mode !== "always" && mode !== "demand" && mode !== "manual") {
    throw new TypeError(`Unsupported frame loop mode: ${String(mode)}.`);
  }
}

function assertTimestamp(timeMs: number, lastTimeMs: number | null): void {
  if (!Number.isFinite(timeMs)) throw new TypeError("Frame time must be finite.");
  if (lastTimeMs !== null && timeMs < lastTimeMs) {
    throw new RangeError(`Frame time ${timeMs} precedes the last frame time ${lastTimeMs}.`);
  }
}

function normalizeReason(reason: string): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new TypeError("Frame invalidation reason must be a non-empty string.");
  }
  const normalized = reason.trim();
  if (normalized.length > MAX_INVALIDATION_REASON_CODE_UNITS) {
    throw new RangeError(`Frame invalidation reason exceeds ${MAX_INVALIDATION_REASON_CODE_UNITS} UTF-16 code units.`);
  }
  return normalized;
}

function freezeReasons(reasons: ReadonlySet<string>): readonly string[] {
  return reasons.size === 0 ? EMPTY_REASONS : Object.freeze([...reasons]);
}
