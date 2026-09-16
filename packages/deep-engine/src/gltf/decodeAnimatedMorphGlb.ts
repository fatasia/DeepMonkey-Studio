import type { SpatialItemId } from "../spatial/types.js";
import { decodeAnimatedDocument } from "./decodeAnimatedGlb.js";
import { resolveAnimationOptions, validateAnimationDocument } from "./animationImportValidation.js";
import type { GltfAnimationImportOptions } from "./animationTypes.js";
import { selectAnimationNodes } from "./animationNodes.js";
import { decodeMorphDocument } from "./decodeMorphGlb.js";
import { resolveMorphOptions } from "./morphImportValidation.js";
import type { DecodedAnimatedMorphGlb, GltfAnimatedMorphImportOptions, GltfMorphImportOptions } from "./morphTypes.js";
import { parseGlb } from "./parseGlb.js";
import { abortSignal, object, validateJson } from "./validation.js";

/** Parses once and returns one stable node identity space for transform and morph animation. */
export function decodeAnimatedMorphGlb<TNodeId extends SpatialItemId = number>(
  bytes: Uint8Array,
  options: GltfAnimatedMorphImportOptions<TNodeId> = {},
): DecodedAnimatedMorphGlb<TNodeId> {
  object(options, "options");
  abortSignal(options.signal, "options.signal")?.throwIfAborted();
  if (options.animation !== undefined) object(options.animation, "options.animation");
  if (options.morph !== undefined) object(options.morph, "options.morph");
  const animationOptions: GltfAnimationImportOptions<TNodeId> = {
    ...options.animation,
    ...(options.sceneIndex === undefined ? {} : { sceneIndex: options.sceneIndex }),
    ...(options.mapNodeId === undefined ? {} : { mapNodeId: options.mapNodeId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const morphOptions: GltfMorphImportOptions<TNodeId> = {
    ...options.morph,
    ...(options.sceneIndex === undefined ? {} : { sceneIndex: options.sceneIndex }),
    ...(options.mapNodeId === undefined ? {} : { mapNodeId: options.mapNodeId }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const parsed = parseGlb(bytes);
  validateJson(parsed.json);
  const document = validateAnimationDocument(parsed.json);
  const animationLimits = resolveAnimationOptions(animationOptions), morphLimits = resolveMorphOptions(morphOptions);
  const selection = selectAnimationNodes(document, animationOptions, Math.min(animationLimits.maxNodes, morphLimits.maxNodes), true);
  const transform = decodeAnimatedDocument(document, parsed.buffers, animationOptions, selection, true);
  const morph = decodeMorphDocument(document, parsed.buffers, morphOptions, selection, true);
  return Object.freeze({
    abiVersion: morph.abiVersion,
    sceneIndex: selection.sceneIndex,
    nodes: selection.nodes,
    primitives: morph.primitives,
    bindings: morph.bindings,
    morphClips: morph.morphClips,
    transformClips: Object.freeze(transform.clips.filter((clip) => clip.tracks.length > 0)),
    transformAnimationDecodedBytes: transform.decodedBytes,
    morphDecodedBytes: morph.decodedBytes,
    decodedBytes: transform.decodedBytes + morph.decodedBytes,
  });
}
