import type { GeometryResource, PbrMaterial } from "../renderPacket.js";
import { AccessorReader } from "./accessors.js";
import { readEmissiveStrength } from "./materialExtensions.js";
import { generateNormals } from "./generatedNormals.js";
import { validateTangentBasis } from "./tangentSpace.js";
import { MAX_BYTES, budget, factor, invalid, list, noExtensions, object, reference, unsupported, vector } from "./validation.js";

export interface MeshPrimitive { readonly geometry: string; readonly material: string }
export function materialResource(value: unknown, index: number, prefix: string, extensions: ReadonlySet<string> = new Set()): PbrMaterial {
  const path = `materials[${index}]`, material = object(value, path);
  const emissiveStrength = readEmissiveStrength(material, path, extensions);
  const alphaMode = material.alphaMode === undefined ? "OPAQUE" : material.alphaMode;
  if (alphaMode !== "OPAQUE" && alphaMode !== "MASK" && alphaMode !== "BLEND") invalid(`${path}.alphaMode`, "Expected OPAQUE, MASK or BLEND.");
  const alphaCutoff = material.alphaCutoff === undefined ? 0.5 : material.alphaCutoff;
  if (typeof alphaCutoff !== "number" || !Number.isFinite(alphaCutoff) || alphaCutoff < 0 || !Number.isFinite(Math.fround(alphaCutoff))) {
    invalid(`${path}.alphaCutoff`, "Expected a nonnegative finite float32 value.");
  }
  if (material.doubleSided !== undefined && typeof material.doubleSided !== "boolean") invalid(path, "doubleSided must be boolean.");
  for (const field of ["normalTexture", "occlusionTexture", "emissiveTexture"]) {
    if (material[field] !== undefined) unsupported(`${path}.${field}`, "textures");
  }
  const emissive = vector(material.emissiveFactor === undefined ? [0, 0, 0] : material.emissiveFactor, 3, `${path}.emissiveFactor`);
  emissive.forEach(value => factor(value, `${path}.emissiveFactor`));
  const pbr = object(material.pbrMetallicRoughness === undefined ? {} : material.pbrMetallicRoughness, `${path}.pbrMetallicRoughness`);
  noExtensions(pbr, `${path}.pbrMetallicRoughness`);
  for (const field of ["baseColorTexture", "metallicRoughnessTexture"]) if (pbr[field] !== undefined) unsupported(`${path}.${field}`, "textures");
  const color = vector(pbr.baseColorFactor === undefined ? [1, 1, 1, 1] : pbr.baseColorFactor, 4, `${path}.baseColorFactor`);
  color.forEach(value => factor(value, `${path}.baseColorFactor`));
  // factor 本身是线性的，不再次做 sRGB 解码；OPAQUE 按 glTF 明确忽略 alpha 覆盖率。
  return { id: `${prefix}/material/${index}`, baseColor: [color[0]!, color[1]!, color[2]!],
    ...(alphaMode === "OPAQUE" ? {} : { baseColorAlpha: color[3]!, alphaMode }),
    ...(emissive.some(value => value !== 0) ? { emissiveFactor: [emissive[0]!, emissive[1]!, emissive[2]!] as const } : {}),
    ...(emissiveStrength !== undefined && emissiveStrength !== 1 ? { emissiveStrength } : {}),
    ...(alphaMode === "MASK" ? { alphaCutoff } : {}),
    metallic: factor(pbr.metallicFactor === undefined ? 1 : pbr.metallicFactor, `${path}.metallicFactor`),
    roughness: factor(pbr.roughnessFactor === undefined ? 1 : pbr.roughnessFactor, `${path}.roughnessFactor`),
    ...(material.doubleSided === true ? { doubleSided: true } : {}) };
}

export function meshResources(source: readonly unknown[], materials: readonly PbrMaterial[], reader: AccessorReader, prefix: string): {
  geometries: GeometryResource[]; meshes: MeshPrimitive[][];
} {
  const geometries: GeometryResource[] = [];
  let bytes = 0;
  const meshes = source.map((value, meshIndex) => {
    const path = `meshes[${meshIndex}]`, mesh = object(value, path);
    noExtensions(mesh, path);
    if (mesh.weights !== undefined) unsupported(`${path}.weights`, "morph targets");
    const primitives = list(mesh.primitives, `${path}.primitives`, 4096);
    if (!primitives.length) invalid(path, "Mesh needs at least one primitive.");
    return primitives.map((value, primitiveIndex) => {
      const location = `${path}.primitives[${primitiveIndex}]`, primitive = object(value, location);
      noExtensions(primitive, location);
      if (primitive.mode !== undefined && primitive.mode !== 4) unsupported(`${location}.mode`, "non-triangle topology");
      if (primitive.targets !== undefined) unsupported(`${location}.targets`, "morph targets");
      const attributes = object(primitive.attributes, `${location}.attributes`);
      for (const attribute of Object.keys(attributes)) {
        if (attribute !== "POSITION" && attribute !== "NORMAL" && attribute !== "TANGENT") {
          unsupported(`${location}.attributes.${attribute}`, `vertex attribute ${attribute}`);
        }
      }
      if (attributes.POSITION === undefined) unsupported(`${location}.attributes`, "geometry without POSITION");
      const position = reader.read(attributes.POSITION, "vertex", `${location}.attributes.POSITION`);
      const normal = attributes.NORMAL === undefined ? undefined
        : reader.read(attributes.NORMAL, "vertex", `${location}.attributes.NORMAL`);
      const tangent = attributes.TANGENT === undefined ? undefined
        : reader.read(attributes.TANGENT, "tangent", `${location}.attributes.TANGENT`);
      if (normal && position.count !== normal.count) invalid(location, "Attribute counts differ.");
      if (tangent && position.count !== tangent.count) invalid(location, "POSITION and TANGENT counts differ.");
      const sourceIndices = primitive.indices === undefined ? undefined : reader.read(primitive.indices, "indices", `${location}.indices`);
      const indexCount = sourceIndices?.count ?? position.count;
      if (indexCount % 3) invalid(location, "Triangle index count must be a multiple of three.");
      bytes += position.count * 24 + indexCount * 4 + (tangent?.values.byteLength ?? 0);
      budget(bytes, MAX_BYTES, "geometries");
      budget(geometries.length + 1, 4096, "geometries");
      const vertices = new Float32Array(position.count * 6), indices = new Uint32Array(indexCount);
      for (let index = 0; index < indexCount; index++) {
        const value = sourceIndices?.values[index] ?? index;
        if (value >= position.count) invalid(`${location}.indices`, "Index exceeds vertex count.");
        indices[index] = value;
      }
      const normals = normal?.values ?? generateNormals(position.values as Float32Array, indices, `${location}.attributes.NORMAL`);
      for (let vertex = 0; vertex < position.count; vertex++) {
        if (Math.hypot(...normals.subarray(vertex * 3, vertex * 3 + 3)) < 1e-8) invalid(location, "Vertex normal is zero.");
        vertices.set(position.values.subarray(vertex * 3, vertex * 3 + 3), vertex * 6);
        vertices.set(normals.subarray(vertex * 3, vertex * 3 + 3), vertex * 6 + 3);
      }
      const tangents = tangent?.values as Float32Array<ArrayBuffer> | undefined;
      if (tangents) validateTangentBasis(vertices, tangents, indices, `${location}.attributes.TANGENT`);
      const geometry = `${prefix}/mesh/${meshIndex}/primitive/${primitiveIndex}`;
      const material = primitive.material === undefined ? `${prefix}/material/default`
        : materials[reference(materials, primitive.material, `${location}.material`)]!.id;
      geometries.push({ id: geometry, revision: 0, vertices, indices, ...(tangents ? { tangents } : {}) });
      return { geometry, material };
    });
  });
  return { geometries, meshes };
}
