/// <reference types="@webgpu/types" />
import type { HiZOcclusionView } from "./hiZOcclusionCulling.js";
import type { HiZResult } from "./hiZPyramid.js";

export type PreviousHiZFallbackReason =
  | "first-frame"
  | "camera-cut"
  | "viewport-changed"
  | "depth-convention-changed"
  | "scene-changed"
  | "camera-changed";

export interface PreviousHiZFrameInput {
  /** Monotonic revision assigned to the command submission being built. */
  readonly frameRevision: number;
  /** Changes whenever an occluder geometry, material, or transform changes. */
  readonly sceneRevision: number;
  /** Exact jittered matrix used to render the depth that will be committed. */
  readonly depthViewProjection: Float32Array | readonly number[];
  /** Unjittered matrix; any change disables previous-depth occlusion for this frame. */
  readonly stableViewProjection: Float32Array | readonly number[];
  readonly cameraPosition: readonly [number, number, number];
  readonly viewport: readonly [number, number];
  readonly reversedZ: boolean;
  readonly cameraCut: boolean;
}

export type PreviousHiZFramePlan =
  | { readonly mode: "direct"; readonly frameRevision: number; readonly reason: PreviousHiZFallbackReason }
  | { readonly mode: "occlusion"; readonly frameRevision: number };

interface FrameSnapshot {
  readonly frameRevision: number;
  readonly sceneRevision: number;
  readonly depthViewProjection: readonly number[];
  readonly stableViewProjection: readonly number[];
  readonly cameraPosition: readonly [number, number, number];
  readonly viewport: readonly [number, number];
  readonly reversedZ: boolean;
  readonly cameraCut: boolean;
  readonly hiz: HiZResult;
}

interface ActiveFrame {
  readonly plan: PreviousHiZFramePlan;
  readonly frame: Omit<FrameSnapshot, "hiz">;
  previous: FrameSnapshot | undefined;
}

/**
 * Publishes borrowed Hi-Z results only after their command buffer was submitted.
 * It deliberately falls back to the caller's direct/frustum path when an old
 * depth image cannot be used without risking a false occlusion.
 */
export class PreviousHiZVisibility {
  private committed: FrameSnapshot | undefined;
  private active: ActiveFrame | undefined;
  private disposed = false;

  beginFrame(input: PreviousHiZFrameInput): PreviousHiZFramePlan {
    this.assertAlive();
    if (this.active) throw new Error("A previous Hi-Z visibility frame is already active.");
    const frame = copyFrame(input);
    if (this.committed && frame.frameRevision <= this.committed.frameRevision) {
      throw new Error("Previous Hi-Z frame revision must advance after a successful submission.");
    }
    const reason = fallbackReason(this.committed, frame);
    const plan: PreviousHiZFramePlan = Object.freeze(reason
      ? { mode: "direct", frameRevision: frame.frameRevision, reason }
      : { mode: "occlusion", frameRevision: frame.frameRevision });
    this.active = { plan, frame, previous: this.committed };
    return plan;
  }

  /** Returns the previous producer view while this plan is active, otherwise undefined. */
  occlusionView(plan: PreviousHiZFramePlan): HiZOcclusionView | undefined {
    const active = this.assertActive(plan);
    const previous = active.previous;
    if (plan.mode !== "occlusion" || !previous) return undefined;
    return Object.freeze({
      viewProjection: previous.depthViewProjection,
      cameraPosition: previous.cameraPosition,
      viewport: previous.viewport,
      hiz: previous.hiz,
      reversedZ: previous.reversedZ,
    });
  }

  /** Call only after queue.submit returns successfully for this frame. */
  commitFrame(plan: PreviousHiZFramePlan, hiz: HiZResult): void {
    const active = this.assertActive(plan);
    validateProducedHiZ(hiz, active.frame);
    this.committed = Object.freeze({ ...active.frame, hiz });
    this.active = undefined;
  }

  /** Cancels work known not to have touched the Hi-Z producer and keeps prior history. */
  cancelFrame(plan: PreviousHiZFramePlan): void {
    this.assertActive(plan);
    this.active = undefined;
  }

  /** Fails closed after encoding or submission failure because the producer may have reallocated. */
  failFrame(plan: PreviousHiZFramePlan): void {
    this.assertActive(plan);
    this.active = undefined;
    this.committed = undefined;
  }

  /** Call before an external Hi-Z owner resets, reallocates, or loses its device. */
  invalidate(): void {
    this.assertAlive();
    this.committed = undefined;
    if (this.active) this.active.previous = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = undefined;
    this.committed = undefined;
  }

  private assertActive(plan: PreviousHiZFramePlan): ActiveFrame {
    this.assertAlive();
    if (!this.active || this.active.plan !== plan) throw new Error("Previous Hi-Z frame plan is not active.");
    return this.active;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error("Previous Hi-Z visibility is disposed.");
  }
}

function fallbackReason(previous: FrameSnapshot | undefined,
  current: Omit<FrameSnapshot, "hiz">): PreviousHiZFallbackReason | undefined {
  if (!previous) return "first-frame";
  if (current.cameraCut) return "camera-cut";
  if (!sameNumbers(previous.viewport, current.viewport)) return "viewport-changed";
  if (previous.reversedZ !== current.reversedZ) return "depth-convention-changed";
  if (previous.sceneRevision !== current.sceneRevision) return "scene-changed";
  if (!sameNumbers(previous.stableViewProjection, current.stableViewProjection)
    || !sameNumbers(previous.cameraPosition, current.cameraPosition)) return "camera-changed";
  return undefined;
}

function copyFrame(input: PreviousHiZFrameInput): Omit<FrameSnapshot, "hiz"> {
  if (!Number.isSafeInteger(input.frameRevision) || input.frameRevision < 0
    || !Number.isSafeInteger(input.sceneRevision) || input.sceneRevision < 0) throw new Error("Previous Hi-Z revisions must be nonnegative safe integers.");
  matrix(input.depthViewProjection, "depth"); matrix(input.stableViewProjection, "stable");
  if (input.cameraPosition.length !== 3 || !input.cameraPosition.every(Number.isFinite)) throw new Error("Previous Hi-Z camera position is invalid.");
  if (input.viewport.length !== 2 || !input.viewport.every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Previous Hi-Z viewport is invalid.");
  if (typeof input.reversedZ !== "boolean" || typeof input.cameraCut !== "boolean") throw new Error("Previous Hi-Z depth and cut flags are invalid.");
  return Object.freeze({ frameRevision: input.frameRevision, sceneRevision: input.sceneRevision,
    depthViewProjection: Object.freeze(Array.from(input.depthViewProjection)),
    stableViewProjection: Object.freeze(Array.from(input.stableViewProjection)),
    cameraPosition: Object.freeze([...input.cameraPosition]) as readonly [number, number, number],
    viewport: Object.freeze([...input.viewport]) as readonly [number, number],
    reversedZ: input.reversedZ, cameraCut: input.cameraCut });
}

function validateProducedHiZ(hiz: HiZResult, frame: Omit<FrameSnapshot, "hiz">): void {
  const reduction = frame.reversedZ ? "min" : "max";
  if (hiz.sourceRevision !== frame.frameRevision) throw new Error("Produced Hi-Z revision does not match its submitted frame.");
  if (hiz.width !== frame.viewport[0] || hiz.height !== frame.viewport[1]) throw new Error("Produced Hi-Z viewport does not match its submitted frame.");
  if (hiz.reversedZ !== frame.reversedZ || hiz.reduction !== reduction) throw new Error("Produced Hi-Z depth convention does not match its submitted frame.");
  if (hiz.format !== "r32float" || hiz.texture.format !== "r32float" || hiz.texture.width !== hiz.width
    || hiz.texture.height !== hiz.height || hiz.mipLevelCount < 1 || hiz.levels.length !== hiz.mipLevelCount) {
    throw new Error("Produced Hi-Z resource is incompatible with previous-frame visibility.");
  }
}

function matrix(value: ArrayLike<number>, name: string): void {
  if (value.length !== 16 || !Array.from(value).every(Number.isFinite)) throw new Error(`Previous Hi-Z ${name} matrix is invalid.`);
}

function sameNumbers(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  return left.length === right.length && Array.from(left).every((value, index) => value === right[index]);
}
