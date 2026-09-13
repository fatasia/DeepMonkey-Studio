import type { SpatialItemId } from "../spatial/types.js";
import type { GltfAnimationImportConfiguration, GltfAnimationImportOptions } from "./animationTypes.js";
import { MAX_BYTES, invalid, list, noExtensions, object, unsupported, type JsonObject } from "./validation.js";

export const DEEP_GLTF_ANIMATION_LIMITS = Object.freeze({
  maxAnimations: 1_024,
  maxNodes: 250_000,
  maxSamplersPerAnimation: 100_000,
  maxChannelsPerAnimation: 100_000,
  maxKeysPerTrack: 1_000_000,
  maxDecodedBytes: MAX_BYTES,
});

export function validateAnimationDocument(json: unknown): JsonObject {
  const document = object(json, "$"), asset = object(document.asset, "asset");
  noExtensions(document, "$"), noExtensions(asset, "asset");
  if (asset.version !== "2.0") unsupported("asset.version", "glTF versions other than 2.0");
  if (asset.minVersion !== undefined && asset.minVersion !== "2.0") unsupported("asset.minVersion", "newer minimum glTF versions");
  for (const field of ["extensionsUsed", "extensionsRequired"] as const) {
    if (list(document[field], field).length) unsupported(field, "glTF animation extensions");
  }
  return document;
}

export function resolveAnimationOptions<TId extends SpatialItemId>(options: GltfAnimationImportOptions<TId>): GltfAnimationImportConfiguration {
  object(options, "options");
  if (options.mapNodeId !== undefined && typeof options.mapNodeId !== "function") invalid("options.mapNodeId", "Expected a function.");
  const clipPrefix = options.clipPrefix ?? "gltf";
  if (typeof clipPrefix !== "string" || clipPrefix.length < 1 || clipPrefix.length > 256) invalid("options.clipPrefix", "Expected a nonempty prefix of at most 256 characters.");
  return Object.freeze({
    maxAnimations: optionLimit(options.maxAnimations, DEEP_GLTF_ANIMATION_LIMITS.maxAnimations, "maxAnimations"),
    maxNodes: optionLimit(options.maxNodes, DEEP_GLTF_ANIMATION_LIMITS.maxNodes, "maxNodes"),
    maxSamplersPerAnimation: optionLimit(options.maxSamplersPerAnimation, DEEP_GLTF_ANIMATION_LIMITS.maxSamplersPerAnimation, "maxSamplersPerAnimation"),
    maxChannelsPerAnimation: optionLimit(options.maxChannelsPerAnimation, DEEP_GLTF_ANIMATION_LIMITS.maxChannelsPerAnimation, "maxChannelsPerAnimation"),
    maxKeysPerTrack: optionLimit(options.maxKeysPerTrack, DEEP_GLTF_ANIMATION_LIMITS.maxKeysPerTrack, "maxKeysPerTrack"),
    maxDecodedBytes: optionLimit(options.maxDecodedBytes, DEEP_GLTF_ANIMATION_LIMITS.maxDecodedBytes, "maxDecodedBytes"),
    clipPrefix,
  });
}

function optionLimit(value: number | undefined, maximum: number, path: string): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) invalid(`options.${path}`, `Expected an integer in 1..${maximum}.`);
  return resolved;
}
