import type { AnimationClipInput } from "../animation/types.js";
import type { SceneLocalTransform } from "../scene/types.js";
import type { SpatialItemId } from "../spatial/types.js";

export interface GltfAnimationImportOptions<TNodeId extends SpatialItemId = number> {
  /** Defaults to the document default scene, then scene zero. */
  readonly sceneIndex?: number;
  /** Defaults to the source node index. Use a mapper when combining assets. */
  readonly mapNodeId?: (sourceNodeIndex: number, name: string | undefined) => TNodeId;
  readonly clipPrefix?: string;
  readonly maxAnimations?: number;
  readonly maxNodes?: number;
  readonly maxSamplersPerAnimation?: number;
  readonly maxChannelsPerAnimation?: number;
  readonly maxKeysPerTrack?: number;
  readonly maxDecodedBytes?: number;
  /** Cancels validation and owned accessor expansion before publication. */
  readonly signal?: AbortSignal;
}

export interface GltfAnimatedNode<TNodeId extends SpatialItemId> {
  readonly sourceNodeIndex: number;
  readonly id: TNodeId;
  readonly parent: TNodeId | null;
  readonly name?: string;
  readonly localTransform: SceneLocalTransform;
}

export interface DecodedAnimatedGlb<TNodeId extends SpatialItemId = number> {
  readonly sceneIndex: number;
  readonly nodes: readonly GltfAnimatedNode<TNodeId>[];
  readonly clips: readonly AnimationClipInput<TNodeId>[];
  readonly decodedBytes: number;
}

export interface GltfAnimationImportConfiguration {
  readonly maxAnimations: number;
  readonly maxNodes: number;
  readonly maxSamplersPerAnimation: number;
  readonly maxChannelsPerAnimation: number;
  readonly maxKeysPerTrack: number;
  readonly maxDecodedBytes: number;
  readonly clipPrefix: string;
  readonly signal?: AbortSignal;
}
