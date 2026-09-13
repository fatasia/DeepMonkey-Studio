import type { SpatialItemId } from "../spatial/types.js";
import { decodeAnimatedDocument } from "./decodeAnimatedGlb.js";
import { resolveAnimationOptions, validateAnimationDocument } from "./animationImportValidation.js";
import type { GltfAnimationImportOptions } from "./animationTypes.js";
import { selectAnimationNodes } from "./animationNodes.js";
import { decodeSkinnedDocument } from "./decodeSkinnedGlb.js";
import { parseGlb } from "./parseGlb.js";
import { resolveSkinOptions } from "./skinImportValidation.js";
import type {
  DecodedAnimatedSkinnedGlb,
  GltfAnimatedSkinnedImportOptions,
  GltfSkinImportOptions,
} from "./skinTypes.js";
import { object, validateJson } from "./validation.js";

/** Parses once and returns matching scene-node, animation, skin-palette, and vertex-stream identities. */
export function decodeAnimatedSkinnedGlb<TNodeId extends SpatialItemId = number>(
  bytes: Uint8Array,
  options: GltfAnimatedSkinnedImportOptions<TNodeId> = {},
): DecodedAnimatedSkinnedGlb<TNodeId> {
  object(options, "options");
  if (options.animation !== undefined) object(options.animation, "options.animation");
  if (options.skinning !== undefined) object(options.skinning, "options.skinning");
  const animationOptions: GltfAnimationImportOptions<TNodeId> = {
    ...options.animation,
    ...(options.sceneIndex === undefined ? {} : { sceneIndex: options.sceneIndex }),
    ...(options.mapNodeId === undefined ? {} : { mapNodeId: options.mapNodeId }),
  };
  const skinningOptions: GltfSkinImportOptions<TNodeId> = {
    ...options.skinning,
    ...(options.sceneIndex === undefined ? {} : { sceneIndex: options.sceneIndex }),
    ...(options.mapNodeId === undefined ? {} : { mapNodeId: options.mapNodeId }),
  };
  const parsed = parseGlb(bytes);
  validateJson(parsed.json);
  const document = validateAnimationDocument(parsed.json);
  const animationLimits = resolveAnimationOptions(animationOptions), skinLimits = resolveSkinOptions(skinningOptions);
  const selection = selectAnimationNodes(document, animationOptions, Math.min(animationLimits.maxNodes, skinLimits.maxNodes));
  const animation = decodeAnimatedDocument(document, parsed.buffers, animationOptions, selection);
  const skinning = decodeSkinnedDocument(document, parsed.buffers, skinningOptions, selection);
  return Object.freeze({
    abiVersion: skinning.abiVersion,
    sceneIndex: selection.sceneIndex,
    nodes: selection.nodes,
    clips: animation.clips,
    skins: skinning.skins,
    primitives: skinning.primitives,
    bindings: skinning.bindings,
    animationDecodedBytes: animation.decodedBytes,
    skinningDecodedBytes: skinning.decodedBytes,
    decodedBytes: animation.decodedBytes + skinning.decodedBytes,
  });
}
