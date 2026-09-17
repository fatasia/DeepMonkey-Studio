import { buildMeshlets } from "./geometry/meshletBuilder.js";
import { expandMeshletIndices, type ExpandedMeshletIndices } from "./geometry/meshletIndices.js";
import { hashMeshletBuild } from "./geometry/meshletHash.js";
import { MESHLET_DEFAULTS, type MeshletBuildResult } from "./geometry/types.js";
import type { GeometryResource, PbrMaterial, RenderPacket } from "./renderPacket.js";

export const DEEP_BAKE_SCHEMA_VERSION = 1 as const;
export type DeepBakeQuality = "performance" | "balanced" | "quality";
const MESHLET_TARGETS: Readonly<Record<DeepBakeQuality, Readonly<{ maxVertices: number; maxTriangles: number }>>> = Object.freeze({
  performance: Object.freeze({ maxVertices: 64, maxTriangles: 64 }),
  balanced: Object.freeze({ maxVertices: MESHLET_DEFAULTS.maxVertices, maxTriangles: MESHLET_DEFAULTS.maxTriangles }),
  quality: Object.freeze({ maxVertices: 64, maxTriangles: 126 }),
});

export interface DeepBakeOptions {
  readonly quality?: DeepBakeQuality;
  readonly recipeVersion?: string;
}

export interface DeepBakedGeometry {
  readonly id: string;
  readonly revision: number;
  readonly sourceHash: string;
  readonly meshletHash: string;
  readonly meshlets: MeshletBuildResult;
  /** Expanded once so indirect drawing never remaps local triangles per frame. */
  readonly indices: ExpandedMeshletIndices;
}

export interface DeepBakeGeometryPlan {
  readonly id: string;
  readonly sourceHash: string;
  readonly meshletHash: string;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly meshletCount: number;
  readonly expandedIndexCount: number;
}

export interface DeepBakeResult {
  readonly schemaVersion: typeof DEEP_BAKE_SCHEMA_VERSION;
  readonly quality: DeepBakeQuality;
  readonly recipeVersion: string;
  readonly sourceHash: string;
  readonly cacheKey: string;
  readonly geometries: readonly DeepBakedGeometry[];
  readonly geometryPlans: readonly DeepBakeGeometryPlan[];
  readonly materialVariantKeys: readonly string[];
  readonly textureIds: readonly string[];
  /** Runtime lighting remains dynamic; static scenes may add probe data later. */
  readonly staticLighting: "probe-hybrid";
}

/**
 * Deterministically preprocesses a RenderPacket for the shared browser/native
 * upload path. This is intentionally an artifact builder, not a hidden runtime
 * mutation: callers may cache the result by cacheKey and discard it safely.
 */
export function bakeRenderPacket(packet: Pick<RenderPacket, "geometries" | "materials" | "textures">,
  options: DeepBakeOptions = {}): DeepBakeResult {
  const quality = options.quality ?? "balanced";
  if (quality !== "performance" && quality !== "balanced" && quality !== "quality") throw new RangeError("Invalid bake quality.");
  const recipeVersion = options.recipeVersion ?? "deep-bake-v1";
  if (typeof recipeVersion !== "string" || recipeVersion.length < 1 || recipeVersion.length > 128) throw new RangeError("Invalid bake recipe version.");
  const geometries = Object.freeze(packet.geometries.map(geometry => bakeGeometry(geometry, MESHLET_TARGETS[quality])));
  const geometryPlans = Object.freeze(geometries.map(value => Object.freeze({ id: value.id, sourceHash: value.sourceHash,
    meshletHash: value.meshletHash, vertexCount: value.meshlets.sourceVertexCount, triangleCount: value.meshlets.sourceTriangleCount,
    meshletCount: value.meshlets.meshletCount, expandedIndexCount: value.indices.indices.length })));
  const materialVariantKeys = Object.freeze([...new Set(packet.materials.map(materialVariantKey))]);
  const textureIds = Object.freeze([...new Set((packet.textures ?? []).map(value => value.id))].sort());
  const sourceHash = hashStrings([recipeVersion, quality, ...geometries.map(value => `${value.id}:${value.revision}:${value.sourceHash}:${value.meshletHash}`),
    ...materialVariantKeys, ...textureIds]);
  return Object.freeze({ schemaVersion: DEEP_BAKE_SCHEMA_VERSION, quality, recipeVersion, sourceHash,
    cacheKey: `deep.bake.v${DEEP_BAKE_SCHEMA_VERSION}:${sourceHash}`, geometries, geometryPlans, materialVariantKeys, textureIds,
    staticLighting: "probe-hybrid" });
}

function bakeGeometry(geometry: GeometryResource, target: Readonly<{ maxVertices: number; maxTriangles: number }>): DeepBakedGeometry {
  if (geometry.vertices.length % 6 !== 0) throw new RangeError(`Geometry ${geometry.id} vertex stride must be six floats.`);
  const positions = new Float32Array(geometry.vertices.length / 2);
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
    const source = vertex * 6, targetOffset = vertex * 3;
    positions[targetOffset] = geometry.vertices[source]!;
    positions[targetOffset + 1] = geometry.vertices[source + 1]!;
    positions[targetOffset + 2] = geometry.vertices[source + 2]!;
  }
  const meshlets = buildMeshlets({ positions, indices: geometry.indices }, target);
  const indices = expandMeshletIndices(meshlets);
  const sourceHash = hashTypedArrays(geometry.vertices, geometry.indices);
  return Object.freeze({ id: geometry.id, revision: geometry.revision, sourceHash, meshletHash: hashMeshletBuild(meshlets), meshlets, indices });
}

function materialVariantKey(material: PbrMaterial): string {
  return [material.id, material.alphaMode ?? "OPAQUE", material.doubleSided ? "double" : "single",
    // 仅在 BLEND + premultiplied 时出现该段：旧包(字段缺省)的 variant key 字节不变。
    ...(material.alphaMode === "BLEND" && material.premultipliedAlpha === true ? ["premultiplied"] : []),
    material.baseColorTexture ? "base" : "no-base", material.metallicRoughnessTexture ? "mr" : "no-mr",
    material.normalTexture ? "normal" : "no-normal", material.occlusionTexture ? "ao" : "no-ao",
    material.emissiveTexture ? "emissive" : "no-emissive"].join("|");
}

function hashTypedArrays(vertices: Float32Array, indices: Uint32Array): string {
  const values: string[] = [String(vertices.length), String(indices.length)];
  for (const value of vertices) values.push(numberBits(value));
  for (const value of indices) values.push(String(value));
  return hashStrings(values);
}

function numberBits(value: number): string {
  const buffer = new ArrayBuffer(4), view = new DataView(buffer); view.setFloat32(0, value, true); return view.getUint32(0, true).toString(16);
}

function hashStrings(values: readonly string[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const value of values) for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index)); hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

export { MESHLET_DEFAULTS };
