import type { SpatialItemId } from "../spatial/types.js";

export type AnimationClipId = string;
export type AnimationLayerId = SpatialItemId;
export type AnimationTargetPath = "translation" | "rotation" | "scale";
export type AnimationInterpolation = "STEP" | "LINEAR" | "CUBICSPLINE";
export type AnimationWrapMode = "loop" | "clamp";
export type AnimationBlendMode = "override" | "additive";
export type AnimationSampleArray = readonly number[] | Float32Array<ArrayBuffer>;

export interface AnimationTrackInput<TNodeId extends SpatialItemId> {
  readonly nodeId: TNodeId;
  readonly path: AnimationTargetPath;
  readonly interpolation: AnimationInterpolation;
  readonly times: AnimationSampleArray;
  /** Flat glTF layout. CUBICSPLINE stores in-tangent, value, out-tangent per key. */
  readonly values: AnimationSampleArray;
}

export interface AnimationClipInput<TNodeId extends SpatialItemId> {
  readonly id: AnimationClipId;
  readonly duration: number;
  readonly tracks: readonly AnimationTrackInput<TNodeId>[];
}

export interface AnimationLayerInput<TNodeId extends SpatialItemId> {
  readonly id: AnimationLayerId;
  readonly clipId: AnimationClipId;
  readonly time?: number;
  readonly timeScale?: number;
  readonly weight?: number;
  readonly wrapMode?: AnimationWrapMode;
  readonly blendMode?: AnimationBlendMode;
  readonly nodeMask?: readonly TNodeId[];
}

export interface AnimationFadeOptions {
  readonly removeWhenComplete?: boolean;
}

export interface SceneAnimationMixerOptions {
  readonly maxClips?: number;
  readonly maxTracksPerClip?: number;
  readonly maxKeysPerTrack?: number;
  readonly maxLayers?: number;
  readonly maxAnimatedNodes?: number;
}

export interface SceneAnimationMixerConfiguration {
  readonly maxClips: number;
  readonly maxTracksPerClip: number;
  readonly maxKeysPerTrack: number;
  readonly maxLayers: number;
  readonly maxAnimatedNodes: number;
}

export interface AnimationFrameResult<TNodeId extends SpatialItemId> {
  readonly revision: number;
  readonly graphGeneration: number;
  readonly activeLayers: number;
  readonly sampledTracks: number;
  readonly updatedNodeIds: readonly TNodeId[];
}

export interface SceneAnimationMixerStats {
  readonly clips: number;
  readonly layers: number;
  readonly pooledNodeAccumulators: number;
  readonly generation: number;
  readonly revision: number;
}

export type AnimationErrorCode =
  | "capacity-exceeded"
  | "duplicate-clip"
  | "duplicate-layer"
  | "duplicate-track"
  | "graph-rejected"
  | "invalid-clip"
  | "invalid-layer"
  | "invalid-time"
  | "invalid-track"
  | "matrix-target"
  | "missing-clip"
  | "missing-layer"
  | "missing-node";

export class AnimationError extends Error {
  readonly code: AnimationErrorCode;

  constructor(code: AnimationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AnimationError";
    this.code = code;
  }
}

export interface ValidatedAnimationTrack<TNodeId extends SpatialItemId> {
  readonly nodeId: TNodeId;
  readonly path: AnimationTargetPath;
  readonly interpolation: AnimationInterpolation;
  readonly times: readonly number[];
  readonly values: readonly number[];
  readonly components: 3 | 4;
  readonly reference: readonly number[];
}

export interface ValidatedAnimationClip<TNodeId extends SpatialItemId> {
  readonly id: AnimationClipId;
  readonly duration: number;
  readonly tracks: readonly ValidatedAnimationTrack<TNodeId>[];
}

export interface AnimationFadeState {
  readonly startWeight: number;
  readonly targetWeight: number;
  readonly duration: number;
  readonly elapsed: number;
  readonly removeWhenComplete: boolean;
}

export interface AnimationLayerState<TNodeId extends SpatialItemId> {
  readonly id: AnimationLayerId;
  readonly clipId: AnimationClipId;
  readonly ordinal: number;
  readonly time: number;
  readonly timeScale: number;
  readonly weight: number;
  readonly wrapMode: AnimationWrapMode;
  readonly blendMode: AnimationBlendMode;
  readonly nodeMask: ReadonlySet<TNodeId> | null;
  readonly fade: AnimationFadeState | null;
}
