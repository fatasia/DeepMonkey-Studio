import type { AnimationWrapMode } from "../animation/types.js";
import type { SpatialItemId } from "../spatial/types.js";
import type { GltfRenderAnimationSelection, ResolvedGltfRenderAnimationSources } from "./renderAnimationBridgeTypes.js";
import { GltfRenderAnimationBridgeError } from "./renderAnimationBridgeTypes.js";
import {
  normalizeWrapTime, resolvedSelection, selectedClipDuration, TIME_EPSILON,
  validateFrameDelta, wrapTerminalBound,
} from "./renderAnimationBridgeValidation.js";
import {
  collectClipEvents, DEFAULT_MAX_EVENTS_PER_UPDATE, emptyEventBatch,
  type GltfAnimationClipEventMarker, type GltfAnimationEventBatch, type GltfAnimationEventOptions,
} from "./renderAnimationEvents.js";

/**
 * Unwrapped-time advance computed purely from the mirrored playback state. `from`/`to`
 * are absolute unwrapped seconds; only `step > 0` advances emit boundary events.
 */
export interface ClockAdvancePlan {
  readonly from: number;
  readonly to: number;
  readonly step: number;
  readonly loop: number;
  readonly activeClipId: string | null;
}

/**
 * Mirrors `GltfRenderAnimationBridge` playhead state on the unwrapped timeline so the
 * runtime can detect event boundaries and root motion advances. Every state transition
 * reuses the bridge's own validation helpers, so mirror time cannot diverge from bridge
 * time for the same call sequence.
 */
export class AnimationPlaybackClock<TNodeId extends SpatialItemId = number> {
  private readonly source: ResolvedGltfRenderAnimationSources<TNodeId>;
  private readonly markers: readonly GltfAnimationClipEventMarker[];
  private readonly eventLimit: number;
  private duration = 0;
  private wrapMode: AnimationWrapMode = "loop";
  private playbackMode: "loop" | "once" = "loop";
  private timeScale = 1;
  private paused = false;
  private unwrapped = 0;
  private activeClipId: string | null = null;

  constructor(resolved: ResolvedGltfRenderAnimationSources<TNodeId>, selection: GltfRenderAnimationSelection | undefined,
    events: GltfAnimationEventOptions | undefined) {
    this.source = resolved;
    this.markers = validateEventMarkers(resolved, events);
    this.eventLimit = resolveEventLimit(events);
    this.play(resolvedSelection(resolved, selection));
  }

  /** Same validation surface as the bridge uses, so failures happen before any state change. */
  resolve(selection: GltfRenderAnimationSelection | undefined) {
    return resolvedSelection(this.source, selection);
  }

  play(resolved: ReturnType<AnimationPlaybackClock<TNodeId>["resolve"]>): void {
    const transform = findClip(this.source.transformClips, resolved.transformClipId);
    const morph = findClip(this.source.morphClips, resolved.morphClipId);
    this.duration = selectedClipDuration(transform, morph);
    this.wrapMode = resolved.wrapMode;
    this.playbackMode = resolved.playbackMode;
    this.timeScale = resolved.timeScale;
    this.paused = resolved.paused;
    this.activeClipId = resolved.transformClipId ?? resolved.morphClipId;
    this.unwrapped = normalizeWrapTime(resolved.time, this.duration, this.wrapMode);
  }

  /** Keeps the current revolution count and re-derives the unwrapped base from the target. */
  seek(time: number): void {
    const wrapped = normalizeWrapTime(time, this.duration, this.wrapMode);
    const base = this.duration > 0 ? Math.floor((this.unwrapped + TIME_EPSILON) / this.duration) * this.duration : 0;
    this.unwrapped = base + wrapped;
  }

  setTimeScale(value: number): void { this.timeScale = value; }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }

  get unwrappedTime(): number { return this.unwrapped; }
  get loop(): number { return this.duration > 0 ? Math.floor((this.unwrapped + TIME_EPSILON) / this.duration) : 0; }
  get activeClipIdValue(): string | null { return this.activeClipId; }

  /** Pure: computes the advance the bridge is about to perform without touching the mirror. */
  planAdvance(deltaSeconds: number): ClockAdvancePlan | null {
    validateFrameDelta(deltaSeconds);
    if (this.paused) return null;
    const step = deltaSeconds * this.timeScale;
    if (step === 0) return null;
    const from = this.unwrapped;
    let to = from + step;
    if (this.playbackMode === "once" && this.duration > 0) {
      to = step > 0 ? Math.min(to, wrapTerminalBound(from, this.duration, 1))
        : Math.max(to, wrapTerminalBound(from, this.duration, -1));
    }
    if (to === from) return null;
    return Object.freeze({ from, to, step,
      loop: this.duration > 0 ? Math.floor((to + TIME_EPSILON) / this.duration) : 0, activeClipId: this.activeClipId });
  }

  /**
   * Commits a planned advance to the mirror and emits the events it crossed. A `null`
   * plan (paused, zero delta, or a recovered pending frame with no deferred advance)
   * settles nothing. Negative steps move the watermark backward without emitting, so
   * replaying forward across rewound time re-arms those markers.
   */
  settle(plan: ClockAdvancePlan | null): GltfAnimationEventBatch {
    if (!plan) return emptyEventBatch();
    this.unwrapped = plan.to;
    if (plan.step <= 0) return emptyEventBatch();
    return collectClipEvents(this.markers, plan.activeClipId, this.duration, plan.from, plan.to, this.eventLimit);
  }
}

/** Builds the clock from sources already resolved (and validated) by the runtime. */
export function createAnimationPlaybackClock<TNodeId extends SpatialItemId>(
  resolved: ResolvedGltfRenderAnimationSources<TNodeId>, selection: GltfRenderAnimationSelection | undefined,
  events: GltfAnimationEventOptions | undefined): AnimationPlaybackClock<TNodeId> {
  return new AnimationPlaybackClock(resolved, selection, events);
}

function findClip<TClip extends { readonly id: string; readonly duration: number }>(clips: readonly TClip[],
  id: string | null): TClip | null {
  return id === null ? null : clips.find((clip) => clip.id === id) ?? null;
}

function resolveEventLimit(events: GltfAnimationEventOptions | undefined): number {
  if (events?.maxEventsPerUpdate === undefined) return DEFAULT_MAX_EVENTS_PER_UPDATE;
  const limit = events.maxEventsPerUpdate;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 65536) {
    throw new GltfRenderAnimationBridgeError("invalid-input", "Animation event cap must be an integer from 1 through 65536.");
  }
  return limit;
}

function validateEventMarkers<TNodeId extends SpatialItemId>(resolved: ResolvedGltfRenderAnimationSources<TNodeId>,
  events: GltfAnimationEventOptions | undefined): readonly GltfAnimationClipEventMarker[] {
  const markers = events?.markers;
  if (markers === undefined) return [];
  if (!Array.isArray(markers)) failInvalid("Animation event markers must be an array.");
  const durations = new Map<string, number>();
  for (const clip of [...resolved.transformClips, ...resolved.morphClips]) {
    if (!durations.has(clip.id)) durations.set(clip.id, clip.duration);
  }
  const seen = new Set<string>();
  for (const marker of markers) {
    if (!marker || typeof marker !== "object" || typeof marker.clipId !== "string" || marker.clipId.length === 0
      || typeof marker.eventId !== "string" || marker.eventId.length === 0) {
      failInvalid("Every animation event marker needs nonempty clipId and eventId strings.");
    }
    const key = `${marker.clipId}\u0000${marker.eventId}`;
    if (seen.has(key)) failInvalid(`Duplicate animation event marker: ${marker.clipId}/${marker.eventId}.`);
    seen.add(key);
    const duration = durations.get(marker.clipId);
    if (duration === undefined) failInvalid(`Animation event marker references an unknown clip: ${marker.clipId}.`);
    if (!(duration! > 0) || !Number.isFinite(marker.time) || marker.time < 0 || marker.time >= duration!) {
      failInvalid(`Animation event marker ${marker.clipId}/${marker.eventId} must satisfy 0 <= time < clip duration.`);
    }
  }
  return Object.freeze(markers);
}

function failInvalid(message: string): never {
  throw new GltfRenderAnimationBridgeError("invalid-input", message);
}
