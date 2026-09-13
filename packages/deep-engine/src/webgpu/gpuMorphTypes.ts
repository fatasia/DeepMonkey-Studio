import type { MorphPrimitiveSource } from "../morph/types.js";

export interface GpuMorphSource {
  readonly revision: number;
  readonly primitive: MorphPrimitiveSource;
  readonly positions: Float32Array<ArrayBuffer>;
  readonly normals?: Float32Array<ArrayBuffer>;
  /** Four floats per vertex; xyz is the tangent and w is the handedness sign. */
  readonly tangents?: Float32Array<ArrayBuffer>;
}

export interface GpuMorphWeights {
  readonly revision: number;
  readonly values: Float32Array<ArrayBuffer>;
}

export interface PreparedMorphInput {
  readonly vertexCount: number;
  readonly targetCount: number;
  readonly flags: number;
  readonly vertices: ArrayBuffer;
  readonly deltas: Float32Array<ArrayBuffer>;
  readonly weights: Float32Array<ArrayBuffer>;
  readonly maximumBaseMagnitude: number;
  readonly maximumDeltaMagnitude: number;
}

export interface GpuMorphResult {
  readonly output: GPUBuffer;
  readonly vertexCount: number;
  readonly outputStride: 48;
  readonly hasNormals: boolean;
  readonly hasTangents: boolean;
  readonly sourceRevision: number;
  readonly weightsRevision: number;
}
