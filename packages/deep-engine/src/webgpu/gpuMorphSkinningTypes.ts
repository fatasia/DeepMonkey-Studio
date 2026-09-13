import type { GpuMorphSource, GpuMorphWeights } from "./gpuMorphTypes.js";
import type { SkinningPalette, SkinningSource } from "./gpuSkinningTypes.js";

export interface PreparedMorphSkinningInput {
  readonly vertexCount: number;
  readonly targetCount: number;
  readonly jointCount: number;
  readonly flags: number;
  readonly vertices: ArrayBuffer;
  readonly deltas: Float32Array<ArrayBuffer>;
  readonly morphWeights: Float32Array<ArrayBuffer>;
  readonly influences: ArrayBuffer;
  readonly joints: Float32Array<ArrayBuffer>;
  readonly maximumBaseMagnitude: number;
  readonly maximumDeltaMagnitude: number;
}

export interface GpuMorphSkinningResult {
  readonly output: GPUBuffer;
  readonly vertexCount: number;
  readonly outputStride: 48;
  readonly hasNormals: boolean;
  readonly hasTangents: boolean;
  readonly morphSourceRevision: number;
  readonly skinningSourceRevision: number;
  readonly morphWeightsRevision: number;
  readonly paletteRevision: number;
}

export interface MorphSkinningSources {
  readonly morph: GpuMorphSource;
  readonly skinning: SkinningSource;
}

export interface MorphSkinningDynamics {
  readonly morphWeights: GpuMorphWeights;
  readonly palette: SkinningPalette;
}
