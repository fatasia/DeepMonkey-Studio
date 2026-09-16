import type { SpatialItemId } from "../spatial/types.js";
import type { GltfMorphImportConfiguration, GltfMorphImportOptions } from "./morphTypes.js";
import { MAX_BYTES, abortSignal, invalid, object } from "./validation.js";

export const DEEP_GLTF_MORPH_LIMITS = Object.freeze({
  maxNodes: 250_000,
  maxMeshes: 16_384,
  maxPrimitives: 16_384,
  maxTargetsPerPrimitive: 256,
  maxVerticesPerPrimitive: 4_000_000,
  maxAnimations: 1_024,
  maxChannelsPerAnimation: 100_000,
  maxKeysPerTrack: 1_000_000,
  maxDecodedBytes: MAX_BYTES,
});

export function resolveMorphOptions<TId extends SpatialItemId>(options: GltfMorphImportOptions<TId>): GltfMorphImportConfiguration {
  object(options, "options");
  const signal = abortSignal(options.signal, "options.signal"); signal?.throwIfAborted();
  if (options.mapNodeId !== undefined && typeof options.mapNodeId !== "function") invalid("options.mapNodeId", "Expected a function.");
  const resourcePrefix = prefix(options.resourcePrefix, "resourcePrefix", "gltf");
  const clipPrefix = prefix(options.clipPrefix, "clipPrefix", "gltf");
  return Object.freeze({
    resourcePrefix,
    clipPrefix,
    maxNodes: limit(options.maxNodes, DEEP_GLTF_MORPH_LIMITS.maxNodes, "maxNodes"),
    maxMeshes: limit(options.maxMeshes, DEEP_GLTF_MORPH_LIMITS.maxMeshes, "maxMeshes"),
    maxPrimitives: limit(options.maxPrimitives, DEEP_GLTF_MORPH_LIMITS.maxPrimitives, "maxPrimitives"),
    maxTargetsPerPrimitive: limit(options.maxTargetsPerPrimitive, DEEP_GLTF_MORPH_LIMITS.maxTargetsPerPrimitive, "maxTargetsPerPrimitive"),
    maxVerticesPerPrimitive: limit(options.maxVerticesPerPrimitive, DEEP_GLTF_MORPH_LIMITS.maxVerticesPerPrimitive, "maxVerticesPerPrimitive"),
    maxAnimations: limit(options.maxAnimations, DEEP_GLTF_MORPH_LIMITS.maxAnimations, "maxAnimations"),
    maxChannelsPerAnimation: limit(options.maxChannelsPerAnimation, DEEP_GLTF_MORPH_LIMITS.maxChannelsPerAnimation, "maxChannelsPerAnimation"),
    maxKeysPerTrack: limit(options.maxKeysPerTrack, DEEP_GLTF_MORPH_LIMITS.maxKeysPerTrack, "maxKeysPerTrack"),
    maxDecodedBytes: limit(options.maxDecodedBytes, DEEP_GLTF_MORPH_LIMITS.maxDecodedBytes, "maxDecodedBytes"),
    ...(signal ? { signal } : {}),
  });
}

function prefix(value: string | undefined, label: string, fallback: string): string {
  const result = value ?? fallback;
  if (typeof result !== "string" || result.length < 1 || result.length > 256) invalid(`options.${label}`, "Expected a nonempty prefix of at most 256 characters.");
  return result;
}
function limit(value: number | undefined, maximum: number, label: string): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) invalid(`options.${label}`, `Expected an integer in 1..${maximum}.`);
  return result;
}
