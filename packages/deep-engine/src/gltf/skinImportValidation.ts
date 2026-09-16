import type { SpatialItemId } from "../spatial/types.js";
import type { GltfSkinImportConfiguration, GltfSkinImportOptions } from "./skinTypes.js";
import { MAX_BYTES, abortSignal, invalid, object } from "./validation.js";

export const DEEP_GLTF_SKIN_LIMITS = Object.freeze({
  maxNodes: 250_000,
  maxSkins: 16_384,
  maxJointsPerSkin: 65_536,
  maxSkinnedNodes: 65_536,
  maxPrimitives: 16_384,
  maxVerticesPerPrimitive: 4_000_000,
  maxDecodedBytes: MAX_BYTES,
});

export function resolveSkinOptions<TId extends SpatialItemId>(
  options: GltfSkinImportOptions<TId>,
): GltfSkinImportConfiguration {
  object(options, "options");
  const signal = abortSignal(options.signal, "options.signal"); signal?.throwIfAborted();
  if (options.mapNodeId !== undefined && typeof options.mapNodeId !== "function") {
    invalid("options.mapNodeId", "Expected a function.");
  }
  const resourcePrefix = options.resourcePrefix ?? "gltf";
  if (typeof resourcePrefix !== "string" || resourcePrefix.length < 1 || resourcePrefix.length > 256) {
    invalid("options.resourcePrefix", "Expected a nonempty prefix of at most 256 characters.");
  }
  return Object.freeze({
    resourcePrefix,
    maxNodes: optionLimit(options.maxNodes, DEEP_GLTF_SKIN_LIMITS.maxNodes, "maxNodes"),
    maxSkins: optionLimit(options.maxSkins, DEEP_GLTF_SKIN_LIMITS.maxSkins, "maxSkins"),
    maxJointsPerSkin: optionLimit(options.maxJointsPerSkin, DEEP_GLTF_SKIN_LIMITS.maxJointsPerSkin, "maxJointsPerSkin"),
    maxSkinnedNodes: optionLimit(options.maxSkinnedNodes, DEEP_GLTF_SKIN_LIMITS.maxSkinnedNodes, "maxSkinnedNodes"),
    maxPrimitives: optionLimit(options.maxPrimitives, DEEP_GLTF_SKIN_LIMITS.maxPrimitives, "maxPrimitives"),
    maxVerticesPerPrimitive: optionLimit(options.maxVerticesPerPrimitive, DEEP_GLTF_SKIN_LIMITS.maxVerticesPerPrimitive, "maxVerticesPerPrimitive"),
    maxDecodedBytes: optionLimit(options.maxDecodedBytes, DEEP_GLTF_SKIN_LIMITS.maxDecodedBytes, "maxDecodedBytes"),
    ...(signal ? { signal } : {}),
  });
}

function optionLimit(value: number | undefined, maximum: number, path: string): number {
  const resolved = value ?? maximum;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    invalid(`options.${path}`, `Expected an integer in 1..${maximum}.`);
  }
  return resolved;
}
