import type { AnimationInterpolation, AnimationWrapMode } from "../animation/types.js";
import type { SpatialItemId } from "../spatial/types.js";

export type MorphTargetSemantic = "POSITION" | "NORMAL" | "TANGENT";

export interface MorphTargetSource {
  readonly index: number;
  readonly name: string;
  readonly positionDeltas?: Float32Array<ArrayBuffer>;
  readonly normalDeltas?: Float32Array<ArrayBuffer>;
  readonly tangentDeltas?: Float32Array<ArrayBuffer>;
}

export interface MorphPrimitiveSource {
  readonly id: string;
  readonly sourceMeshIndex: number;
  readonly sourcePrimitiveIndex: number;
  readonly vertexCount: number;
  readonly targets: readonly MorphTargetSource[];
}

export interface MorphWeightTrack<TNodeId extends SpatialItemId = SpatialItemId> {
  readonly nodeId: TNodeId;
  readonly targetCount: number;
  readonly interpolation: AnimationInterpolation;
  readonly times: Float32Array<ArrayBuffer>;
  /** Per key: values, or in-tangent/value/out-tangent for CUBICSPLINE. */
  readonly values: Float32Array<ArrayBuffer>;
}

export interface MorphWeightClip<TNodeId extends SpatialItemId = SpatialItemId> {
  readonly id: string;
  readonly duration: number;
  readonly tracks: readonly MorphWeightTrack<TNodeId>[];
}

export interface MorphBlendOutput {
  readonly positionDeltas?: Float32Array<ArrayBuffer>;
  readonly normalDeltas?: Float32Array<ArrayBuffer>;
  readonly tangentDeltas?: Float32Array<ArrayBuffer>;
}

export interface MorphSampleOptions {
  readonly wrapMode?: AnimationWrapMode;
}

export type MorphRuntimeErrorCode = "invalid-source" | "invalid-time" | "invalid-output";
export class MorphRuntimeError extends Error {
  constructor(readonly code: MorphRuntimeErrorCode, message: string) {
    super(message);
    this.name = "MorphRuntimeError";
  }
}
