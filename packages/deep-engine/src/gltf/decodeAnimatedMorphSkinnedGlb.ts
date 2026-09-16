import type { SpatialItemId } from "../spatial/types.js";
import { decodeAnimatedDocument } from "./decodeAnimatedGlb.js";
import { resolveAnimationOptions, validateAnimationDocument } from "./animationImportValidation.js";
import { selectAnimationNodes } from "./animationNodes.js";
import type { DecodedAnimatedGlb, GltfAnimationImportOptions } from "./animationTypes.js";
import { decodeMorphDocument } from "./decodeMorphGlb.js";
import { resolveMorphOptions } from "./morphImportValidation.js";
import type { DecodedMorphGlb, GltfMorphImportTuning } from "./morphTypes.js";
import { parseGlb } from "./parseGlb.js";
import { decodeSkinnedDocument } from "./decodeSkinnedGlb.js";
import { resolveSkinOptions } from "./skinImportValidation.js";
import type { DecodedSkinnedGlb, GltfSkinImportTuning } from "./skinTypes.js";
import { MAX_BYTES, abortSignal, budget, integer, object, validateJson } from "./validation.js";

type AnimationTuning<TNodeId extends SpatialItemId> = Omit<GltfAnimationImportOptions<TNodeId>, "sceneIndex" | "mapNodeId" | "signal">;

export interface GltfAnimatedMorphSkinnedImportOptions<TNodeId extends SpatialItemId = number> {
  readonly sceneIndex?: number;
  readonly mapNodeId?: (sourceNodeIndex: number, name: string | undefined) => TNodeId;
  readonly signal?: AbortSignal;
  readonly animation?: AnimationTuning<TNodeId>;
  readonly morph?: GltfMorphImportTuning<TNodeId>;
  readonly skinning?: GltfSkinImportTuning<TNodeId>;
  /** Aggregate owned deformation output budget across transform, morph, and skin data. */
  readonly maxDecodedBytes?: number;
}

export interface DecodedAnimatedMorphSkinnedGlb<TNodeId extends SpatialItemId = number> {
  readonly sceneIndex: number;
  readonly animation: DecodedAnimatedGlb<TNodeId>;
  readonly morph: DecodedMorphGlb<TNodeId>;
  readonly skinning: DecodedSkinnedGlb<TNodeId>;
  readonly decodedBytes: number;
}

function shared<TNodeId extends SpatialItemId>(options: GltfAnimatedMorphSkinnedImportOptions<TNodeId>) {
  return {
    ...(options.sceneIndex === undefined ? {} : { sceneIndex: options.sceneIndex }),
    ...(options.mapNodeId === undefined ? {} : { mapNodeId: options.mapNodeId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function remainingLimit(requested: number, remaining: number): number {
  return Math.max(1, Math.min(requested, remaining));
}

/**
 * Parses one GLB and publishes transform animation, morph, and skin sources in one
 * shared node identity space. The returned fields can be passed directly to
 * GltfRenderAnimationBridge.
 */
export function decodeAnimatedMorphSkinnedGlb<TNodeId extends SpatialItemId = number>(
  bytes: Uint8Array,
  options: GltfAnimatedMorphSkinnedImportOptions<TNodeId> = {},
): DecodedAnimatedMorphSkinnedGlb<TNodeId> {
  object(options, "options");
  abortSignal(options.signal, "options.signal")?.throwIfAborted();
  for (const key of ["animation", "morph", "skinning"] as const) {
    if (options[key] !== undefined) object(options[key], `options.${key}`);
  }
  const maximum = integer(options.maxDecodedBytes ?? MAX_BYTES, "options.maxDecodedBytes", 1);
  budget(maximum, MAX_BYTES, "options.maxDecodedBytes");
  const parsed = parseGlb(bytes); validateJson(parsed.json);
  const document = validateAnimationDocument(parsed.json);
  return decodeAnimatedMorphSkinnedDocument(document, parsed.buffers, options);
}

/** Internal parsed-document entry used by the full runtime importer. */
export function decodeAnimatedMorphSkinnedDocument<TNodeId extends SpatialItemId = number>(
  document: ReturnType<typeof validateAnimationDocument>,
  buffers: readonly Uint8Array[],
  options: GltfAnimatedMorphSkinnedImportOptions<TNodeId>,
): DecodedAnimatedMorphSkinnedGlb<TNodeId> {
  const maximum = integer(options.maxDecodedBytes ?? MAX_BYTES, "options.maxDecodedBytes", 1);
  budget(maximum, MAX_BYTES, "options.maxDecodedBytes");
  const common = shared(options);
  const animationOptions = { ...options.animation, ...common };
  const morphOptions = { ...options.morph, ...common };
  const skinOptions = { ...options.skinning, ...common };
  const animationLimits = resolveAnimationOptions(animationOptions);
  const morphLimits = resolveMorphOptions(morphOptions), skinLimits = resolveSkinOptions(skinOptions);
  const selection = selectAnimationNodes(document, animationOptions,
    Math.min(animationLimits.maxNodes, morphLimits.maxNodes, skinLimits.maxNodes), true);

  const animation = decodeAnimatedDocument(document, buffers, {
    ...animationOptions, maxDecodedBytes: Math.min(animationLimits.maxDecodedBytes, maximum),
  }, selection, true);
  let remaining = maximum - animation.decodedBytes;
  const morph = decodeMorphDocument(document, buffers, {
    ...morphOptions, maxDecodedBytes: remainingLimit(morphLimits.maxDecodedBytes, remaining),
  }, selection, true);
  remaining -= morph.decodedBytes;
  const skinning = decodeSkinnedDocument(document, buffers, {
    ...skinOptions, maxDecodedBytes: remainingLimit(skinLimits.maxDecodedBytes, remaining),
  }, selection, true);
  const decodedBytes = animation.decodedBytes + morph.decodedBytes + skinning.decodedBytes;
  budget(decodedBytes, maximum, "decodedBytes");
  return Object.freeze({ sceneIndex: selection.sceneIndex, animation, morph, skinning, decodedBytes });
}
