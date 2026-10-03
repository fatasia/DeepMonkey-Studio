import type { GeometryResource, PbrMaterial, RenderPacket, TextureSlot } from "../renderPacket.js";
import { decodeGltf, type GltfImportOptions } from "./decodeGltf.js";
import { decodeGltfTextureManifest } from "./textureDecode.js";
import { extractGltfTextureManifest } from "./textureManifest.js";
import { KHR_MATERIALS_EMISSIVE_STRENGTH, SCALAR_MATERIAL_EXTENSIONS } from "./materialExtensions.js";
import { mapGltfMaterialExtensions } from "../shader/materialGltfMap.js";
import { isDefaultExtendedMaterialParameters } from "../shader/materialParameters.js";
import type { CapabilityFailure } from "./capabilityInventory.js";
import { projectOptionalMaterialFallbacks, projectThirdPartyMaterialProfile, type GltfOptionalMaterialFallback } from "./optionalMaterialFallback.js";
import type { GltfImageDecoder, GltfTextureDecodeOptions, GltfTextureManifest, GltfTextureSlot } from "./textureTypes.js";
import { generateTangents, validateTangentBasis } from "./tangentSpace.js";
import { GltfImportError, list, object, unsupported, type JsonObject } from "./validation.js";

export interface TexturedGltfImportOptions extends GltfImportOptions, GltfTextureDecodeOptions {
  /** Optional material extensions to render through their authored core glTF fallback. */
  readonly optionalMaterialFallbacks?: readonly GltfOptionalMaterialFallback[];
}

function textureSlot(slot: GltfTextureSlot): TextureSlot {
  return { texture: slot.texture, texCoord: slot.texCoord, offset: [slot.offset[0], slot.offset[1]],
    scale: [slot.scale[0], slot.scale[1]], rotation: slot.rotation };
}

/** 纹理 manifest 验证并取得纹理字段所有权后，为严格几何解码器构建隔离文档。 */
function geometryDocument(json: unknown, manifest: GltfTextureManifest, handledDeformations: boolean): JsonObject {
  const document = object(json, "$"), result: JsonObject = { ...document };
  for (const field of ["extensionsUsed", "extensionsRequired"] as const) if (list(document[field], field).length) {
    const retained = list(document[field], field).filter(name => SCALAR_MATERIAL_EXTENSIONS.has(name as string));
    if (retained.length) result[field] = retained; else delete result[field];
  }
  if (list(document.images, "images").length) delete result.images;
  if (list(document.textures, "textures").length) delete result.textures;
  if (handledDeformations) {
    delete result.animations; delete result.skins;
    if (document.nodes !== undefined) result.nodes = list(document.nodes, "nodes").map((value, index) => {
      const node: JsonObject = { ...object(value, `nodes[${index}]`) };
      delete node.skin; delete node.weights; return node;
    });
  }

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
    const key = `${uv.meshIndex}:${uv.primitiveIndex}`;
    uvPrimitives.set(key, [...(uvPrimitives.get(key) ?? []), uv]);
  }
  const uvAccessors = new Set<number>();
  if (document.meshes !== undefined) {
    result.meshes = list(document.meshes, "meshes", 4096).map((value, meshIndex) => {
      const source = object(value, `meshes[${meshIndex}]`), mesh: JsonObject = { ...source };
      mesh.primitives = list(source.primitives, `meshes[${meshIndex}].primitives`, 4096).map((value, primitiveIndex) => {
        const textureData = uvPrimitives.get(`${meshIndex}:${primitiveIndex}`);
        const path = `meshes[${meshIndex}].primitives[${primitiveIndex}]`;
        const sourcePrimitive = object(value, path), attributes = object(sourcePrimitive.attributes, `${path}.attributes`);
        const geometryAttributes: JsonObject = { ...attributes };
        // The texture layer owns both core UV attributes. Geometry decode receives only position/TBN data.
        delete geometryAttributes.TEXCOORD_0; delete geometryAttributes.TEXCOORD_1;
        // N5: normal-mapped primitives receive their tangent basis through the manifest layer (authored
        // copy or geometric generation); the strict geometry decoder must not hard-reject unusable tangents.
        if (textureData?.some(uv => uv.requiresTangents)) delete geometryAttributes.TANGENT;
        if (handledDeformations) {
          for (const name of Object.keys(geometryAttributes)) {
            if (name.startsWith("JOINTS_") || name.startsWith("WEIGHTS_")) delete geometryAttributes[name];
          }
        }
        for (const uv of textureData ?? []) {
          const attribute = `TEXCOORD_${uv.texCoord}`;
          uvAccessors.add(attributes[attribute] as number); delete geometryAttributes[attribute];
        }
        const primitive: JsonObject = { ...sourcePrimitive, attributes: geometryAttributes };
        if (handledDeformations) delete primitive.targets;
        return primitive;
      });
      if (handledDeformations) delete mesh.weights;
      return mesh;
    });
  }
  if (uvAccessors.size && document.accessors !== undefined) {
    result.accessors = list(document.accessors, "accessors").map((value, index) => {
      if (!uvAccessors.has(index)) return value;
      const accessor: JsonObject = { ...object(value, `accessors[${index}]`) };
      if (accessor.normalized === true) delete accessor.normalized;
      return accessor;
    });
  }
  return result;
}

function attachManifest(packet: RenderPacket, manifest: GltfTextureManifest, sourceDocument: JsonObject,
): Pick<RenderPacket, "geometries" | "materials"> & { losses: CapabilityFailure[] } {
  const losses: CapabilityFailure[] = [];
  const materialIndexByPrimitive = new Map<string, number>();
  if (sourceDocument.meshes !== undefined) {
    list(sourceDocument.meshes, "meshes", 4096).forEach((value, meshIndex) => {
      const path = `meshes[${meshIndex}]`;
      list(object(value, path).primitives, `${path}.primitives`, 4096).forEach((primitive, primitiveIndex) => {
        const material = object(primitive, `${path}.primitives[${primitiveIndex}]`).material;
        if (typeof material === "number") materialIndexByPrimitive.set(`${meshIndex}:${primitiveIndex}`, material);
      });
    });
  }
  const uvByGeometry = new Map<string, typeof manifest.uvSets>();
  for (const uv of manifest.uvSets) uvByGeometry.set(uv.geometry, [...(uvByGeometry.get(uv.geometry) ?? []), uv]);
  /** Normal maps whose tangent basis could not be delivered; keyed by manifest material id. */
  const undeliverableNormalMaterials = new Map<string, string>();
  const geometries: GeometryResource[] = packet.geometries.map(geometry => {
    const coordinates = uvByGeometry.get(geometry.id);
    if (!coordinates) return geometry;
    const normalCoordinates = coordinates.find(uv => uv.requiresTangents);
    let tangents = normalCoordinates?.tangents?.slice();
    if (normalCoordinates) {
      const tangentPath = `meshes[${normalCoordinates.meshIndex}].primitives[${normalCoordinates.primitiveIndex}].attributes.TANGENT`;
      try {
        tangents ??= generateTangents(geometry.vertices, normalCoordinates.values, geometry.indices, tangentPath);
        validateTangentBasis(geometry.vertices, tangents, geometry.indices, tangentPath);
      } catch (error) {
        // N5: mirrored/degenerate UVs make a tangent basis undeliverable; degrade instead of rejecting.
        if (!(error instanceof GltfImportError)) throw error;
        tangents = undefined;
        const materialIndex = materialIndexByPrimitive.get(`${normalCoordinates.meshIndex}:${normalCoordinates.primitiveIndex}`);
        const materialId = manifest.materials.find(entry => entry.materialIndex === materialIndex)?.id;
        if (materialId !== undefined) undeliverableNormalMaterials.set(materialId, `${error.path}: ${error.message}`);
      }
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
    if (undeliverableNormalMaterials.has(material.id) && textured.normalTexture !== undefined) {
      losses.push({ code: "material-normal-tangents-undeliverable", stage: "material",
        assetPath: `materials[${textured.materialIndex}].normalTexture`, count: 1,
        detail: `法线贴图的切线基不可交付（${undeliverableNormalMaterials.get(material.id)}）；已降级为无该法线贴图渲染并如实登记，资产保持可渲染。` });
      return { ...material,
        ...(textured.baseColorTexture ? { baseColorTexture: textureSlot(textured.baseColorTexture) } : {}),
        ...(textured.metallicRoughnessTexture ? { metallicRoughnessTexture: textureSlot(textured.metallicRoughnessTexture) } : {}),
        ...(textured.occlusionTexture ? { occlusionTexture: { ...textureSlot(textured.occlusionTexture), strength: textured.occlusionTexture.strength } } : {}),
        ...(textured.emissiveTexture ? { emissiveTexture: textureSlot(textured.emissiveTexture) } : {}),
        ...(textured.emissiveStrength !== undefined ? { emissiveStrength: textured.emissiveStrength } : {}) };
    }
    return { ...material,
      ...(textured.baseColorTexture ? { baseColorTexture: textureSlot(textured.baseColorTexture) } : {}),
      ...(textured.metallicRoughnessTexture ? { metallicRoughnessTexture: textureSlot(textured.metallicRoughnessTexture) } : {}),
      ...(textured.normalTexture ? { normalTexture: { ...textureSlot(textured.normalTexture), normalScale: textured.normalTexture.normalScale } } : {}),
      ...(textured.occlusionTexture ? { occlusionTexture: { ...textureSlot(textured.occlusionTexture), strength: textured.occlusionTexture.strength } } : {}),
      ...(textured.emissiveTexture ? { emissiveTexture: textureSlot(textured.emissiveTexture) } : {}),
      ...(textured.emissiveStrength !== undefined ? { emissiveStrength: textured.emissiveStrength } : {}) };
  });
  return { geometries, materials, losses };
}

/** 从调用者持有的 buffer 导入静态纹理 glTF；函数自身不发起外部 IO。 */
export async function decodeTexturedGltf(json: unknown, buffers: readonly Uint8Array[], imageDecoder: GltfImageDecoder | undefined,
  options: TexturedGltfImportOptions = {}): Promise<RenderPacket> {
  return await decodeTexturedGltfDocument(json, buffers, imageDecoder, options, false);
}

/** Internal composite-import entry; handled deformation fields stay strict in the public standalone importer. */
export async function decodeTexturedGltfDocument(json: unknown, buffers: readonly Uint8Array[], imageDecoder: GltfImageDecoder | undefined,
  options: TexturedGltfImportOptions, handledDeformations: boolean): Promise<RenderPacket> {
  object(options, "options"); options.signal?.throwIfAborted();
  // N5: explicit opt-in projection stays loss-silent (the caller chose the fallback); without it the
  // zero-config third-party profile projects known-fallback and unknown material extensions with
  // per-material losses instead of rejecting the asset.
  const projected = options.optionalMaterialFallbacks !== undefined
    ? { document: projectOptionalMaterialFallbacks(json, options.optionalMaterialFallbacks), losses: [] as CapabilityFailure[] }
    : projectThirdPartyMaterialProfile(json);
  const fallbackDocument = projected.document;
  const manifest = extractGltfTextureManifest(fallbackDocument, buffers, {
    ...(options.resourcePrefix === undefined ? {} : { resourcePrefix: options.resourcePrefix }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.maxBytes === undefined ? {} : { maxImageBytes: options.maxBytes }),
  });
  const packet = decodeGltf(geometryDocument(fallbackDocument, manifest, handledDeformations), buffers,
    { ...options, materialLosses: [] });
  const attached = attachManifest(packet, manifest, object(fallbackDocument, "$"));
  const document = object(fallbackDocument, "$"), sourceMaterials = list(document.materials, "materials", 16_383);
  const losses: CapabilityFailure[] = [...projected.losses];
  const materialPrefix = `${options.resourcePrefix ?? "gltf"}/material/`;
  const materials = attached.materials.map((material) => {
    const index = material.id.startsWith(materialPrefix) ? Number(material.id.slice(materialPrefix.length)) : -1;
    if (!Number.isSafeInteger(index) || index < 0 || index >= sourceMaterials.length) return material;
    const mapped = mapGltfMaterialExtensions(sourceMaterials[index], `materials[${index}]`, { failClosed: true });
    losses.push(...mapped.losses);
    if (isDefaultExtendedMaterialParameters(mapped.params)) return material;
    if (!material.baseColorTexture && !material.metallicRoughnessTexture && !material.normalTexture
      && !material.occlusionTexture && !material.emissiveTexture) {
      losses.push({ code: "material-profile-unsupported", stage: "material", assetPath: `materials[${index}]`, count: 1,
        detail: "该材质无核心纹理，默认 plain PBR 不支持扩展 lobe；保留原材质与已支持 IOR，导入带纹理资产或保持 glTF core 回退。" });
      return material;
    }
    return { ...material, extendedParameters: mapped.params };
  });
  const textures = await decodeGltfTextureManifest(manifest, imageDecoder, options);
  options.signal?.throwIfAborted();
  const { geometries, materials: attachedMaterials, losses: attachedLosses } = attached;
  losses.push(...attachedLosses);
  return { ...packet, geometries, materials, ...(losses.length ? { materialLosses: losses } : {}), textures };
}
