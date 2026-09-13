import { prepareTextures, type DecodedTexture, type TextureLimits } from "../textures/decodedTexture.js";
import { transcodeKtx2Texture } from "../textures/ktx2Transcode.js";
import type { GltfDecodedImage, GltfDecodedTextures, GltfEncodedImage, GltfImageDecoder, GltfTextureDecodeOptions, GltfTextureManifest } from "./textureTypes.js";
import { GltfImportError, MAX_BYTES, budget, invalid, object } from "./validation.js";

function safeLimit(value: number | undefined, fallback: number, maximum: number, path: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) invalid(path, `Expected an integer in 1..${maximum}.`);
  return result;
}

function ownedImage(image: GltfEncodedImage): GltfEncodedImage {
  if (!image || typeof image.id !== "string" || !image.id || image.id.length > 256 || !Number.isSafeInteger(image.imageIndex) || image.imageIndex < 0) {
    invalid("textureManifest.images", "Invalid encoded image identity.");
  }
  if (image.mimeType !== "image/png" && image.mimeType !== "image/jpeg" && image.mimeType !== "image/ktx2") {
    invalid(`textureManifest.images[${image.imageIndex}].mimeType`, "Unsupported image MIME type.");
  }
  if (!(image.data instanceof Uint8Array) || !(image.data.buffer instanceof ArrayBuffer) || !image.data.length) {
    invalid(`textureManifest.images[${image.imageIndex}].data`, "Encoded image requires owned nonempty bytes.");
  }
  return { ...image, data: image.data.slice() };
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Texture decode aborted."); error.name = "AbortError"; return error;
}

async function decodeCancelable(decoder: GltfImageDecoder, image: GltfEncodedImage, signal?: AbortSignal): Promise<GltfDecodedImage> {
  if (!signal) return decoder.decode(image);
  signal.throwIfAborted();
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort!(abortReason(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return decoder.decode(image, signal); });
  try {
    // Promise.race 为迟到的 pending 安装 rejection handler，宿主忽略 signal 也不会产生未处理拒绝。
    return await Promise.race([pending, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function rgba8(value: GltfDecodedImage, image: GltfEncodedImage, maxDimension: number, remaining: number): GltfDecodedImage {
  if (!value || typeof value !== "object") invalid(`images[${image.imageIndex}]`, "Image decoder returned no pixels.");
  const { width, height, data } = value;
  if (!Number.isSafeInteger(width) || width < 1 || width > maxDimension) invalid(`images[${image.imageIndex}].width`, "Decoded width exceeds limits.");
  if (!Number.isSafeInteger(height) || height < 1 || height > maxDimension) invalid(`images[${image.imageIndex}].height`, "Decoded height exceeds limits.");
  if (!(data instanceof Uint8Array) || !(data.buffer instanceof ArrayBuffer)) invalid(`images[${image.imageIndex}].data`, "Decoder must return unshared RGBA8 bytes.");
  const row = width * 4, pitch = value.bytesPerRow ?? row;
  if (!Number.isSafeInteger(pitch) || pitch < row) invalid(`images[${image.imageIndex}].bytesPerRow`, "Decoded row pitch is invalid.");
  const required = pitch * (height - 1) + row;
  if (data.byteLength < required || data.byteLength > pitch * height) invalid(`images[${image.imageIndex}].data`, "Decoded RGBA8 length does not match dimensions.");
  const bytes = width * height * 4; budget(bytes, remaining, `images[${image.imageIndex}]`);
  const owned = new Uint8Array(bytes);
  for (let y = 0; y < height; y++) owned.set(data.subarray(y * pitch, y * pitch + row), y * row);
  return { width, height, data: owned, bytesPerRow: row };
}

/**
 * 通过宿主提供的异步解码/转码器把 manifest 转为 RGBA8 或 GPU 原生压缩纹理。
 * 相同 image 与颜色空间组合只处理一次，语义不同的 GPU 资源取得独立数据副本。
 */
export async function decodeGltfTextureManifest(manifest: GltfTextureManifest, decoder: GltfImageDecoder | undefined,
  options: GltfTextureDecodeOptions = {}): Promise<GltfDecodedTextures> {
  object(manifest, "textureManifest"); object(options, "options");
  if (!Array.isArray(manifest.images) || !Array.isArray(manifest.resources)) invalid("textureManifest", "Expected image and resource arrays.");
  const maxDimension = safeLimit(options.maxDimension, 16_384, 16_384, "options.maxDimension");
  const maxBytes = safeLimit(options.maxBytes, MAX_BYTES, MAX_BYTES, "options.maxBytes");
  const maxTextures = safeLimit(options.maxTextures, 4096, 4096, "options.maxTextures");
  budget(manifest.images.length, 4096, "textureManifest.images");
  budget(manifest.resources.length, maxTextures, "textureManifest.resources");
  const images = new Map<string, GltfEncodedImage>();
  let encodedBytes = 0;
  for (let index = 0; index < manifest.images.length; index++) {
    const raw = manifest.images[index];
    if (!raw || !(raw.data instanceof Uint8Array)) invalid(`textureManifest.images[${index}]`, "Invalid or sparse encoded image.");
    encodedBytes += raw.data.byteLength; budget(encodedBytes, MAX_BYTES, "textureManifest.images");
    const image = ownedImage(raw);
    if (images.has(image.id)) invalid("textureManifest.images", "Duplicate encoded image id.");
    images.set(image.id, image);
  }
  const imageFor = (resource: GltfTextureManifest["resources"][number], index: number): GltfEncodedImage => {
    const primary = images.get(resource.image);
    if (!primary) invalid(`textureManifest.resources[${index}].image`, "Texture resource references a missing image.");
    if (resource.fallbackImage === undefined) return primary;
    const fallback = images.get(resource.fallbackImage);
    if (!fallback) invalid(`textureManifest.resources[${index}].fallbackImage`, "Texture resource references a missing fallback image.");
    if (fallback.mimeType === "image/ktx2") invalid(`textureManifest.resources[${index}].fallbackImage`, "Texture fallback must be PNG or JPEG.");
    return primary.mimeType === "image/ktx2" && !options.ktx2 ? fallback : primary;
  };
  type DecodedPayload = Readonly<{ kind: "rgba"; value: GltfDecodedImage }>
    | Readonly<{ kind: "ktx2"; value: DecodedTexture }>;
  const resourceIds = new Set<string>(), decoded = new Map<string, DecodedPayload>();
  const ktx2Features = options.ktx2?.supportedFeatures === undefined
    ? undefined : Array.from(options.ktx2.supportedFeatures);
  let decodedBytes = 0;
  for (let index = 0; index < manifest.resources.length; index++) {
    options.signal?.throwIfAborted();
    const resource = manifest.resources[index]!;
    if (!resource || typeof resource.id !== "string" || !resource.id || resource.id.length > 256 || resourceIds.has(resource.id)) invalid(`textureManifest.resources[${index}].id`, "Invalid or duplicate texture resource id.");
    resourceIds.add(resource.id);
    if (!Number.isSafeInteger(resource.textureIndex) || resource.textureIndex < 0) invalid(`textureManifest.resources[${index}].textureIndex`, "Invalid source texture index.");
    if (!["baseColor", "metallicRoughness", "normal", "occlusion", "emissive"].includes(resource.semantic)) invalid(`textureManifest.resources[${index}].semantic`, "Unknown texture semantic.");
    const settings = resource.sampler;
    if (!settings || ![settings.addressModeU, settings.addressModeV].every(value => ["repeat", "mirror-repeat", "clamp-to-edge"].includes(value))
      || ![settings.magFilter, settings.minFilter, settings.mipmapFilter].every(value => ["nearest", "linear"].includes(value))
      || !Number.isSafeInteger(settings.maxAnisotropy) || settings.maxAnisotropy < 1 || settings.maxAnisotropy > 16
      || (settings.maxAnisotropy > 1 && [settings.magFilter, settings.minFilter, settings.mipmapFilter].some(value => value !== "linear"))) {
      invalid(`textureManifest.resources[${index}].sampler`, "Invalid texture sampler.");
    }
    const image = imageFor(resource, index);
    const colorSpace = resource.semantic === "baseColor" || resource.semantic === "emissive" ? "srgb" : "linear";
    const decodedKey = image.mimeType === "image/ktx2" ? `${image.id}:${colorSpace}` : image.id;
    if (decoded.has(decodedKey)) continue;
    if (image.mimeType === "image/ktx2") {
      if (!options.ktx2) throw new GltfImportError("unsupported", `images[${image.imageIndex}]`,
        "KHR_texture_basisu requires an injected KTX2 transcoder.", "KHR_texture_basisu");
      try {
        const texture = await transcodeKtx2Texture({
          id: decodedKey, revision: 0, semantic: resource.semantic, data: image.data,
          // Without parsing the container twice, conservatively preserve an alpha channel.
          hasAlpha: true, sourceProfile: "unknown",
        }, options.ktx2.transcoder, {
          ...(ktx2Features === undefined ? {} : { supportedFeatures: ktx2Features }),
          ...(options.ktx2.preference === undefined ? {} : { preference: options.ktx2.preference }),
          maxDimension, maxSourceBytes: MAX_BYTES, maxDecodedBytes: maxBytes,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
        const bytes = texture.data.byteLength + (texture.mipmaps ?? []).reduce((sum, level) => sum + level.data.byteLength, 0);
        decodedBytes += bytes; budget(decodedBytes, maxBytes, `images[${image.imageIndex}]`);
        decoded.set(decodedKey, { kind: "ktx2", value: texture });
        continue;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        if (error instanceof GltfImportError) throw error;
        throw new GltfImportError("invalid", `images[${image.imageIndex}]`,
          `KTX2 transcode failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!decoder || (typeof decoder !== "object" && typeof decoder !== "function") || typeof decoder.decode !== "function") {
      invalid("imageDecoder.decode", "PNG/JPEG textures require an async image decoder function.");
    }
    let result: GltfDecodedImage;
    try {
      result = await decodeCancelable(decoder, ownedImage(image), options.signal);
      options.signal?.throwIfAborted();
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (error instanceof GltfImportError) throw error;
      throw new GltfImportError("invalid", `images[${image.imageIndex}]`, `Image decode failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const pixels = rgba8(result, image, maxDimension, maxBytes - decodedBytes);
    decodedBytes += pixels.width * pixels.height * 4;
    decoded.set(decodedKey, { kind: "rgba", value: pixels });
  }
  let expandedBytes = 0;
  for (let index = 0; index < manifest.resources.length; index++) {
    const resource = manifest.resources[index]!, image = imageFor(resource, index);
    const colorSpace = resource.semantic === "baseColor" || resource.semantic === "emissive" ? "srgb" : "linear";
    const payload = decoded.get(image.mimeType === "image/ktx2" ? `${image.id}:${colorSpace}` : image.id);
    if (!payload) invalid(`textureManifest.resources[${index}].image`, "Texture resource has no decoded image.");
    const bytes = payload.kind === "rgba" ? payload.value.width * payload.value.height * 4
      : payload.value.data.byteLength + (payload.value.mipmaps ?? []).reduce((sum, level) => sum + level.data.byteLength, 0);
    expandedBytes += bytes; budget(expandedBytes, maxBytes, "textureManifest.resources");
  }
  const sources: DecodedTexture[] = manifest.resources.map((resource, index) => {
    const image = imageFor(resource, index);
    const colorSpace = resource.semantic === "baseColor" || resource.semantic === "emissive" ? "srgb" : "linear";
    const payload = decoded.get(image.mimeType === "image/ktx2" ? `${image.id}:${colorSpace}` : image.id);
    if (!payload) invalid(`textureManifest.resources[${index}].image`, "Texture resource has no decoded image.");
    if (payload.kind === "rgba") return { id: resource.id, revision: 0, semantic: resource.semantic,
      width: payload.value.width, height: payload.value.height, data: payload.value.data.slice(),
      ...(payload.value.bytesPerRow === undefined ? {} : { bytesPerRow: payload.value.bytesPerRow }), sampler: { ...resource.sampler } };
    return { id: resource.id, revision: 0, semantic: resource.semantic,
      width: payload.value.width, height: payload.value.height, data: payload.value.data.slice(),
      ...(payload.value.bytesPerRow === undefined ? {} : { bytesPerRow: payload.value.bytesPerRow }),
      ...(payload.value.compression ? { compression: payload.value.compression } : {}),
      ...(payload.value.mipmaps ? { mipmaps: payload.value.mipmaps.map(level => ({
        width: level.width, height: level.height, data: level.data.slice(),
        ...(level.bytesPerRow === undefined ? {} : { bytesPerRow: level.bytesPerRow }),
      })) } : {}), sampler: { ...resource.sampler } };
  });
  const limits: TextureLimits = { maxDimension, maxBytes, maxTextures };
  try {
    prepareTextures(sources, limits);
    return sources;
  } catch (error) {
    throw new GltfImportError("invalid", "textureManifest.resources", error instanceof Error ? error.message : String(error));
  }
}
