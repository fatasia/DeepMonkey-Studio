export interface SkinningSource {
  readonly revision: number;
  readonly positions: Float32Array<ArrayBuffer>;
  readonly normals: Float32Array<ArrayBuffer>;
  /** Optional unit tangent xyz and handedness w, in the same vertex order as positions. */
  readonly tangents?: Float32Array<ArrayBuffer>;
  readonly joints: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
  readonly weights: Float32Array<ArrayBuffer>;
  /** Default normalizes positive weights; author adapters can preserve their original magnitudes. */
  readonly weightMode?: "normalize" | "preserve";
}

export interface SkinningPalette {
  readonly revision: number;
  /** Column-major joint matrices. */
  readonly matrices: Float32Array<ArrayBuffer>;
  /** Explicit normal transform rows, padded to 12 floats per joint; omitted derives inverse-transpose. */
  readonly normalMatrices?: Float32Array<ArrayBuffer>;
}

export interface PreparedSkinningInput {
  readonly vertexCount: number;
  readonly jointCount: number;
  readonly vertices: ArrayBuffer;
  readonly tangents?: Float32Array<ArrayBuffer>;
  readonly joints: Float32Array<ArrayBuffer>;
}

export interface GpuSkinningResult {
  readonly output: GPUBuffer;
  readonly vertexCount: number;
  readonly outputStride: 32 | 48;
  readonly hasTangents: boolean;
  readonly sourceRevision: number;
  readonly paletteRevision: number;
}
