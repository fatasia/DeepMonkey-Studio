import type { AnimationClipInput } from "../animation/types.js";
import type { MorphPrimitiveSource, MorphWeightClip } from "../morph/types.js";
import type { SpatialItemId } from "../spatial/types.js";
import type { GltfAnimatedNode, GltfAnimationImportOptions } from "./animationTypes.js";

export const GLTF_MORPH_SOURCE_ABI_VERSION = 1 as const;

export interface GltfMorphImportOptions<TNodeId extends SpatialItemId = number> {
  readonly sceneIndex?: number;
  readonly mapNodeId?: (sourceNodeIndex: number, name: string | undefined) => TNodeId;
  readonly resourcePrefix?: string;
  readonly clipPrefix?: string;
  readonly maxNodes?: number;
  readonly maxMeshes?: number;
  readonly maxPrimitives?: number;
  readonly maxTargetsPerPrimitive?: number;
  readonly maxVerticesPerPrimitive?: number;
  readonly maxAnimations?: number;
  readonly maxChannelsPerAnimation?: number;
  readonly maxKeysPerTrack?: number;
  readonly maxDecodedBytes?: number;
}

export interface GltfMorphBinding<TNodeId extends SpatialItemId> {
  readonly sourceNodeIndex: number;
  readonly nodeId: TNodeId;
  readonly sourceMeshIndex: number;
  readonly primitiveIds: readonly string[];
  readonly initialWeights: Float32Array<ArrayBuffer>;
}

export interface DecodedMorphGlb<TNodeId extends SpatialItemId = number> {
  readonly abiVersion: typeof GLTF_MORPH_SOURCE_ABI_VERSION;
  readonly sceneIndex: number;
  readonly nodes: readonly GltfAnimatedNode<TNodeId>[];
  readonly primitives: readonly MorphPrimitiveSource[];
  readonly bindings: readonly GltfMorphBinding<TNodeId>[];
  readonly morphClips: readonly MorphWeightClip<TNodeId>[];
  readonly decodedBytes: number;
}

export type GltfMorphImportTuning<TNodeId extends SpatialItemId> = Omit<
  GltfMorphImportOptions<TNodeId>, "sceneIndex" | "mapNodeId"
>;
export type GltfTransformAnimationTuning<TNodeId extends SpatialItemId> = Omit<
  GltfAnimationImportOptions<TNodeId>, "sceneIndex" | "mapNodeId"
>;

export interface GltfAnimatedMorphImportOptions<TNodeId extends SpatialItemId = number> {
  readonly sceneIndex?: number;
  readonly mapNodeId?: (sourceNodeIndex: number, name: string | undefined) => TNodeId;
  readonly animation?: GltfTransformAnimationTuning<TNodeId>;
  readonly morph?: GltfMorphImportTuning<TNodeId>;
}

export interface DecodedAnimatedMorphGlb<TNodeId extends SpatialItemId = number> extends DecodedMorphGlb<TNodeId> {
  readonly transformClips: readonly AnimationClipInput<TNodeId>[];
  readonly transformAnimationDecodedBytes: number;
  readonly morphDecodedBytes: number;
}

export interface GltfMorphImportConfiguration {
  readonly resourcePrefix: string;
  readonly clipPrefix: string;
  readonly maxNodes: number;
  readonly maxMeshes: number;
  readonly maxPrimitives: number;
  readonly maxTargetsPerPrimitive: number;
  readonly maxVerticesPerPrimitive: number;
  readonly maxAnimations: number;
  readonly maxChannelsPerAnimation: number;
  readonly maxKeysPerTrack: number;
  readonly maxDecodedBytes: number;
}
