import type { AnimationClipInput, AnimationWrapMode } from "../animation/types.js";
import type { MorphWeightClip } from "../morph/types.js";
import type { PbrMaterial, InstanceUpdate } from "../renderPacketTypes.js";
import type { SpatialItemId } from "../spatial/types.js";
import type { GpuMorphWeights } from "../webgpu/gpuMorphTypes.js";
import type { MorphSkinningDynamics } from "../webgpu/gpuMorphSkinningTypes.js";
import type { SkinningPalette } from "../webgpu/gpuSkinningTypes.js";
import type { DecodedAnimatedGlb, GltfAnimatedNode } from "./animationTypes.js";
import type { DecodedMorphGlb } from "./morphTypes.js";
import type { DecodedSkinnedGlb } from "./skinTypes.js";

export type GltfAnimationPlaybackMode = "loop" | "once";

export interface GltfTransformAnimationSource<TNodeId extends SpatialItemId> {
  readonly sceneIndex: number;
  readonly nodes: readonly GltfAnimatedNode<TNodeId>[];
  readonly clips?: readonly AnimationClipInput<TNodeId>[];
  readonly transformClips?: readonly AnimationClipInput<TNodeId>[];
}

export interface GltfRenderAnimationSources<TNodeId extends SpatialItemId = number> {
  readonly animation?: DecodedAnimatedGlb<TNodeId> | GltfTransformAnimationSource<TNodeId>;
  readonly skinning?: DecodedSkinnedGlb<TNodeId>;
  readonly morph?: DecodedMorphGlb<TNodeId>;
}

export interface GltfRenderInstanceBinding<TNodeId extends SpatialItemId> {
  readonly nodeId: TNodeId;
  readonly id: string;
  readonly geometry: string;
  readonly material: string;
}

export interface GltfRenderInstanceProjection<TNodeId extends SpatialItemId> {
  readonly materials: readonly PbrMaterial[];
  readonly bindings: readonly GltfRenderInstanceBinding<TNodeId>[];
}

export interface GltfRenderAnimationBridgeOptions<TNodeId extends SpatialItemId> {
  readonly instances?: GltfRenderInstanceProjection<TNodeId>;
  readonly selection?: GltfRenderAnimationSelection;
}

export interface GltfRenderAnimationSelection {
  /** Omit to select the first transform clip; null disables transform animation. */
  readonly transformClipId?: string | null;
  /** Omit to select the first morph clip; null disables morph animation. */
  readonly morphClipId?: string | null;
  readonly wrapMode?: AnimationWrapMode;
  /** Friendly playback alias. `once` clamps at the terminal key and reports finished. */
  readonly playbackMode?: GltfAnimationPlaybackMode;
  readonly time?: number;
  readonly timeScale?: number;
  readonly paused?: boolean;
}

export interface GltfRenderNodeFrame<TNodeId extends SpatialItemId> {
  readonly nodeId: TNodeId;
  /** Column-major world transform, reused until this bank becomes writable again. */
  readonly worldTransform: Float32Array<ArrayBuffer>;
}

export interface GltfSkinPaletteFrame<TNodeId extends SpatialItemId> {
  readonly nodeId: TNodeId;
  readonly skinId: string;
  readonly primitiveIds: readonly string[];
  readonly palette: SkinningPalette;
}

export interface GltfMorphWeightsFrame<TNodeId extends SpatialItemId> {
  readonly nodeId: TNodeId;
  readonly primitiveIds: readonly string[];
  readonly weights: GpuMorphWeights;
}

export interface GltfMorphSkinningFrame {
  readonly primitiveId: string;
  readonly dynamics: MorphSkinningDynamics;
}

export interface GltfRenderAnimationFrame<TNodeId extends SpatialItemId> {
  readonly revision: number;
  readonly time: number;
  readonly paused: boolean;
  readonly finished: boolean;
  readonly nodeWorldTransforms: readonly GltfRenderNodeFrame<TNodeId>[];
  readonly skinPalettes: readonly GltfSkinPaletteFrame<TNodeId>[];
  readonly morphWeights: readonly GltfMorphWeightsFrame<TNodeId>[];
  readonly morphSkinning: readonly GltfMorphSkinningFrame[];
  /** Ready for PacketBuffers.updateInstances when an instance projection was configured. */
  readonly instanceUpdate?: InstanceUpdate;
}

export type GltfRenderAnimationBridgeErrorCode =
  | "duplicate-binding" | "invalid-binding" | "invalid-input" | "invalid-time"
  | "missing-clip" | "missing-node" | "node-mismatch" | "singular-transform" | "transition-active";

export class GltfRenderAnimationBridgeError extends Error {
  constructor(readonly code: GltfRenderAnimationBridgeErrorCode, message: string) {
    super(message);
    this.name = "GltfRenderAnimationBridgeError";
  }
}

export interface ResolvedGltfRenderAnimationSources<TNodeId extends SpatialItemId> {
  readonly nodes: readonly GltfAnimatedNode<TNodeId>[];
  readonly transformClips: readonly AnimationClipInput<TNodeId>[];
  readonly morphClips: readonly MorphWeightClip<TNodeId>[];
  readonly skinning?: DecodedSkinnedGlb<TNodeId>;
  readonly morph?: DecodedMorphGlb<TNodeId>;
}
