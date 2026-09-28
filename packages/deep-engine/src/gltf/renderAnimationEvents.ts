import { TIME_EPSILON } from "./renderAnimationBridgeValidation.js";

/**
 * Marker pre-registered on an animation clip. Marker times use the unwrapped clip-time
 * basis: occurrences are `time + k * duration` for integer `k >= 0` under `loop` wrap.
 */
export interface GltfAnimationClipEventMarker {
  readonly clipId: string;
  readonly eventId: string;
  /** Registration time in seconds; must satisfy `0 <= time` and `time < clip duration`. */
  readonly time: number;
}

/** Boundary event emitted when an advance crosses a marker on the unwrapped timeline. */
export interface GltfAnimationEvent {
  readonly clipId: string;
  readonly eventId: string;
  /** Absolute unwrapped crossing time: `marker.time + loop * duration`. */
  readonly unwrappedTime: number;
  /** Zero-based loop revolution the crossed occurrence belongs to. */
  readonly loop: number;
}

export interface GltfAnimationEventBatch {
  readonly events: readonly GltfAnimationEvent[];
  /** True when this update crossed more markers than the per-update emission cap. */
  readonly truncated: boolean;
}

export interface GltfAnimationEventOptions {
  readonly markers?: readonly GltfAnimationClipEventMarker[];
  /**
   * Emission cap per update, defaulting to 1024. Excess events are dropped (never
   * deferred): a later update must not replay events from an earlier update's range.
   */
  readonly maxEventsPerUpdate?: number;
}

export const DEFAULT_MAX_EVENTS_PER_UPDATE = 1024;

const EMPTY_BATCH: GltfAnimationEventBatch = Object.freeze({ events: Object.freeze([]), truncated: false });

/** Shared frozen empty batch; every no-crossing settlement returns this instance. */
export function emptyEventBatch(): GltfAnimationEventBatch {
  return EMPTY_BATCH;
}

/**
 * Deterministically collects active-clip markers whose unwrapped occurrence falls in
 * `(from, to]`, ordered by unwrapped time then registration order. Only forward advances
 * (`to > from`) emit; the same input range always produces the same event sequence.
 * A marker whose occurrence lands exactly on `to` is emitted here and never re-emitted
 * by the next advance, whose range starts strictly after `to`.
 */
export function collectClipEvents(markers: readonly GltfAnimationClipEventMarker[], activeClipId: string | null,
  duration: number, from: number, to: number, limit: number): GltfAnimationEventBatch {
  if (!(to > from) || !(duration > 0) || activeClipId === null || markers.length === 0) return EMPTY_BATCH;
  const collected: (GltfAnimationEvent & { readonly order: number })[] = [];
  let truncated = false;
  for (let index = 0; index < markers.length && !truncated; index += 1) {
    const marker = markers[index]!;
    if (marker.clipId !== activeClipId) continue;
    let occurrence = marker.time + Math.ceil((from - marker.time) / duration) * duration;
    while (occurrence <= from) occurrence += duration;
    for (; occurrence <= to + TIME_EPSILON; occurrence += duration) {
      if (collected.length >= limit) { truncated = true; break; }
      const loop = Math.round((occurrence - marker.time) / duration);
      collected.push(Object.freeze({ clipId: marker.clipId, eventId: marker.eventId, unwrappedTime: occurrence, loop, order: index }));
    }
  }
  if (collected.length === 0) return EMPTY_BATCH;
  collected.sort((left, right) => (left.unwrappedTime - right.unwrappedTime) || (left.order - right.order));
  const events = collected.map(({ order, ...event }) => event);
  return Object.freeze({ events: Object.freeze(events), truncated });
}
