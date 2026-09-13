import { validateSpatialId } from "../spatial/octreeInternals.js";
import type { SpatialItemId } from "../spatial/types.js";
import {
  AnimationError,
  type AnimationClipInput,
  type AnimationLayerInput,
  type AnimationLayerState,
  type SceneAnimationMixerConfiguration,
  type SceneAnimationMixerOptions,
  type ValidatedAnimationClip,
  type ValidatedAnimationTrack,
} from "./types.js";

const MAX_VALUE = 1e15;
export const DEEP_ANIMATION_LIMITS = Object.freeze({
  defaultMaxClips: 1_024, hardMaxClips: 16_384,
  defaultMaxTracksPerClip: 100_000, hardMaxTracksPerClip: 500_000,
  defaultMaxKeysPerTrack: 1_000_000, hardMaxKeysPerTrack: 4_000_000,
  defaultMaxLayers: 256, hardMaxLayers: 4_096,
  defaultMaxAnimatedNodes: 250_000, hardMaxAnimatedNodes: 1_000_000,
});

export function validateMixerOptions(options: SceneAnimationMixerOptions): SceneAnimationMixerConfiguration {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new AnimationError("invalid-layer", "Animation mixer options must be an object.");
  return Object.freeze({
    maxClips: limit(options.maxClips, DEEP_ANIMATION_LIMITS.defaultMaxClips, DEEP_ANIMATION_LIMITS.hardMaxClips, "maxClips"),
    maxTracksPerClip: limit(options.maxTracksPerClip, DEEP_ANIMATION_LIMITS.defaultMaxTracksPerClip, DEEP_ANIMATION_LIMITS.hardMaxTracksPerClip, "maxTracksPerClip"),
    maxKeysPerTrack: limit(options.maxKeysPerTrack, DEEP_ANIMATION_LIMITS.defaultMaxKeysPerTrack, DEEP_ANIMATION_LIMITS.hardMaxKeysPerTrack, "maxKeysPerTrack"),
    maxLayers: limit(options.maxLayers, DEEP_ANIMATION_LIMITS.defaultMaxLayers, DEEP_ANIMATION_LIMITS.hardMaxLayers, "maxLayers"),
    maxAnimatedNodes: limit(options.maxAnimatedNodes, DEEP_ANIMATION_LIMITS.defaultMaxAnimatedNodes, DEEP_ANIMATION_LIMITS.hardMaxAnimatedNodes, "maxAnimatedNodes"),
  });
}

export function validateClip<TId extends SpatialItemId>(input: AnimationClipInput<TId>, limits: SceneAnimationMixerConfiguration): ValidatedAnimationClip<TId> {
  if (!input || typeof input !== "object" || typeof input.id !== "string" || input.id.length === 0
    || !Number.isFinite(input.duration) || input.duration < 0 || input.duration > MAX_VALUE || !Array.isArray(input.tracks)) {
    throw new AnimationError("invalid-clip", "Animation clip id, duration, or tracks are invalid.");
  }
  if (input.tracks.length > limits.maxTracksPerClip) throw new AnimationError("capacity-exceeded", "Animation clip track capacity was exceeded.");
  const seen = new Set<string>();
  const tracks: ValidatedAnimationTrack<TId>[] = input.tracks.map((track) => validateTrack<TId>(track, input.duration, limits.maxKeysPerTrack));
  tracks.sort(compareTracks);
  for (const track of tracks) {
    const key = `${typeof track.nodeId}:${String(track.nodeId)}:${track.path}`;
    if (seen.has(key)) throw new AnimationError("duplicate-track", `Animation clip has a duplicate ${track.path} track for ${String(track.nodeId)}.`);
    seen.add(key);
  }
  return Object.freeze({ id: input.id, duration: input.duration, tracks: Object.freeze(tracks) });
}

export function validateLayer<TId extends SpatialItemId>(
  input: AnimationLayerInput<TId>,
  clips: ReadonlyMap<string, ValidatedAnimationClip<TId>>,
  limits: SceneAnimationMixerConfiguration,
  ordinal: number,
  weightOverride?: number,
): AnimationLayerState<TId> {
  if (!input || typeof input !== "object") throw new AnimationError("invalid-layer", "Animation layer must be an object.");
  try { validateSpatialId(input.id); } catch { throw new AnimationError("invalid-layer", "Animation layer id is invalid."); }
  if (typeof input.clipId !== "string" || !clips.has(input.clipId)) throw new AnimationError("missing-clip", `Animation clip does not exist: ${String(input.clipId)}.`);
  const time = finite(input.time ?? 0, "time", MAX_VALUE);
  const timeScale = finite(input.timeScale ?? 1, "timeScale", 1_000_000);
  const weight = finite(weightOverride ?? input.weight ?? 1, "weight", 1);
  if (weight < 0) throw new AnimationError("invalid-layer", "Animation layer weight must be between zero and one.");
  const wrapMode = input.wrapMode ?? "loop";
  const blendMode = input.blendMode ?? "override";
  if (wrapMode !== "loop" && wrapMode !== "clamp") throw new AnimationError("invalid-layer", "Animation wrap mode is invalid.");
  if (blendMode !== "override" && blendMode !== "additive") throw new AnimationError("invalid-layer", "Animation blend mode is invalid.");
  const nodeMask = validateMask(input.nodeMask, limits.maxAnimatedNodes);
  return Object.freeze({ id: input.id, clipId: input.clipId, ordinal, time, timeScale, weight,
    wrapMode, blendMode, nodeMask, fade: null });
}

export function validateFrameDelta(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) throw new AnimationError("invalid-time", "Animation frame delta must be a supported non-negative finite number.");
  return value;
}

export function validateFade(targetWeight: number, duration: number): void {
  if (!Number.isFinite(targetWeight) || targetWeight < 0 || targetWeight > 1
    || !Number.isFinite(duration) || duration < 0 || duration > 1_000_000) {
    throw new AnimationError("invalid-layer", "Animation fade weight or duration is invalid.");
  }
}

function validateTrack<TId extends SpatialItemId>(input: AnimationClipInput<TId>["tracks"][number], duration: number, maxKeys: number): ValidatedAnimationTrack<TId> {
  if (!input || typeof input !== "object") throw new AnimationError("invalid-track", "Animation track must be an object.");
  try { validateSpatialId(input.nodeId); } catch { throw new AnimationError("invalid-track", "Animation track node id is invalid."); }
  if (input.path !== "translation" && input.path !== "rotation" && input.path !== "scale") throw new AnimationError("invalid-track", "Animation target path is invalid.");
  if (input.interpolation !== "STEP" && input.interpolation !== "LINEAR" && input.interpolation !== "CUBICSPLINE") throw new AnimationError("invalid-track", "Animation interpolation is invalid.");
  if (!isSampleArray(input.times) || input.times.length < 1 || input.times.length > maxKeys) throw new AnimationError("invalid-track", "Animation track key count is invalid.");
  const sourceTimes = Array.from(input.times);
  const times = sourceTimes.map((time, index) => {
    if (!Number.isFinite(time) || time < 0 || time > duration || (index > 0 && time <= sourceTimes[index - 1]!)) {
      throw new AnimationError("invalid-track", "Animation key times must be finite, ordered, unique, and within clip duration.");
    }
    return time;
  });
  const components = input.path === "rotation" ? 4 : 3;
  const stride = components * (input.interpolation === "CUBICSPLINE" ? 3 : 1);
  if (!isSampleArray(input.values) || input.values.length !== times.length * stride) {
    throw new AnimationError("invalid-track", "Animation values have an invalid size or non-finite component.");
  }
  const values = Array.from(input.values);
  if (values.some((value) => !Number.isFinite(value) || Math.abs(value) > MAX_VALUE)) {
    throw new AnimationError("invalid-track", "Animation values have an invalid size or non-finite component.");
  }
  if (input.path === "rotation") normalizeQuaternionKeys(values, times.length, input.interpolation === "CUBICSPLINE");
  const referenceOffset = input.interpolation === "CUBICSPLINE" ? components : 0;
  const reference = Object.freeze(values.slice(referenceOffset, referenceOffset + components));
  return Object.freeze({ nodeId: input.nodeId, path: input.path, interpolation: input.interpolation,
    times: Object.freeze(times), values: Object.freeze(values), components, reference });
}

function normalizeQuaternionKeys(values: number[], keys: number, cubic: boolean): void {
  const stride = cubic ? 12 : 4;
  let previous: number[] | null = null;
  for (let key = 0; key < keys; key += 1) {
    const valueOffset = key * stride + (cubic ? 4 : 0);
    const length = Math.hypot(values[valueOffset]!, values[valueOffset + 1]!, values[valueOffset + 2]!, values[valueOffset + 3]!);
    if (length <= Number.EPSILON) throw new AnimationError("invalid-track", "Animation rotation keys must be non-zero quaternions.");
    for (let component = 0; component < 4; component += 1) values[valueOffset + component] = values[valueOffset + component]! / length;
    const current = values.slice(valueOffset, valueOffset + 4);
    if (previous && dot4(previous, current) < 0) {
      const start = key * stride;
      const count = cubic ? 12 : 4;
      for (let component = 0; component < count; component += 1) values[start + component] = -values[start + component]!;
      for (let component = 0; component < 4; component += 1) current[component] = -current[component]!;
    }
    previous = current;
  }
}

function validateMask<TId extends SpatialItemId>(value: readonly TId[] | undefined, maximum: number): ReadonlySet<TId> | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > maximum) throw new AnimationError("capacity-exceeded", "Animation node mask capacity was exceeded.");
  const mask = new Set<TId>();
  for (const id of value) {
    try { validateSpatialId(id); } catch { throw new AnimationError("invalid-layer", "Animation node mask contains an invalid id."); }
    if (mask.has(id)) throw new AnimationError("invalid-layer", "Animation node mask contains a duplicate id.");
    mask.add(id);
  }
  return mask;
}

function compareTracks<TId extends SpatialItemId>(left: ValidatedAnimationTrack<TId>, right: ValidatedAnimationTrack<TId>): number {
  return compareIds(left.nodeId, right.nodeId) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}
export function compareIds(left: SpatialItemId, right: SpatialItemId): number {
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "number") return -1;
  if (typeof right === "number") return 1;
  return left < right ? -1 : left > right ? 1 : 0;
}
function dot4(left: readonly number[], right: readonly number[]): number { return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]! + left[3]! * right[3]!; }
function finite(value: number, label: string, maximum: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > maximum) throw new AnimationError("invalid-layer", `Animation layer ${label} is invalid.`);
  return value;
}
function limit(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new AnimationError("capacity-exceeded", `Animation ${label} is outside the supported range.`);
  return result;
}
function isSampleArray(value: unknown): value is readonly number[] | Float32Array<ArrayBuffer> {
  return Array.isArray(value) || value instanceof Float32Array;
}
