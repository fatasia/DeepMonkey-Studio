import type { GpuMorphSource, GpuMorphWeights } from "../webgpu/gpuMorphTypes.js";
import type { SkinningPalette, SkinningSource } from "../webgpu/gpuSkinningTypes.js";

export interface DeformationSource {
  readonly id: string;
  readonly revision: number;
  readonly geometry: string;
  readonly kind: "morph" | "skin" | "morph-skin";
  /** Declares requested author semantics, not renderer support. */
  readonly semantics: "three-r185";
  readonly morph?: GpuMorphSource;
  readonly skinning?: SkinningSource;
}

export interface DeformationPose {
  readonly id: string;
  readonly source: string;
  readonly revision: number;
  readonly morphWeights?: GpuMorphWeights;
  readonly palette?: SkinningPalette;
}

export interface DeformationSnapshot {
  readonly sources: readonly DeformationSource[];
  readonly poses: readonly DeformationPose[];
}
