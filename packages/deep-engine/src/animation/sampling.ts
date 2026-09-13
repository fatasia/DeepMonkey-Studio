import type { AnimationWrapMode, ValidatedAnimationClip, ValidatedAnimationTrack } from "./types.js";
import type { SpatialItemId } from "../spatial/types.js";

export function wrappedAnimationTime(time: number, duration: number, mode: AnimationWrapMode): number {
  if (duration === 0) return 0;
  if (mode === "clamp") return Math.min(duration, Math.max(0, time));
  const wrapped = time % duration;
  return wrapped < 0 ? wrapped + duration : wrapped;
}

export function sampleAnimationTrack<TId extends SpatialItemId>(
  track: ValidatedAnimationTrack<TId>,
  time: number,
  output: Float64Array,
): void {
  const count = track.times.length;
  if (count === 1 || time <= track.times[0]!) return copyKey(track, 0, output);
  if (time >= track.times[count - 1]!) return copyKey(track, count - 1, output);
  let low = 0, high = count - 1;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (track.times[middle]! <= time) low = middle;
    else high = middle;
  }
  if (track.interpolation === "STEP") return copyKey(track, low, output);
  const start = track.times[low]!, end = track.times[high]!;
  const alpha = (time - start) / (end - start);
  if (track.interpolation === "CUBICSPLINE") cubic(track, low, high, alpha, end - start, output);
  else if (track.path === "rotation") slerpKeys(track, low, high, alpha, output);
  else linear(track, low, high, alpha, output);
}

function copyKey<TId extends SpatialItemId>(track: ValidatedAnimationTrack<TId>, key: number, output: Float64Array): void {
  const offset = keyOffset(track, key);
  for (let component = 0; component < track.components; component += 1) output[component] = track.values[offset + component]!;
}

function linear<TId extends SpatialItemId>(track: ValidatedAnimationTrack<TId>, low: number, high: number, alpha: number, output: Float64Array): void {
  const a = keyOffset(track, low), b = keyOffset(track, high);
  for (let component = 0; component < track.components; component += 1) {
    output[component] = track.values[a + component]! * (1 - alpha) + track.values[b + component]! * alpha;
  }
}

function cubic<TId extends SpatialItemId>(track: ValidatedAnimationTrack<TId>, low: number, high: number, t: number, delta: number, output: Float64Array): void {
  const stride = track.components * 3;
  const p0 = low * stride + track.components;
  const m0 = low * stride + track.components * 2;
  const p1 = high * stride + track.components;
  const m1 = high * stride;
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  for (let component = 0; component < track.components; component += 1) {
    output[component] = h00 * track.values[p0 + component]!
      + h10 * delta * track.values[m0 + component]!
      + h01 * track.values[p1 + component]!
      + h11 * delta * track.values[m1 + component]!;
  }
  if (track.path === "rotation") normalizeQuaternion(output);
}

function slerpKeys<TId extends SpatialItemId>(track: ValidatedAnimationTrack<TId>, low: number, high: number, alpha: number, output: Float64Array): void {
  const a = keyOffset(track, low), b = keyOffset(track, high);
  let dot = 0;
  for (let component = 0; component < 4; component += 1) dot += track.values[a + component]! * track.values[b + component]!;
  const sign = dot < 0 ? -1 : 1;
  dot = Math.min(1, Math.max(-1, dot * sign));
  if (dot > 0.9995) {
    for (let component = 0; component < 4; component += 1) output[component] = track.values[a + component]! * (1 - alpha) + track.values[b + component]! * sign * alpha;
  } else {
    const theta = Math.acos(dot);
    const inverseSin = 1 / Math.sin(theta);
    const left = Math.sin((1 - alpha) * theta) * inverseSin;
    const right = Math.sin(alpha * theta) * inverseSin * sign;
    for (let component = 0; component < 4; component += 1) output[component] = track.values[a + component]! * left + track.values[b + component]! * right;
  }
  normalizeQuaternion(output);
}

export function normalizeQuaternion(value: Float64Array): void {
  const length = Math.hypot(value[0]!, value[1]!, value[2]!, value[3]!);
  if (length === 0) { value[0] = 0; value[1] = 0; value[2] = 0; value[3] = 1; return; }
  for (let component = 0; component < 4; component += 1) value[component] = value[component]! / length;
}

export function clipTime<TId extends SpatialItemId>(clip: ValidatedAnimationClip<TId>, rawTime: number, mode: AnimationWrapMode): number {
  return wrappedAnimationTime(rawTime, clip.duration, mode);
}

function keyOffset<TId extends SpatialItemId>(track: ValidatedAnimationTrack<TId>, key: number): number {
  return track.interpolation === "CUBICSPLINE" ? key * track.components * 3 + track.components : key * track.components;
}
