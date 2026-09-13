import type { SpatialItemId } from "../spatial/types.js";
import type { GltfAnimatedNode, GltfAnimationImportOptions } from "./animationTypes.js";

export const GLTF_SKINNING_SOURCE_ABI_VERSION = 1 as const;

export interface GltfSkinImportOptions<TNodeId extends SpatialItemId = number> {
  readonly sceneIndex?: number;
  readonly mapNodeId?: (sourceNodeIndex: number, name: string | undefined) => TNodeId;
  readonly resourcePrefix?: string;
  readonly maxNodes?: number;
  readonly maxSkins?: number;
  readonly maxJointsPerSkin?: number;
  readonly maxSkinnedNodes?: number;
  readonly maxPrimitives?: number;
  readonly maxVerticesPerPrimitive?: number;
  readonly maxDecodedBytes?: number;
}

export interface GltfSkin<TNodeId extends SpatialItemId> {
  readonly id: string;
  readonly sourceSkinIndex: number;
  readonly sourceJointIndices: Uint32Array<ArrayBuffer>;
  readonly joints: readonly TNodeId[];
  readonly sourceSkeletonIndex: number | null;
  readonly skeleton: TNodeId | null;
  /** Column-major matrices, one tightly packed mat4 per joint. */
  readonly inverseBindMatrices: Float32Array<ArrayBuffer>;
}

export interface GltfSkinPrimitive {
  readonly id: string;
  readonly sourceMeshIndex: number;
  readonly sourcePrimitiveIndex: number;
  readonly vertexCount: number;
  /** Four local skin-palette indices per vertex, widened to a stable u16 ABI. */
  readonly joints: Uint16Array<ArrayBuffer>;
  /** Four normalized float weights per vertex. */
  readonly weights: Float32Array<ArrayBuffer>;
}

export interface GltfSkinBinding<TNodeId extends SpatialItemId> {
  readonly sourceNodeIndex: number;
  readonly nodeId: TNodeId;
  readonly sourceSkinIndex: number;
  readonly skinId: string;
  readonly sourceMeshIndex: number;
  readonly primitiveIds: readonly string[];
}

export interface DecodedSkinnedGlb<TNodeId extends SpatialItemId = number> {
  readonly abiVersion: typeof GLTF_SKINNING_SOURCE_ABI_VERSION;
  readonly sceneIndex: number;
  readonly nodes: readonly GltfAnimatedNode<TNodeId>[];
  readonly skins: readonly GltfSkin<TNodeId>[];
  readonly primitives: readonly GltfSkinPrimitive[];
  readonly bindings: readonly GltfSkinBinding<TNodeId>[];
  readonly decodedBytes: number;
}

export type GltfAnimationImportTuning<TNodeId extends SpatialItemId> = Omit<
  GltfAnimationImportOptions<TNodeId>, "sceneIndex" | "mapNodeId"
>;
export type GltfSkinImportTuning<TNodeId extends SpatialItemId> = Omit<
  GltfSkinImportOptions<TNodeId>, "sceneIndex" | "mapNodeId"
>;

export interface GltfAnimatedSkinnedImportOptions<TNodeId extends SpatialItemId = number> {
  readonly sceneIndex?: number;
  readonly mapNodeId?: (sourceNodeIndex: number, name: string | undefined) => TNodeId;
  readonly animation?: GltfAnimationImportTuning<TNodeId>;
  readonly skinning?: GltfSkinImportTuning<TNodeId>;
}

export interface DecodedAnimatedSkinnedGlb<TNodeId extends SpatialItemId = number>
  extends DecodedSkinnedGlb<TNodeId> {
  readonly clips: readonly import("../animation/types.js").AnimationClipInput<TNodeId>[];
  readonly animationDecodedBytes: number;
  readonly skinningDecodedBytes: number;
}

export interface GltfSkinImportConfiguration {
  readonly resourcePrefix: string;
  readonly maxNodes: number;
  readonly maxSkins: number;
  readonly maxJointsPerSkin: number;
  readonly maxSkinnedNodes: number;
  readonly maxPrimitives: number;
  readonly maxVerticesPerPrimitive: number;
  readonly maxDecodedBytes: number;
}
