export interface SkinningSource {
  readonly revision: number;
  readonly positions: Float32Array<ArrayBuffer>;
  readonly normals: Float32Array<ArrayBuffer>;
  readonly joints: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
  readonly weights: Float32Array<ArrayBuffer>;
}

export interface SkinningPalette {
  readonly revision: number;
  /** Column-major joint matrices. */
  readonly matrices: Float32Array<ArrayBuffer>;
  /** Optional row-major inverse-transpose rows, padded to 12 floats per joint. */
  readonly normalMatrices?: Float32Array<ArrayBuffer>;
}

export interface PreparedSkinningInput {
  readonly vertexCount: number;
  readonly jointCount: number;
  readonly vertices: ArrayBuffer;
  readonly joints: Float32Array<ArrayBuffer>;
}

export interface GpuSkinningResult {
  readonly output: GPUBuffer;
  readonly vertexCount: number;
  readonly outputStride: 32;
  readonly sourceRevision: number;
  readonly paletteRevision: number;
}
