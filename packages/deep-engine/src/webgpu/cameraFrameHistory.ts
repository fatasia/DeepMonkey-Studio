import type { Vec3 } from "./cameraMath.js";

export interface CameraFrameState {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly extent: number;
  readonly width: number;
  readonly height: number;
  readonly viewProjection: Float32Array;
  readonly jitter: readonly [number, number];
  readonly forceCut?: boolean;
}

export interface CameraFrameHistoryResult {
  readonly revision: number;
  readonly cameraCut: boolean;
  readonly previousViewProjection: Float32Array;
  readonly currentJitter: readonly [number, number];
  readonly previousJitter: readonly [number, number];
}

interface Snapshot {
  readonly eye: Vec3;
  readonly target: Vec3;
  readonly extent: number;
  readonly width: number;
  readonly height: number;
  readonly viewProjection: Float32Array;
  readonly jitter: readonly [number, number];
}

/** Keeps the exact previous submitted camera state used by motion vectors and TAA. */
export class CameraFrameHistory {
  private snapshot: Snapshot | undefined;
  private active: { readonly result: CameraFrameHistoryResult; readonly snapshot: Snapshot } | undefined;
  private nextRevision = 0;

  get revision(): number { return this.nextRevision; }

  advance(state: CameraFrameState): CameraFrameHistoryResult {
    const result = this.beginFrame(state);
    this.commitFrame(result);
    return result;
  }

  /** Prepares motion history without publishing camera state before queue.submit succeeds. */
  beginFrame(state: CameraFrameState): CameraFrameHistoryResult {
    validate(state);
    if (this.active) throw new Error("A camera history frame is already active.");
    const previous = this.snapshot;
    const cameraCut = state.forceCut === true || previous === undefined || resized(previous, state)
      || jumped(previous, state);
    const previousViewProjection = new Float32Array(cameraCut
      ? state.viewProjection
      : previous.viewProjection);
    const previousJitter = cameraCut ? copyJitter(state.jitter) : copyJitter(previous.jitter);
    const currentJitter = copyJitter(state.jitter);
    const revision = this.nextRevision++;
    const snapshot = Object.freeze({
      eye: copyVec3(state.eye),
      target: copyVec3(state.target),
      extent: state.extent,
      width: state.width,
      height: state.height,
      viewProjection: new Float32Array(state.viewProjection),
      jitter: currentJitter,
    });
    const result = Object.freeze({ revision, cameraCut, previousViewProjection, currentJitter, previousJitter });
    this.active = { result, snapshot };
    return result;
  }

  commitFrame(result: CameraFrameHistoryResult): void {
    if (!this.active || this.active.result !== result) throw new Error("Camera history frame is not active.");
    this.snapshot = this.active.snapshot;
    this.active = undefined;
  }

  cancelFrame(result: CameraFrameHistoryResult): void {
    if (!this.active || this.active.result !== result) throw new Error("Camera history frame is not active.");
    this.active = undefined;
  }

  /** Clears an abandoned encode attempt before preparing a retry. */
  cancelPendingFrame(): void {
    this.active = undefined;
  }

  reset(): void {
    this.snapshot = undefined;
    this.active = undefined;
    this.nextRevision = 0;
  }
}

function resized(previous: Snapshot, current: CameraFrameState): boolean {
  return previous.width !== current.width || previous.height !== current.height;
}

function jumped(previous: Snapshot, current: CameraFrameState): boolean {
  const scale = Math.max(previous.extent, current.extent, 1e-4);
  const eyeDelta = distance(previous.eye, current.eye) / scale;
  const targetDelta = distance(previous.target, current.target) / scale;
  const extentRatio = Math.max(previous.extent, current.extent) / Math.min(previous.extent, current.extent);
  return eyeDelta > 0.35 || targetDelta > 0.35 || extentRatio > 1.5;
}

function validate(state: CameraFrameState): void {
  if (!Number.isSafeInteger(state.width) || !Number.isSafeInteger(state.height)
    || state.width < 1 || state.height < 1) throw new Error("Camera frame dimensions are invalid.");
  if (!Number.isFinite(state.extent) || state.extent <= 0
    || state.eye.length !== 3 || state.target.length !== 3
    || ![...state.eye, ...state.target].every(Number.isFinite)) throw new Error("Camera frame view is invalid.");
  if (!(state.viewProjection instanceof Float32Array) || state.viewProjection.length !== 16
    || !state.viewProjection.every(Number.isFinite)) throw new Error("Camera view-projection matrix must contain 16 finite float32 values.");
  if (state.jitter.length !== 2 || !state.jitter.every(value => Number.isFinite(value) && value >= -0.5 && value <= 0.5)) {
    throw new Error("Camera projection jitter must contain two finite half-pixel values.");
  }
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function copyVec3(value: Vec3): Vec3 { return [value[0], value[1], value[2]]; }
function copyJitter(value: readonly [number, number]): readonly [number, number] {
  return Object.freeze([value[0], value[1]] as const);
}

/** Applies pixel-space jitter to a column-major clip matrix without changing depth. */
export function jitterViewProjection(matrix: Float32Array, jitter: readonly [number, number],
  width: number, height: number): Float32Array<ArrayBuffer> {
  if (matrix.length !== 16 || !matrix.every(Number.isFinite)
    || jitter.length !== 2 || !jitter.every(value => Number.isFinite(value) && value >= -0.5 && value <= 0.5)
    || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("View-projection jitter input is invalid.");
  }
  const result = new Float32Array(matrix), deltaX = 2 * jitter[0] / width, deltaY = -2 * jitter[1] / height;
  for (let column = 0; column < 4; column++) {
    const offset = column * 4;
    result[offset] = result[offset]! + deltaX * result[offset + 3]!;
    result[offset + 1] = result[offset + 1]! + deltaY * result[offset + 3]!;
  }
  return result;
}
