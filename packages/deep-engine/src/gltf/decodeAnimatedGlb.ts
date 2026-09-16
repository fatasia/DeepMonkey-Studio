import type { AnimationClipInput, AnimationInterpolation, AnimationTargetPath, AnimationTrackInput } from "../animation/types.js";
import type { SpatialItemId } from "../spatial/types.js";
import { AnimationAccessorReader } from "./animationAccessors.js";
import { resolveAnimationOptions, validateAnimationDocument } from "./animationImportValidation.js";
import { selectAnimationNodes } from "./animationNodes.js";
import type { AnimationNodeSelection } from "./animationNodes.js";
import type { DecodedAnimatedGlb, GltfAnimationImportOptions } from "./animationTypes.js";
import { parseGlb } from "./parseGlb.js";
import { abortSignal, array, invalid, list, noExtensions, object, reference, unsupported, validateJson, type JsonObject } from "./validation.js";

interface SamplerDefinition {
  readonly input: unknown;
  readonly output: unknown;
  readonly interpolation: AnimationInterpolation;
}

/** Decodes selected-scene nodes and embedded glTF 2.0 TRS animation clips without IO. */
export function decodeAnimatedGlb<TNodeId extends SpatialItemId = number>(
  bytes: Uint8Array,
  options: GltfAnimationImportOptions<TNodeId> = {},
): DecodedAnimatedGlb<TNodeId> {
  object(options, "options"); abortSignal(options.signal, "options.signal")?.throwIfAborted();
  const parsed = parseGlb(bytes);
  validateJson(parsed.json);
  const document = validateAnimationDocument(parsed.json);
  return decodeAnimatedDocument(document, parsed.buffers, options);
}

/** Internal parsed-document entry used by composite importers to avoid reparsing GLB bytes. */
export function decodeAnimatedDocument<TNodeId extends SpatialItemId = number>(
  document: JsonObject,
  buffers: readonly Uint8Array[],
  options: GltfAnimationImportOptions<TNodeId> = {},
  selectedNodes?: AnimationNodeSelection<TNodeId>,
  handledMorphWeights = false,
): DecodedAnimatedGlb<TNodeId> {
  const configuration = resolveAnimationOptions(options);
  const selection = selectedNodes ?? selectAnimationNodes(document, options, configuration.maxNodes);
  const reader = new AnimationAccessorReader(document, buffers, configuration, options.signal);
  const animations = list(document.animations, "animations", configuration.maxAnimations);
  const clips = animations.map((value, index) => decodeAnimation(value, index, document, selection, reader, configuration, handledMorphWeights));
  return Object.freeze({ sceneIndex: selection.sceneIndex, nodes: selection.nodes,
    clips: Object.freeze(clips), decodedBytes: reader.decodedBytes });
}

function decodeAnimation<TId extends SpatialItemId>(
  value: unknown,
  animationIndex: number,
  document: JsonObject,
  selection: ReturnType<typeof selectAnimationNodes<TId>>,
  reader: AnimationAccessorReader,
  limits: ReturnType<typeof resolveAnimationOptions<TId>>,
  handledMorphWeights: boolean,
): AnimationClipInput<TId> {
  const path = `animations[${animationIndex}]`, animation = object(value, path);
  noExtensions(animation, path);
  if (animation.name !== undefined && typeof animation.name !== "string") invalid(`${path}.name`, "Animation name must be a string.");
  const samplers = array(animation.samplers, `${path}.samplers`, limits.maxSamplersPerAnimation)
    .map((entry, index) => sampler(entry, `${path}.samplers[${index}]`));
  const channels = array(animation.channels, `${path}.channels`, limits.maxChannelsPerAnimation);
  if (samplers.length === 0 || channels.length === 0) invalid(path, "Animations require at least one sampler and channel.");
  const sourceNodes = list(document.nodes, "nodes", limits.maxNodes);
  const usedSamplers = new Set<number>(), targets = new Set<string>(), tracks: AnimationTrackInput<TId>[] = [];
  let duration = 0;
  channels.forEach((entry, channelIndex) => {
    if ((channelIndex & 0x3ff) === 0) limits.signal?.throwIfAborted();
    const channelPath = `${path}.channels[${channelIndex}]`, channel = object(entry, channelPath);
    noExtensions(channel, channelPath);
    const samplerIndex = reference(samplers, channel.sampler, `${channelPath}.sampler`);
    const target = object(channel.target, `${channelPath}.target`);
    noExtensions(target, `${channelPath}.target`);
    const nodeIndex = reference(sourceNodes, target.node, `${channelPath}.target.node`);
    if (target.path === "weights") {
      if (!handledMorphWeights) unsupported(`${channelPath}.target.path`, "morph target weight animation");
      usedSamplers.add(samplerIndex);
      return;
    }
    const targetPath = animationPath(target.path, `${channelPath}.target.path`);
    if (!selection.selected.has(nodeIndex)) invalid(`${channelPath}.target.node`, "Animation target is outside the selected scene.");
    if (selection.matrixNodes.has(nodeIndex)) invalid(`${channelPath}.target.node`, "TRS animation cannot target a node defined by matrix.");
    const duplicateKey = `${nodeIndex}:${targetPath}`;
    if (targets.has(duplicateKey)) invalid(channelPath, "Animation has a duplicate channel for the same node path.");
    targets.add(duplicateKey), usedSamplers.add(samplerIndex);
    const definition = samplers[samplerIndex]!;
    const times = reader.readFloat(definition.input, "SCALAR", limits.maxKeysPerTrack, `${path}.samplers[${samplerIndex}].input`);
    validateTimes(times.values, `${path}.samplers[${samplerIndex}].input`);
    const multiplier = definition.interpolation === "CUBICSPLINE" ? 3 : 1;
    const type = targetPath === "rotation" ? "VEC4" : "VEC3";
    const output = reader.readFloat(definition.output, type, limits.maxKeysPerTrack * multiplier, `${path}.samplers[${samplerIndex}].output`);
    if (output.count !== times.count * multiplier) invalid(`${path}.samplers[${samplerIndex}].output`, "Animation input/output key counts do not match interpolation layout.");
    if (targetPath === "rotation") validateRotations(output.values, times.count, definition.interpolation, `${path}.samplers[${samplerIndex}].output`);
    duration = Math.max(duration, times.values[times.values.length - 1]!);
    tracks.push(Object.freeze({ nodeId: selection.ids.get(nodeIndex)!, path: targetPath,
      interpolation: definition.interpolation, times: times.values, values: output.values }));
  });
  if (usedSamplers.size !== samplers.length) invalid(`${path}.samplers`, "Animation contains an unused sampler.");
  return Object.freeze({ id: `${limits.clipPrefix}/animation/${animationIndex}`, duration,
    tracks: Object.freeze(tracks) });
}

function sampler(value: unknown, path: string): SamplerDefinition {
  const source = object(value, path);
  noExtensions(source, path);
  const interpolation = source.interpolation ?? "LINEAR";
  if (interpolation !== "STEP" && interpolation !== "LINEAR" && interpolation !== "CUBICSPLINE") unsupported(`${path}.interpolation`, `animation interpolation ${String(interpolation)}`);
  if (source.input === undefined || source.output === undefined) invalid(path, "Animation sampler input and output are required.");
  return Object.freeze({ input: source.input, output: source.output, interpolation });
}

function animationPath(value: unknown, path: string): AnimationTargetPath {
  if (value === "weights") unsupported(path, "morph target weight animation");
  if (value !== "translation" && value !== "rotation" && value !== "scale") invalid(path, "Animation target path is invalid.");
  return value;
}

function validateTimes(values: Float32Array, path: string): void {
  for (let index = 0; index < values.length; index += 1) {
    if (values[index]! < 0 || (index > 0 && values[index]! <= values[index - 1]!)) invalid(path, "Animation input times must be non-negative and strictly increasing.");
  }
}

function validateRotations(values: Float32Array, keys: number, interpolation: AnimationInterpolation, path: string): void {
  const stride = interpolation === "CUBICSPLINE" ? 12 : 4;
  const offset = interpolation === "CUBICSPLINE" ? 4 : 0;
  for (let key = 0; key < keys; key += 1) {
    const start = key * stride + offset;
    const length = Math.hypot(values[start]!, values[start + 1]!, values[start + 2]!, values[start + 3]!);
    if (length <= Number.EPSILON || Math.abs(length - 1) > 1e-5) invalid(path, "Animation rotation key must be a normalized quaternion.");
  }
}
