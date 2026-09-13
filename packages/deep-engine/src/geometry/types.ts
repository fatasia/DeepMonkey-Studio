export const MESHLET_SCHEMA_VERSION = 1 as const;

export const MESHLET_DEFAULTS = Object.freeze({
  maxVertices: 64,
  maxTriangles: 126,
});

export const MESHLET_BUILD_BUDGETS = Object.freeze({
  sourceVertices: 16_777_216,
  sourceTriangles: 4_000_000,
  outputMeshlets: 4_000_000,
  outputBytes: 512 * 1024 * 1024,
});

/** [vertexOffset, vertexCount, triangleOffset, triangleCount], one 16-byte record per meshlet. */
export const MESHLET_DESCRIPTOR_STRIDE = 4;

/** sphere vec4, AABB min vec4, AABB max vec4, normal cone vec4, one 64-byte record per meshlet. */
export const MESHLET_BOUNDS_STRIDE = 16;

export type MeshletErrorCode = "budget-exceeded" | "invalid-input" | "invalid-result" | "overflow";

export class MeshletError extends Error {
  constructor(readonly code: MeshletErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MeshletError";
  }
}

export interface IndexedTriangleGeometry {
  /** Tightly packed XYZ positions. SharedArrayBuffer inputs are rejected to preserve deterministic builds. */
  readonly positions: Float32Array;
  readonly indices: Uint16Array | Uint32Array;
}

export interface MeshletBuildOptions {
  readonly maxVertices?: number;
  readonly maxTriangles?: number;
}

export interface MeshletBuildResult {
  readonly schemaVersion: typeof MESHLET_SCHEMA_VERSION;
  readonly sourceVertexCount: number;
  readonly sourceTriangleCount: number;
  readonly meshletCount: number;
  readonly maxVertices: number;
  readonly maxTriangles: number;
  /** Records use MESHLET_DESCRIPTOR_STRIDE and offsets are element offsets, not byte offsets. */
  readonly descriptors: Uint32Array<ArrayBuffer>;
  /** Concatenated local-to-global vertex tables. */
  readonly vertexRemap: Uint32Array<ArrayBuffer>;
  /** One word per triangle: local vertex indices in bits 0..7, 8..15, and 16..23. */
  readonly localTriangleIndices: Uint32Array<ArrayBuffer>;
  /** Records use MESHLET_BOUNDS_STRIDE. Cone cutoff -1 disables cone culling. */
  readonly bounds: Float32Array<ArrayBuffer>;
}

export interface MeshletValidationOptions {
  /** When supplied, validation also proves that bounds contain all referenced source positions. */
  readonly sourcePositions?: Float32Array;
  readonly maxVertices?: number;
  readonly maxTriangles?: number;
}
