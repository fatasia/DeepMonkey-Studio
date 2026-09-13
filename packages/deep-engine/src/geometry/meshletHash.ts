import { MESHLET_SCHEMA_VERSION, type MeshletBuildResult } from "./types.js";
import { validateMeshletBuild } from "./meshletValidation.js";

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;

/** Portable FNV-1a-64 over the canonical little-endian meshlet ABI. Intended for cache identity, not security. */
export function hashMeshletBuild(value: MeshletBuildResult): string {
  validateMeshletBuild(value);
  let hash = OFFSET;
  const scratch = new DataView(new ArrayBuffer(4));
  const byte = (next: number): void => {
    hash ^= BigInt(next);
    hash = BigInt.asUintN(64, hash * PRIME);
  };
  const word = (next: number): void => {
    scratch.setUint32(0, next, true);
    for (let index = 0; index < 4; index += 1) byte(scratch.getUint8(index));
  };
  const float = (next: number): void => {
    scratch.setFloat32(0, next, true);
    for (let index = 0; index < 4; index += 1) byte(scratch.getUint8(index));
  };
  for (const header of [MESHLET_SCHEMA_VERSION, value.sourceVertexCount, value.sourceTriangleCount,
    value.meshletCount, value.maxVertices, value.maxTriangles]) word(header);
  for (const values of [value.descriptors, value.vertexRemap, value.localTriangleIndices]) {
    word(values.length);
    for (const value of values) word(value);
  }
  word(value.bounds.length);
  for (const component of value.bounds) float(component);
  return hash.toString(16).padStart(16, "0");
}
