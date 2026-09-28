import type { SpatialItemId } from "../spatial/types.js";

/**
 * Root motion tracking contract (TS layer). Deltas are recorded per forward advance on
 * the unwrapped-time basis, in world space, from the tracked node's world transform.
 * Recording never mutates instance transforms; editor consumption is a later slice.
 */
export interface GltfRootMotionTrackingOptions<TNodeId extends SpatialItemId> {
  /** Node whose world transform is tracked; must exist in the animation source nodes. */
  readonly rootNodeId: TNodeId;
  /** Retained delta samples available to `accumulatedRootMotion`; defaults to 512. */
  readonly historyCapacity?: number;
}

export const DEFAULT_ROOT_MOTION_HISTORY = 512;

export type Vec3Tuple = readonly [number, number, number];
export type QuatTuple = readonly [number, number, number, number];

/** World-space motion the tracked node applied during one forward advance. */
export interface GltfRootMotionDelta {
  /** Translation delta `current - previous`, world space. */
  readonly translation: Vec3Tuple;
  /** Rotation delta `qPrevious⁻¹ ⊗ qCurrent`, world space, `(x, y, z, w)`. */
  readonly rotation: QuatTuple;
}

export interface GltfRootMotionSample extends GltfRootMotionDelta {
  /** Clip driving the playhead when the advance settled (`null` for pose-only frames). */
  readonly clipId: string | null;
  /** Unwrapped time at the end of the advance that produced this sample. */
  readonly unwrappedTime: number;
  readonly loop: number;
}

export interface GltfRootMotionAccumulation {
  readonly translation: Vec3Tuple;
  /** Conjugated quaternion product over the accumulated samples, `(x, y, z, w)`. */
  readonly rotation: QuatTuple;
  readonly samples: number;
}

interface FrameNodeEntry<TNodeId extends SpatialItemId> {
  readonly nodeId: TNodeId;
  readonly worldTransform: Float32Array<ArrayBuffer>;
}

interface RootMotionFrame<TNodeId extends SpatialItemId> {
  readonly nodeWorldTransforms: readonly FrameNodeEntry<TNodeId>[];
}

interface RootBaseline { readonly translation: Vec3Tuple; readonly rotation: QuatTuple }

/** Ring buffer of per-advance deltas plus the pose baseline used to derive them. */
export class GltfRootMotionTracker<TNodeId extends SpatialItemId> {
  private readonly rootNodeId: GltfRootMotionTrackingOptions<TNodeId>["rootNodeId"];
  private readonly capacity: number;
  private readonly samples: GltfRootMotionSample[] = [];
  private baseline: RootBaseline | null = null;

  constructor(options: GltfRootMotionTrackingOptions<TNodeId>) {
    this.rootNodeId = options.rootNodeId;
    const requested = options.historyCapacity ?? DEFAULT_ROOT_MOTION_HISTORY;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > 65536) {
      throw new RangeError("Root motion history capacity must be an integer from 1 through 65536.");
    }
    this.capacity = requested;
  }

  get sampleCount(): number { return this.samples.length; }

  /** Re-arms the baseline from the given frame without recording a jump (seek/play semantics). */
  resetBaseline(frame: RootMotionFrame<TNodeId>): void {
    const entry = findNode(frame, this.rootNodeId);
    this.baseline = entry ? { translation: columnMajorTranslation(entry.worldTransform),
      rotation: columnMajorQuaternion(entry.worldTransform) } : null;
  }

  recordAdvance(frame: RootMotionFrame<TNodeId>, clipId: string | null, unwrappedTime: number,
    loop: number): GltfRootMotionSample | null {
    const before = this.baseline;
    const entry = findNode(frame, this.rootNodeId);
    if (!before || !entry) return null;
    const translation = columnMajorTranslation(entry.worldTransform);
    const rotation = columnMajorQuaternion(entry.worldTransform);
    const sample: GltfRootMotionSample = Object.freeze({
      clipId, unwrappedTime, loop,
      translation: Object.freeze<Vec3Tuple>([
        translation[0] - before.translation[0], translation[1] - before.translation[1],
        translation[2] - before.translation[2]]),
      rotation: Object.freeze(quaternionDelta(before.rotation, rotation)),
    });
    this.baseline = { translation, rotation };
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.shift();
    return sample;
  }

  /** Sums samples with `unwrappedTime > sinceUnwrappedTime`; null when nothing accumulates. */
  accumulate(sinceUnwrappedTime = -Infinity): GltfRootMotionAccumulation | null {
    let x = 0, y = 0, z = 0, count = 0;
    let rotation: QuatTuple = [0, 0, 0, 1];
    for (const sample of this.samples) {
      if (!(sample.unwrappedTime > sinceUnwrappedTime)) continue;
      x += sample.translation[0]; y += sample.translation[1]; z += sample.translation[2];
      rotation = quaternionMultiply(rotation, sample.rotation);
      count += 1;
    }
    if (count === 0) return null;
    return Object.freeze({ translation: Object.freeze<Vec3Tuple>([x, y, z]), rotation: normalizeQuaternion(rotation), samples: count });
  }
}

function findNode<TNodeId extends SpatialItemId>(frame: RootMotionFrame<TNodeId>, nodeId: TNodeId) {
  return frame.nodeWorldTransforms.find((entry) => Object.is(entry.nodeId, nodeId)) ?? null;
}

/** Translation from a column-major 4x4 matrix. */
export function columnMajorTranslation(matrix: ArrayLike<number>): Vec3Tuple {
  assertFiniteMatrix(matrix);
  return Object.freeze([matrix[12]!, matrix[13]!, matrix[14]!]);
}

/**
 * Rotation from a column-major 4x4 matrix via Shepperd's method. Rotation columns are
 * normalized first so per-bone scale cannot leak into the quaternion.
 */
export function columnMajorQuaternion(matrix: ArrayLike<number>): QuatTuple {
  assertFiniteMatrix(matrix);
  const c0 = normalizeAxis(matrix[0]!, matrix[1]!, matrix[2]!);
  const c1 = normalizeAxis(matrix[4]!, matrix[5]!, matrix[6]!);
  const c2 = normalizeAxis(matrix[8]!, matrix[9]!, matrix[10]!);
  const trace = c0[0] + c1[1] + c2[2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return Object.freeze([(c1[2] - c2[1]) / s, (c2[0] - c0[2]) / s, (c0[1] - c1[0]) / s, 0.25 * s]);
  }
  if (c0[0] > c1[1] && c0[0] > c2[2]) {
    const s = Math.sqrt(1 + c0[0] - c1[1] - c2[2]) * 2;
    return Object.freeze([0.25 * s, (c1[0] + c0[1]) / s, (c2[0] + c0[2]) / s, (c1[2] - c2[1]) / s]);
  }
  if (c1[1] > c2[2]) {
    const s = Math.sqrt(1 + c1[1] - c0[0] - c2[2]) * 2;
    return Object.freeze([(c1[0] + c0[1]) / s, 0.25 * s, (c2[1] + c1[2]) / s, (c2[0] - c0[2]) / s]);
  }
  const s = Math.sqrt(1 + c2[2] - c0[0] - c1[1]) * 2;
  return Object.freeze([(c2[0] + c0[2]) / s, (c2[1] + c1[2]) / s, 0.25 * s, (c0[1] - c1[0]) / s]);
}

/** Unit quaternion product `a ⊗ b`, `(x, y, z, w)` order. */
export function quaternionMultiply(a: QuatTuple, b: QuatTuple): QuatTuple {
  return normalizeQuaternion([
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]);
}

/** Rotation from `previous` to `current`: `previous⁻¹ ⊗ current`. */
export function quaternionDelta(previous: QuatTuple, current: QuatTuple): QuatTuple {
  return quaternionMultiply([-previous[0], -previous[1], -previous[2], previous[3]], current);
}

export function normalizeQuaternion(quaternion: readonly number[]): QuatTuple {
  const length = Math.hypot(quaternion[0]!, quaternion[1]!, quaternion[2]!, quaternion[3]!);
  if (!(length > 0)) return Object.freeze([0, 0, 0, 1]);
  return Object.freeze([quaternion[0]! / length, quaternion[1]! / length, quaternion[2]! / length, quaternion[3]! / length]);
}

function normalizeAxis(x: number, y: number, z: number): readonly [number, number, number] {
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) throw new RangeError("Root motion matrix has a degenerate rotation axis.");
  return [x / length, y / length, z / length];
}

function assertFiniteMatrix(matrix: ArrayLike<number>): void {
  if (matrix.length < 16) throw new RangeError("Root motion matrix must be a column-major 4x4.");
  for (let index = 0; index < 16; index += 1) {
    if (!Number.isFinite(matrix[index])) throw new RangeError("Root motion matrix contains non-finite values.");
  }
}
