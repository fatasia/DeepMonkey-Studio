import type { TextureSampler, TextureSemantic } from "../textures/decodedTexture.js";
import { TextureDataReader } from "./textureDataReader.js";
import { decodeImageDataUri } from "./textureDataUri.js";
import {
  KHR_MATERIALS_EMISSIVE_STRENGTH, readEmissiveStrength, validateExtensionSets,
} from "./materialExtensions.js";
import type { GltfEncodedImage, GltfNormalTextureSlot, GltfOcclusionTextureSlot, GltfTextureManifest, GltfTextureResource, GltfTextureSlot } from "./textureTypes.js";
import { MAX_BYTES, budget, integer, invalid, list, noExtensions, object, reference, unsupported, validateJson, vector, type JsonObject } from "./validation.js";

const TRANSFORM = "KHR_texture_transform";
const BASISU = "KHR_texture_basisu";
const defaultSampler: Required<TextureSampler> = { addressModeU: "repeat", addressModeV: "repeat",
  magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 1 };

export interface GltfTextureManifestOptions {
  readonly resourcePrefix?: string;
  readonly signal?: AbortSignal;
  /** 此 manifest 最多保留的编码图像总字节数。 */
  readonly maxImageBytes?: number;
}

/** KHR_texture_transform 的列主序 T*R*S 3×3 矩阵；glTF UV 原点保持左上，不翻转 V。 */
export function gltfTextureTransformMatrix(slot: Pick<GltfTextureSlot, "offset" | "scale" | "rotation">): Float32Array<ArrayBuffer> {
  const cosine = Math.cos(slot.rotation), sine = Math.sin(slot.rotation);
  return new Float32Array([
    cosine * slot.scale[0], sine * slot.scale[0], 0,
    -sine * slot.scale[1], cosine * slot.scale[1], 0,
    slot.offset[0], slot.offset[1], 1,
  ]);
}

function address(value: unknown, path: string): Required<TextureSampler>["addressModeU"] {
  const modes = { 33071: "clamp-to-edge", 33648: "mirror-repeat", 10497: "repeat" } as const;
  const result = modes[value as keyof typeof modes];
  if (!result) invalid(path, "Unknown texture wrap mode.");
  return result;
}

function sampler(value: unknown, index: number): Required<TextureSampler> {
  const path = `samplers[${index}]`, source = object(value, path); noExtensions(source, path);
  const result = { ...defaultSampler };
  if (source.wrapS !== undefined) result.addressModeU = address(source.wrapS, `${path}.wrapS`);
  if (source.wrapT !== undefined) result.addressModeV = address(source.wrapT, `${path}.wrapT`);
  if (source.magFilter !== undefined) {
    if (source.magFilter !== 9728 && source.magFilter !== 9729) invalid(`${path}.magFilter`, "Unknown magnification filter.");
    result.magFilter = source.magFilter === 9728 ? "nearest" : "linear";
  }
  if (source.minFilter !== undefined) {
    const filters: Record<number, readonly ["nearest" | "linear", "nearest" | "linear"]> = {
      9728: ["nearest", "nearest"], 9729: ["linear", "nearest"], 9984: ["nearest", "nearest"],
      9985: ["linear", "nearest"], 9986: ["nearest", "linear"], 9987: ["linear", "linear"],
    };
    const found = filters[source.minFilter as number];
    if (!found) invalid(`${path}.minFilter`, "Unknown minification filter.");
    [result.minFilter, result.mipmapFilter] = found;
  }
  return result;
}

function encodedImages(document: JsonObject, reader: TextureDataReader, prefix: string, maxBytes: number,
  signal?: AbortSignal): GltfEncodedImage[] {
  let bytes = 0;
  return list(document.images, "images", 4096).map((value, index) => {
    signal?.throwIfAborted();
    const path = `images[${index}]`, image = object(value, path); noExtensions(image, path);
    let mimeType: GltfEncodedImage["mimeType"], data: Uint8Array<ArrayBuffer>;
    if (image.uri !== undefined) {
      if (image.bufferView !== undefined) invalid(path, "Image URI and bufferView are mutually exclusive.");
      if (typeof image.uri !== "string") invalid(`${path}.uri`, "Image URI must be a string.");
      const embedded = decodeImageDataUri(image.uri, `${path}.uri`, maxBytes - bytes, signal);
      if (image.mimeType !== undefined && image.mimeType !== embedded.mimeType) invalid(`${path}.mimeType`, "Image MIME type does not match its Data URI.");
      mimeType = embedded.mimeType; data = embedded.data;
    } else {
      if (image.bufferView === undefined) invalid(`${path}.bufferView`, "Embedded images require a bufferView or Data URI.");
      if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg" && image.mimeType !== "image/ktx2") unsupported(`${path}.mimeType`, "image MIME type");
      mimeType = image.mimeType;
      data = reader.imageBytes(image.bufferView, `${path}.bufferView`, maxBytes - bytes);
    }
    bytes += data.byteLength;
    const png = data.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, offset) => data[offset] === byte);
    const jpeg = data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const ktx2 = data.length >= 12 && [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]
      .every((byte, offset) => data[offset] === byte);
    const signatureMatches = mimeType === "image/png" ? png : mimeType === "image/jpeg" ? jpeg : ktx2;
    if (!signatureMatches) invalid(path, `Encoded bytes do not match ${mimeType}.`);
    return { id: `${prefix}/image/${index}`, imageIndex: index, mimeType, data };
  });
}

function transform(info: JsonObject, path: string, used: ReadonlySet<string>): Omit<GltfTextureSlot, "texture"> {
  let texCoord = info.texCoord === undefined ? 0 : integer(info.texCoord, `${path}.texCoord`);
  let offset: readonly [number, number] = [0, 0], scale: readonly [number, number] = [1, 1], rotation = 0;
  if (info.extensions !== undefined) {
    const extensions = object(info.extensions, `${path}.extensions`), names = Object.keys(extensions);
    for (const name of names) if (name !== TRANSFORM) unsupported(`${path}.extensions.${name}`, `extension ${name}`);
    if (names.includes(TRANSFORM)) {
      if (!used.has(TRANSFORM)) invalid(`${path}.extensions.${TRANSFORM}`, `${TRANSFORM} must be declared in extensionsUsed.`);
      const value = object(extensions[TRANSFORM], `${path}.extensions.${TRANSFORM}`); noExtensions(value, `${path}.extensions.${TRANSFORM}`);
      if (value.offset !== undefined) offset = vector(value.offset, 2, `${path}.extensions.${TRANSFORM}.offset`) as [number, number];
      if (value.scale !== undefined) scale = vector(value.scale, 2, `${path}.extensions.${TRANSFORM}.scale`) as [number, number];
      if (value.rotation !== undefined) {
        if (typeof value.rotation !== "number" || !Number.isFinite(value.rotation)) invalid(`${path}.extensions.${TRANSFORM}.rotation`, "Expected a finite rotation.");
        rotation = value.rotation;
      }
      if (value.texCoord !== undefined) texCoord = integer(value.texCoord, `${path}.extensions.${TRANSFORM}.texCoord`);
    }
  }
  if (texCoord !== 0 && texCoord !== 1) unsupported(`${path}.texCoord`, `texture coordinate set ${String(texCoord)}`);
  return { texCoord, offset, scale, rotation };
}

/**
 * 提取 glTF 的嵌入图像、采样器、材质纹理槽及其实际引用的 UV0/UV1。PNG/JPEG 解码和 KTX2/BasisU 转码留给显式注入的宿主边界。
 */
export function extractGltfTextureManifest(json: unknown, buffers: readonly Uint8Array[], options: GltfTextureManifestOptions = {}): GltfTextureManifest {
  options?.signal?.throwIfAborted();
  validateJson(json); object(options, "options");
  const document = object(json, "$"), asset = object(document.asset, "asset");
  noExtensions(document, "$"); noExtensions(asset, "asset");
  if (asset.version !== "2.0") unsupported("asset.version", "glTF versions other than 2.0");
  if (asset.minVersion !== undefined && asset.minVersion !== "2.0") unsupported("asset.minVersion", "newer minimum glTF versions");
  const { used, required } = validateExtensionSets(document,
    new Set([TRANSFORM, BASISU, KHR_MATERIALS_EMISSIVE_STRENGTH]));
  const prefix = options.resourcePrefix === undefined ? "gltf" : options.resourcePrefix;
  if (typeof prefix !== "string" || !prefix.length || prefix.length > 256) invalid("options.resourcePrefix", "Expected a nonempty prefix of at most 256 characters.");
  const maxImageBytes = options.maxImageBytes ?? MAX_BYTES;
  if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1 || maxImageBytes > MAX_BYTES) {
    invalid("options.maxImageBytes", `Expected an integer in 1..${MAX_BYTES}.`);
  }
  const reader = new TextureDataReader(document, buffers, options.signal);
  const images = encodedImages(document, reader, prefix, maxImageBytes, options.signal);
  const samplers = list(document.samplers, "samplers", 4096).map(sampler);
  const textures = list(document.textures, "textures", 4096).map((value, index) => {
    const path = `textures[${index}]`, texture = object(value, path);
    let source: number, fallbackSource: number | undefined;
    if (texture.extensions === undefined) {
      source = reference(images, texture.source, `${path}.source`);
    } else {
      const extensions = object(texture.extensions, `${path}.extensions`), names = Object.keys(extensions);
      for (const name of names) if (name !== BASISU) unsupported(`${path}.extensions.${name}`, `extension ${name}`);
      if (!names.includes(BASISU)) source = reference(images, texture.source, `${path}.source`);
      else {
        if (!used.has(BASISU)) invalid(`${path}.extensions.${BASISU}`, `${BASISU} must be declared in extensionsUsed.`);
        const basis = object(extensions[BASISU], `${path}.extensions.${BASISU}`); noExtensions(basis, `${path}.extensions.${BASISU}`);
        source = reference(images, basis.source, `${path}.extensions.${BASISU}.source`);
        if (images[source]!.mimeType !== "image/ktx2") invalid(`${path}.extensions.${BASISU}.source`, "BasisU source must reference image/ktx2.");
        if (texture.source !== undefined) {
          const fallback = reference(images, texture.source, `${path}.source`);
          if (images[fallback]!.mimeType === "image/ktx2") invalid(`${path}.source`, "Core fallback source must be PNG or JPEG.");
          if (!required.has(BASISU)) fallbackSource = fallback;
        }
      }
    }
    const settings = texture.sampler === undefined ? { ...defaultSampler } : samplers[reference(samplers, texture.sampler, `${path}.sampler`)]!;
    return { source, ...(fallbackSource === undefined ? {} : { fallbackSource }), sampler: settings };
  });
  const resources: GltfTextureResource[] = [], resourceByKey = new Map<string, GltfTextureResource>();
  const textureSlot = (value: unknown, path: string, semantic: TextureSemantic): GltfTextureSlot => {
    const info = object(value, path), textureIndex = reference(textures, info.index, `${path}.index`), key = `${textureIndex}:${semantic}`;
    let resource = resourceByKey.get(key);
    if (!resource) {
      const texture = textures[textureIndex]!, image = images[texture.source]!;
      budget(resources.length + 1, 4096, "textures");
      resource = { id: `${prefix}/texture/${textureIndex}/${semantic}`, textureIndex, image: image.id,
        ...(texture.fallbackSource === undefined ? {} : { fallbackImage: images[texture.fallbackSource]!.id }),
        semantic, sampler: { ...texture.sampler } };
      resourceByKey.set(key, resource); resources.push(resource);
    }
    return { texture: resource.id, ...transform(info, path, used) };
  };
  const materials = list(document.materials, "materials", 16_383).map((value, materialIndex) => {
    const path = `materials[${materialIndex}]`, material = object(value, path);
    const emissiveStrength = readEmissiveStrength(material, path, used);
    const pbr = object(material.pbrMetallicRoughness === undefined ? {} : material.pbrMetallicRoughness, `${path}.pbrMetallicRoughness`);
    noExtensions(pbr, `${path}.pbrMetallicRoughness`);
    const baseColorTexture = pbr.baseColorTexture === undefined ? undefined : textureSlot(pbr.baseColorTexture, `${path}.pbrMetallicRoughness.baseColorTexture`, "baseColor");
    const metallicRoughnessTexture = pbr.metallicRoughnessTexture === undefined ? undefined
      : textureSlot(pbr.metallicRoughnessTexture, `${path}.pbrMetallicRoughness.metallicRoughnessTexture`, "metallicRoughness");
    let normalTexture: GltfNormalTextureSlot | undefined;
    if (material.normalTexture !== undefined) {
      const info = object(material.normalTexture, `${path}.normalTexture`), slot = textureSlot(info, `${path}.normalTexture`, "normal");
      const normalScale = info.scale === undefined ? 1 : info.scale;
      if (typeof normalScale !== "number" || !Number.isFinite(normalScale)) invalid(`${path}.normalTexture.scale`, "Expected a finite normal scale.");
      normalTexture = { ...slot, normalScale };
    }
    let occlusionTexture: GltfOcclusionTextureSlot | undefined;
    if (material.occlusionTexture !== undefined) {
      const info = object(material.occlusionTexture, `${path}.occlusionTexture`), slot = textureSlot(info, `${path}.occlusionTexture`, "occlusion");
      const strength = info.strength === undefined ? 1 : info.strength;
      if (typeof strength !== "number" || !Number.isFinite(strength) || strength < 0 || strength > 1) {
        invalid(`${path}.occlusionTexture.strength`, "Expected occlusion strength in 0..1.");
      }
      occlusionTexture = { ...slot, strength };
    }
    const emissiveTexture = material.emissiveTexture === undefined ? undefined
      : textureSlot(material.emissiveTexture, `${path}.emissiveTexture`, "emissive");
    return { id: `${prefix}/material/${materialIndex}`, materialIndex, ...(baseColorTexture ? { baseColorTexture } : {}),
      ...(metallicRoughnessTexture ? { metallicRoughnessTexture } : {}), ...(normalTexture ? { normalTexture } : {}),
      ...(occlusionTexture ? { occlusionTexture } : {}), ...(emissiveTexture ? { emissiveTexture } : {}),
      ...(emissiveStrength !== undefined ? { emissiveStrength } : {}) };
  });
  let uvCount = 0;
  const uvSets = list(document.meshes, "meshes", 4096).flatMap((value, meshIndex) => {
    const path = `meshes[${meshIndex}]`, mesh = object(value, path); noExtensions(mesh, path);
    return list(mesh.primitives, `${path}.primitives`, 4096).flatMap((value, primitiveIndex) => {
      const location = `${path}.primitives[${primitiveIndex}]`, primitive = object(value, location); noExtensions(primitive, location);
      if (primitive.material === undefined) return [];
      const materialIndex = reference(materials, primitive.material, `${location}.material`), material = materials[materialIndex]!;
      const slots = [material.baseColorTexture, material.metallicRoughnessTexture, material.normalTexture,
        material.occlusionTexture, material.emissiveTexture].filter((slot): slot is GltfTextureSlot => slot !== undefined);
      if (!slots.length) return [];
      const attributes = object(primitive.attributes, `${location}.attributes`);
      if (attributes.POSITION === undefined) invalid(`${location}.attributes.POSITION`, "Textured primitives require POSITION.");
      const positionCount = reader.accessorCount(attributes.POSITION, `${location}.attributes.POSITION`);
      const coordinateSets = [...new Set(slots.map(slot => slot.texCoord))].sort() as (0 | 1)[];
      return coordinateSets.map(texCoord => {
        const attribute = `TEXCOORD_${texCoord}`;
        if (attributes[attribute] === undefined) invalid(`${location}.attributes.${attribute}`, `Textured primitive requires ${attribute}.`);
        const values = reader.texCoord(attributes[attribute], `${location}.attributes.${attribute}`);
        if (values.length / 2 !== positionCount) invalid(location, `POSITION and ${attribute} counts differ.`);
        const requiresTangents = material.normalTexture?.texCoord === texCoord;
        const tangents = requiresTangents && attributes.TANGENT !== undefined
          ? reader.tangent4(attributes.TANGENT, `${location}.attributes.TANGENT`) : undefined;
        if (tangents && tangents.length / 4 !== positionCount) invalid(location, "POSITION and TANGENT counts differ.");
        budget(++uvCount, 8192, "texture coordinate sets");
        return { geometry: `${prefix}/mesh/${meshIndex}/primitive/${primitiveIndex}`, meshIndex, primitiveIndex, texCoord, values,
          requiresTangents, ...(tangents ? { tangents } : {}) };
      });
    });
  });
  return { images, resources, materials, uvSets };
}
