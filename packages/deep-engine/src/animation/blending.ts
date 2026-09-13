import type { SpatialItemId } from "../spatial/types.js";
import type { SceneLocalTrs } from "../scene/types.js";
import { AnimationError, type AnimationBlendMode, type ValidatedAnimationTrack } from "./types.js";
import { compareIds } from "./validation.js";

export class AnimationBlendScratch<TId extends SpatialItemId> {
  private readonly byId = new Map<TId, NodeAccumulator<TId>>();
  private readonly pool: NodeAccumulator<TId>[] = [];
  private readonly active: NodeAccumulator<TId>[] = [];
  private used = 0;

  get pooledCount(): number { return this.pool.length; }

  begin(): void {
    this.byId.clear();
    this.active.length = 0;
    this.used = 0;
  }

  get(id: TId): NodeAccumulator<TId> | undefined { return this.byId.get(id); }

  acquire(id: TId, base: SceneLocalTrs, current: SceneLocalTrs, maximum: number): NodeAccumulator<TId> {
    const existing = this.byId.get(id);
    if (existing) return existing;
    if (this.used >= maximum) throw new AnimationError("capacity-exceeded", "Animated node capacity was exceeded.");
    const accumulator = this.pool[this.used] ?? createAccumulator<TId>();
    if (this.used === this.pool.length) this.pool.push(accumulator);
    this.used += 1;
    resetAccumulator(accumulator, id, base, current);
    this.byId.set(id, accumulator);
    this.active.push(accumulator);
    return accumulator;
  }

  accumulate(accumulator: NodeAccumulator<TId>, track: ValidatedAnimationTrack<TId>, sample: Float64Array, weight: number, mode: AnimationBlendMode): void {
    if (weight === 0) return;
    if (mode === "override") accumulateOverride(accumulator, track, sample, weight);
    else accumulateAdditive(accumulator, track, sample, weight);
  }

  ordered(): readonly NodeAccumulator<TId>[] {
    this.active.sort((left, right) => compareIds(left.id, right.id));
    return this.active;
  }
}

export interface NodeAccumulator<TId extends SpatialItemId> {
  id: TId;
  base: SceneLocalTrs;
  current: SceneLocalTrs;
  readonly translationSum: Float64Array;
  translationWeight: number;
  readonly scaleSum: Float64Array;
  scaleWeight: number;
  readonly rotationSum: Float64Array;
  readonly rotationAnchor: Float64Array;
  rotationWeight: number;
  readonly additiveTranslation: Float64Array;
  readonly additiveScale: Float64Array;
  readonly additiveRotation: Float64Array;
}

export function mixedTransform<TId extends SpatialItemId>(accumulator: NodeAccumulator<TId>): SceneLocalTrs {
  const translation = mixedVector(accumulator.base.translation, accumulator.translationSum, accumulator.translationWeight, accumulator.additiveTranslation);
  const scale = mixedVector(accumulator.base.scale, accumulator.scaleSum, accumulator.scaleWeight, accumulator.additiveScale);
  const rotation = mixedRotation(accumulator);
  return { kind: "trs", translation, rotation, scale };
}

function accumulateOverride<TId extends SpatialItemId>(acc: NodeAccumulator<TId>, track: ValidatedAnimationTrack<TId>, sample: Float64Array, weight: number): void {
  if (track.path === "translation") { weightedAdd(acc.translationSum, sample, 3, weight); acc.translationWeight += weight; return; }
  if (track.path === "scale") { weightedAdd(acc.scaleSum, sample, 3, weight); acc.scaleWeight += weight; return; }
  if (acc.rotationWeight === 0) for (let i = 0; i < 4; i += 1) acc.rotationAnchor[i] = sample[i]!;
  const sign = dot4(acc.rotationAnchor, sample) < 0 ? -1 : 1;
  for (let i = 0; i < 4; i += 1) acc.rotationSum[i] = acc.rotationSum[i]! + sample[i]! * weight * sign;
  acc.rotationWeight += weight;
}

function accumulateAdditive<TId extends SpatialItemId>(acc: NodeAccumulator<TId>, track: ValidatedAnimationTrack<TId>, sample: Float64Array, weight: number): void {
  if (track.path === "translation") {
    for (let i = 0; i < 3; i += 1) acc.additiveTranslation[i] = acc.additiveTranslation[i]! + (sample[i]! - track.reference[i]!) * weight;
    return;
  }
  if (track.path === "scale") {
    for (let i = 0; i < 3; i += 1) acc.additiveScale[i] = acc.additiveScale[i]! + (sample[i]! - track.reference[i]!) * weight;
    return;
  }
  let dx = -track.reference[0]!, dy = -track.reference[1]!, dz = -track.reference[2]!, dw = track.reference[3]!;
  const sx = sample[0]!, sy = sample[1]!, sz = sample[2]!, sw = sample[3]!;
  const qx = dw * sx + dx * sw + dy * sz - dz * sy;
  const qy = dw * sy - dx * sz + dy * sw + dz * sx;
  const qz = dw * sz + dx * sy - dy * sx + dz * sw;
  let qw = dw * sw - dx * sx - dy * sy - dz * sz;
  let sign = 1;
  if (qw < 0) { sign = -1; qw = -qw; }
  const theta = Math.acos(Math.min(1, Math.max(-1, qw)));
  const factor = theta < 1e-8 ? 0 : Math.sin(theta * weight) / Math.sin(theta);
  const wx = qx * sign * factor, wy = qy * sign * factor, wz = qz * sign * factor;
  const ww = theta < 1e-8 ? 1 : Math.cos(theta * weight);
  multiplyQuaternionValues(acc.additiveRotation, wx, wy, wz, ww);
}

function mixedVector(base: readonly number[], sum: Float64Array, weight: number, additive: Float64Array): readonly [number, number, number] {
  const baseWeight = Math.max(0, 1 - weight);
  const divisor = weight > 1 ? weight : 1;
  return Object.freeze([
    (base[0]! * baseWeight + sum[0]!) / divisor + additive[0]!,
    (base[1]! * baseWeight + sum[1]!) / divisor + additive[1]!,
    (base[2]! * baseWeight + sum[2]!) / divisor + additive[2]!,
  ]);
}

function mixedRotation<TId extends SpatialItemId>(acc: NodeAccumulator<TId>): readonly [number, number, number, number] {
  const output = new Float64Array(4);
  if (acc.rotationWeight === 0) output.set(acc.base.rotation);
  else {
    const baseWeight = Math.max(0, 1 - acc.rotationWeight);
    const sign = dot4(acc.rotationAnchor, acc.base.rotation) < 0 ? -1 : 1;
    for (let i = 0; i < 4; i += 1) output[i] = acc.rotationSum[i]! + acc.base.rotation[i]! * baseWeight * sign;
    normalize4(output);
  }
  multiplyQuaternion(output, acc.additiveRotation, output);
  normalize4(output);
  return Object.freeze([output[0]!, output[1]!, output[2]!, output[3]!]);
}

function createAccumulator<TId extends SpatialItemId>(): NodeAccumulator<TId> {
  return { id: "" as TId, base: null as unknown as SceneLocalTrs, current: null as unknown as SceneLocalTrs,
    translationSum: new Float64Array(3), translationWeight: 0,
    scaleSum: new Float64Array(3), scaleWeight: 0,
    rotationSum: new Float64Array(4), rotationAnchor: new Float64Array(4), rotationWeight: 0,
    additiveTranslation: new Float64Array(3), additiveScale: new Float64Array(3),
    additiveRotation: new Float64Array([0, 0, 0, 1]) };
}

function resetAccumulator<TId extends SpatialItemId>(acc: NodeAccumulator<TId>, id: TId, base: SceneLocalTrs, current: SceneLocalTrs): void {
  acc.id = id; acc.base = base; acc.current = current;
  acc.translationSum.fill(0); acc.translationWeight = 0;
  acc.scaleSum.fill(0); acc.scaleWeight = 0;
  acc.rotationSum.fill(0); acc.rotationAnchor.fill(0); acc.rotationWeight = 0;
  acc.additiveTranslation.fill(0); acc.additiveScale.fill(0); acc.additiveRotation.set([0, 0, 0, 1]);
}

function weightedAdd(target: Float64Array, value: Float64Array, count: number, weight: number): void { for (let i = 0; i < count; i += 1) target[i] = target[i]! + value[i]! * weight; }
function dot4(left: ArrayLike<number>, right: ArrayLike<number>): number { return left[0]! * right[0]! + left[1]! * right[1]! + left[2]! * right[2]! + left[3]! * right[3]!; }
function normalize4(value: Float64Array): void { const length = Math.hypot(value[0]!, value[1]!, value[2]!, value[3]!) || 1; for (let i = 0; i < 4; i += 1) value[i] = value[i]! / length; }
function multiplyQuaternion(left: Float64Array, right: Float64Array, out: Float64Array): void {
  const ax = left[0]!, ay = left[1]!, az = left[2]!, aw = left[3]!;
  const bx = right[0]!, by = right[1]!, bz = right[2]!, bw = right[3]!;
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
}
function multiplyQuaternionValues(left: Float64Array, bx: number, by: number, bz: number, bw: number): void {
  const ax = left[0]!, ay = left[1]!, az = left[2]!, aw = left[3]!;
  left[0] = aw * bx + ax * bw + ay * bz - az * by;
  left[1] = aw * by - ax * bz + ay * bw + az * bx;
  left[2] = aw * bz + ax * by - ay * bx + az * bw;
  left[3] = aw * bw - ax * bx - ay * by - az * bz;
}
