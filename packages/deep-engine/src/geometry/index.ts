export {
  DGC_FILE_HEADER_SIZE,
  DGC_FLAG_ZLIB,
  DGC_FORMAT_VERSION,
  DGC_MAGIC,
  DGC_MAX_TRIANGLES_LIMIT,
  DGC_MAX_VERTICES_LIMIT,
  DGC_NO_PARENT,
  DGC_PAYLOAD_ALIGNMENT,
  DGC_SECTION_HEADER_SIZE,
  DGC_SECTION_KIND_LEVEL,
  DGC_SECTION_KIND_PARENTS,
  crc32c as dgcCrc32c,
  decodeDgc,
  DgcFormatError,
  parseDgcHeader,
  parseDgcSections,
} from "./dgcLoader.js";
export type { DgcBytes, DgcDag, DgcDagLevel, DgcFileHeader, DgcSectionHeader } from "./dgcLoader.js";
export { buildMeshlets, packLocalTriangle, unpackLocalTriangle } from "./meshletBuilder.js";
export { hashMeshletBuild } from "./meshletHash.js";
export { expandMeshletIndices, isMirroredMeshletTransform } from "./meshletIndices.js";
export type { ExpandedMeshletIndices, MeshletWinding } from "./meshletIndices.js";
export { validateMeshletBuild } from "./meshletValidation.js";
export {
  MESHLET_BOUNDS_STRIDE,
  MESHLET_BUILD_BUDGETS,
  MESHLET_DEFAULTS,
  MESHLET_DESCRIPTOR_STRIDE,
  MESHLET_SCHEMA_VERSION,
  MeshletError,
} from "./types.js";
export type {
  IndexedTriangleGeometry,
  MeshletBuildOptions,
  MeshletBuildResult,
  MeshletErrorCode,
  MeshletValidationOptions,
} from "./types.js";
