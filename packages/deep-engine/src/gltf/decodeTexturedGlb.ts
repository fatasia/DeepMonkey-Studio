import type { GeometryResource, PbrMaterial, RenderPacket, TextureSlot } from "../renderPacket.js";
import { decodeGltf, type GltfImportOptions } from "./decodeGltf.js";
import { parseGlb } from "./parseGlb.js";
import { decodeGltfTextureManifest } from "./textureDecode.js";
import { extractGltfTextureManifest } from "./textureManifest.js";
import { KHR_MATERIALS_EMISSIVE_STRENGTH } from "./materialExtensions.js";
import type { GltfImageDecoder, GltfTextureDecodeOptions, GltfTextureManifest, GltfTextureSlot } from "./textureTypes.js";
import { generateTangents, validateTangentBasis } from "./tangentSpace.js";
import { list, object, unsupported, type JsonObject } from "./validation.js";

export interface TexturedGlbImportOptions extends GltfImportOptions, GltfTextureDecodeOptions {}

function textureSlot(slot: GltfTextureSlot): TextureSlot {
  return {
    texture: slot.texture,
    texCoord: slot.texCoord,
    offset: [slot.offset[0], slot.offset[1]],
    scale: [slot.scale[0], slot.scale[1]],
    rotation: slot.rotation,
  };
}

/**
 * 创建只供静态几何解码器消费的浅层文档副本。这里仅移除已被纹理 manifest 严格验证的字段；
 * alpha、双面和 authored TANGENT 等 core 字段仍保留并由 decodeGltf 严格导入；动画、未知扩展及额外顶点属性继续明确拒绝。
 */
function geometryDocument(json: unknown, manifest: GltfTextureManifest): JsonObject {
  const document = object(json, "$"), result: JsonObject = { ...document };
  for (const field of ["extensionsUsed", "extensionsRequired"] as const) {
    if (list(document[field], field).length) delete result[field];
  }
  if (list(document.images, "images").length) delete result.images;
  if (list(document.textures, "textures").length) delete result.textures;

  const texturedMaterials = new Map(manifest.materials.map(material => [material.materialIndex, material]));
  if (document.materials !== undefined) {
    result.materials = list(document.materials, "materials", 16_383).map((value, index) => {
      const source = object(value, `materials[${index}]`), material: JsonObject = { ...source };
      const validated = texturedMaterials.get(index);
      if (validated?.emissiveStrength !== undefined && source.extensions !== undefined) {
        const extensions = { ...object(source.extensions, `materials[${index}].extensions`) };
        delete extensions[KHR_MATERIALS_EMISSIVE_STRENGTH];
        if (Object.keys(extensions).length) material.extensions = extensions;
        else delete material.extensions;
      }
      if (source.pbrMetallicRoughness !== undefined) {
        const pbrSource = object(source.pbrMetallicRoughness, `materials[${index}].pbrMetallicRoughness`);
        const pbr: JsonObject = { ...pbrSource };
        if (validated?.baseColorTexture) delete pbr.baseColorTexture;
        if (validated?.metallicRoughnessTexture) delete pbr.metallicRoughnessTexture;
        material.pbrMetallicRoughness = pbr;
      }
      if (validated?.normalTexture) delete material.normalTexture;
      if (validated?.occlusionTexture) delete material.occlusionTexture;
      if (validated?.emissiveTexture) delete material.emissiveTexture;
      return material;
    });
  }

  const uvPrimitives = new Map<string, typeof manifest.uvSets>();
  for (const uv of manifest.uvSets) {
    const key = `${uv.meshIndex}:${uv.primitiveIndex}`, current = uvPrimitives.get(key) ?? [];
    uvPrimitives.set(key, [...current, uv]);
  }
  const uvAccessors = new Set<number>();
  if (document.meshes !== undefined) {
    result.meshes = list(document.meshes, "meshes", 4096).map((value, meshIndex) => {
      const source = object(value, `meshes[${meshIndex}]`), mesh: JsonObject = { ...source };
      mesh.primitives = list(source.primitives, `meshes[${meshIndex}].primitives`, 4096).map((value, primitiveIndex) => {
        const textureData = uvPrimitives.get(`${meshIndex}:${primitiveIndex}`);
        if (!textureData) return value;
        const path = `meshes[${meshIndex}].primitives[${primitiveIndex}]`;
        const sourcePrimitive = object(value, path), attributes = object(sourcePrimitive.attributes, `${path}.attributes`);
        const geometryAttributes: JsonObject = { ...attributes };
        for (const uv of textureData) {
          const attribute = `TEXCOORD_${uv.texCoord}`;
          uvAccessors.add(attributes[attribute] as number);
          delete geometryAttributes[attribute];
        }
        return { ...sourcePrimitive, attributes: geometryAttributes };
      });
      return mesh;
    });
  }

  if (uvAccessors.size && document.accessors !== undefined) {
    result.accessors = list(document.accessors, "accessors").map((value, index) => {
      if (!uvAccessors.has(index)) return value;
      const accessor: JsonObject = { ...object(value, `accessors[${index}]`) };
      // normalized U8/U16 UV 已由 TextureDataReader 展开；静态几何 reader 不消费该 accessor。
      if (accessor.normalized === true) delete accessor.normalized;
      return accessor;
    });
  }
  return result;
}

function attachManifest(packet: RenderPacket, manifest: GltfTextureManifest): Pick<RenderPacket, "geometries" | "materials"> {
  const uvByGeometry = new Map<string, typeof manifest.uvSets>();
  for (const uv of manifest.uvSets) uvByGeometry.set(uv.geometry, [...(uvByGeometry.get(uv.geometry) ?? []), uv]);
  const geometries: GeometryResource[] = packet.geometries.map(geometry => {
    const coordinates = uvByGeometry.get(geometry.id);
    if (!coordinates) return geometry;
    const normalCoordinates = coordinates.find(uv => uv.requiresTangents);
    let tangents = normalCoordinates?.tangents?.slice();
    if (normalCoordinates) {
      const tangentPath = `meshes[${normalCoordinates.meshIndex}].primitives[${normalCoordinates.primitiveIndex}].attributes.TANGENT`;
      tangents ??= generateTangents(geometry.vertices, normalCoordinates.values, geometry.indices, tangentPath);
      validateTangentBasis(geometry.vertices, tangents, geometry.indices, tangentPath);
    }
    const uv0 = coordinates.find(uv => uv.texCoord === 0), uv1 = coordinates.find(uv => uv.texCoord === 1);
    return { ...geometry, ...(uv0 ? { uv0: uv0.values.slice() } : {}), ...(uv1 ? { uv1: uv1.values.slice() } : {}),
      ...(tangents ? { tangents } : {}) };
  });
  const knownGeometry = new Set(geometries.map(geometry => geometry.id));
  for (const id of uvByGeometry.keys()) if (!knownGeometry.has(id)) unsupported(id, "texture coordinates without decoded geometry");

  const textureByMaterial = new Map(manifest.materials.map(material => [material.id, material]));
  const materials: PbrMaterial[] = packet.materials.map(material => {
    const textured = textureByMaterial.get(material.id);
    if (!textured) return material;
    return {
      ...material,
      ...(textured.baseColorTexture ? { baseColorTexture: textureSlot(textured.baseColorTexture) } : {}),
      ...(textured.metallicRoughnessTexture ? { metallicRoughnessTexture: textureSlot(textured.metallicRoughnessTexture) } : {}),
      ...(textured.normalTexture ? { normalTexture: { ...textureSlot(textured.normalTexture), normalScale: textured.normalTexture.normalScale } } : {}),
      ...(textured.occlusionTexture ? { occlusionTexture: { ...textureSlot(textured.occlusionTexture), strength: textured.occlusionTexture.strength } } : {}),
      ...(textured.emissiveTexture ? { emissiveTexture: textureSlot(textured.emissiveTexture) } : {}),
      ...(textured.emissiveStrength !== undefined ? { emissiveStrength: textured.emissiveStrength } : {}),
    };
  });
  return { geometries, materials };
}

/** 静态 PBR 纹理 GLB 导入；PNG/JPEG 解码按需由宿主注入，纯 KTX2 包可省略它。 */
export async function decodeTexturedGlb(bytes: Uint8Array, imageDecoder: GltfImageDecoder | undefined,
  options: TexturedGlbImportOptions = {}): Promise<RenderPacket> {
  object(options, "options");
  options.signal?.throwIfAborted();
  const parsed = parseGlb(bytes);
  const manifest = extractGltfTextureManifest(parsed.json, parsed.buffers,
    { ...(options.resourcePrefix === undefined ? {} : { resourcePrefix: options.resourcePrefix }),
      ...(options.signal === undefined ? {} : { signal: options.signal }) });

  const packet = decodeGltf(geometryDocument(parsed.json, manifest), parsed.buffers, options);
  const attached = attachManifest(packet, manifest);
  const textures = await decodeGltfTextureManifest(manifest, imageDecoder, options);
  options.signal?.throwIfAborted();
  return { ...packet, ...attached, textures };
}
