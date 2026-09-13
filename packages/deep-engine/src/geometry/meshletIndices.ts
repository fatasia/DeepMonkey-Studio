import { unpackLocalTriangle } from "./localTriangle.js";
import { validateMeshletBuild } from "./meshletValidation.js";
import { MeshletError, type MeshletBuildResult } from "./types.js";

export type MeshletWinding = "preserve" | "flip";

export interface ExpandedMeshletIndices {
  readonly meshletCount: number;
  readonly triangleCount: number;
  readonly winding: MeshletWinding;
  /** Global uint32 indices, contiguous in descriptor order. */
  readonly indices: Uint32Array<ArrayBuffer>;
  /** [firstIndex, indexCount] per meshlet. */
  readonly ranges: Uint32Array<ArrayBuffer>;
}

/** Expands packed local meshlet triangles once, before upload; no per-frame remapping is required. */
export function expandMeshletIndices(value: MeshletBuildResult, winding: MeshletWinding = "preserve"): ExpandedMeshletIndices {
  validateMeshletBuild(value);
  if (winding !== "preserve" && winding !== "flip") throw new MeshletError("invalid-input", "Invalid meshlet winding mode.");
  if (value.sourceTriangleCount > Math.floor(0xffff_ffff / 3)) {
    throw new MeshletError("overflow", "Expanded meshlet indices exceed uint32 firstIndex addressing.");
  }
  const indices = new Uint32Array(value.sourceTriangleCount * 3), ranges = new Uint32Array(value.meshletCount * 2);
  for (let meshlet = 0; meshlet < value.meshletCount; meshlet += 1) {
    const descriptor = meshlet * 4, vertexOffset = value.descriptors[descriptor]!;
    const triangleOffset = value.descriptors[descriptor + 2]!, triangleCount = value.descriptors[descriptor + 3]!;
    ranges.set([triangleOffset * 3, triangleCount * 3], meshlet * 2);
    for (let triangle = 0; triangle < triangleCount; triangle += 1) {
      const local = unpackLocalTriangle(value.localTriangleIndices[triangleOffset + triangle]!);
      const target = (triangleOffset + triangle) * 3;
      indices[target] = value.vertexRemap[vertexOffset + local[0]]!;
      indices[target + (winding === "flip" ? 2 : 1)] = value.vertexRemap[vertexOffset + local[1]]!;
      indices[target + (winding === "flip" ? 1 : 2)] = value.vertexRemap[vertexOffset + local[2]]!;
    }
  }
  return Object.freeze({ meshletCount: value.meshletCount, triangleCount: value.sourceTriangleCount, winding, indices, ranges });
}

/** Returns true for a negative-determinant affine transform; singular transforms have no defined winding. */
export function isMirroredMeshletTransform(matrix: ArrayLike<number>): boolean {
  if (!matrix || matrix.length !== 16) throw new MeshletError("invalid-input", "Meshlet transform must contain 16 values.");
  const m = Array.from(matrix);
  if (!m.every(Number.isFinite) || m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) {
    throw new MeshletError("invalid-input", "Meshlet transform must be finite, affine, and column-major.");
  }
  const determinant = m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!)
    - m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!)
    + m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
  const scale = Math.max(...m.slice(0, 12).map(Math.abs));
  if (!Number.isFinite(determinant) || scale === 0 || Math.abs(determinant) <= scale ** 3 * 1e-12) {
    throw new MeshletError("invalid-input", "Singular meshlet transforms do not have a defined winding.");
  }
  return determinant < 0;
}
