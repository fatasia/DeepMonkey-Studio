import type { AnimationInterpolation } from "../animation/types.js";
import type { MorphPrimitiveSource, MorphTargetSource, MorphWeightClip, MorphWeightTrack } from "../morph/types.js";
import type { SpatialItemId } from "../spatial/types.js";
import { validateAnimationDocument } from "./animationImportValidation.js";
import { selectAnimationNodes, type AnimationNodeSelection } from "./animationNodes.js";
import { MorphAccessorReader } from "./morphAccessors.js";
import { resolveMorphOptions } from "./morphImportValidation.js";
import {
  GLTF_MORPH_SOURCE_ABI_VERSION,
  type DecodedMorphGlb,
  type GltfMorphBinding,
  type GltfMorphImportConfiguration,
  type GltfMorphImportOptions,
} from "./morphTypes.js";
import { parseGlb } from "./parseGlb.js";
import { array, budget, invalid, list, noExtensions, object, reference, unsupported, validateJson, type JsonObject } from "./validation.js";

interface DecodedMorphMesh {
  readonly primitives: readonly MorphPrimitiveSource[];
  readonly initialWeights: readonly number[];
  readonly targetCount: number;
}
interface MorphSampler { readonly input: unknown; readonly output: unknown; readonly interpolation: AnimationInterpolation }

/** Decodes selected-scene morph targets and weight animation. Transform animation requires the composite decoder. */
export function decodeMorphGlb<TNodeId extends SpatialItemId = number>(
  bytes: Uint8Array,
  options: GltfMorphImportOptions<TNodeId> = {},
): DecodedMorphGlb<TNodeId> {
  const parsed = parseGlb(bytes);
  validateJson(parsed.json);
  const document = validateAnimationDocument(parsed.json);
  return decodeMorphDocument(document, parsed.buffers, options);
}

/** Internal parsed-document entry used by the transform-animation composite importer. */
export function decodeMorphDocument<TNodeId extends SpatialItemId = number>(
  document: JsonObject,
  buffers: readonly Uint8Array[],
  options: GltfMorphImportOptions<TNodeId> = {},
  selectedNodes?: AnimationNodeSelection<TNodeId>,
  handledTransformChannels = false,
): DecodedMorphGlb<TNodeId> {
  const limits = resolveMorphOptions(options);
  const selection = selectedNodes ?? selectAnimationNodes(document, options, limits.maxNodes, true);
  const sourceNodes = list(document.nodes, "nodes", limits.maxNodes), sourceMeshes = list(document.meshes, "meshes", limits.maxMeshes);
  const selectedMeshIndices = new Set<number>();
  for (const selected of selection.nodes) {
    const node = object(sourceNodes[selected.sourceNodeIndex], `nodes[${selected.sourceNodeIndex}]`);
    if (node.weights !== undefined && node.mesh === undefined) invalid(`nodes[${selected.sourceNodeIndex}].weights`, "Morph weights require a mesh.");
    if (node.mesh !== undefined) selectedMeshIndices.add(reference(sourceMeshes, node.mesh, `nodes[${selected.sourceNodeIndex}].mesh`));
  }
  const reader = new MorphAccessorReader(document, buffers, limits), meshes = new Map<number, DecodedMorphMesh>();
  let primitiveCount = 0;
  for (const meshIndex of [...selectedMeshIndices].sort(numberOrder)) {
    const decoded = decodeMesh(sourceMeshes[meshIndex], meshIndex, reader, limits, primitiveCount);
    primitiveCount += decoded?.primitives.length ?? 0;
    if (decoded) meshes.set(meshIndex, decoded);
  }
  const bindings = bindNodes(selection, sourceNodes, sourceMeshes, meshes, reader);
  const targetCounts = new Map(bindings.map((binding) => [binding.sourceNodeIndex, binding.initialWeights.length] as const));
  const morphClips = decodeWeightAnimations(document, selection, targetCounts, reader, limits, handledTransformChannels);
  const primitives = [...meshes.entries()].sort(([left], [right]) => left - right).flatMap(([, mesh]) => mesh.primitives);
  return Object.freeze({ abiVersion: GLTF_MORPH_SOURCE_ABI_VERSION, sceneIndex: selection.sceneIndex, nodes: selection.nodes,
    primitives: Object.freeze(primitives), bindings: Object.freeze(bindings), morphClips: Object.freeze(morphClips), decodedBytes: reader.decodedBytes });
}

function decodeMesh(value: unknown, meshIndex: number, reader: MorphAccessorReader, limits: GltfMorphImportConfiguration,
  priorPrimitives: number): DecodedMorphMesh | null {
  const path = `meshes[${meshIndex}]`, mesh = object(value, path);
  noExtensions(mesh, path);
  const primitiveValues = array(mesh.primitives, `${path}.primitives`, 4_096);
  if (primitiveValues.length === 0) invalid(path, "A selected mesh must contain at least one primitive.");
  const targetLists = primitiveValues.map((value, primitiveIndex) => {
    const primitive = object(value, `${path}.primitives[${primitiveIndex}]`);
    noExtensions(primitive, `${path}.primitives[${primitiveIndex}]`);
    const targets = list(primitive.targets, `${path}.primitives[${primitiveIndex}].targets`, limits.maxTargetsPerPrimitive);
    if (primitive.targets !== undefined && targets.length === 0) invalid(`${path}.primitives[${primitiveIndex}].targets`, "Morph targets cannot be empty.");
    return targets;
  });
  const targetCount = targetLists.find((targets) => targets.length > 0)?.length ?? 0;
  if (targetCount === 0) {
    if (mesh.weights !== undefined || targetNameValue(mesh) !== undefined) invalid(path, "Morph weights or target names require primitive targets.");
    return null;
  }
  if (targetLists.some((targets) => targets.length !== targetCount)) invalid(path, "Every primitive in a morph mesh must have a consistent nonzero target count.");
  budget(priorPrimitives + primitiveValues.length, limits.maxPrimitives, "morphPrimitives");
  const names = targetNames(mesh, targetCount, path), initialWeights = weights(mesh.weights, targetCount, `${path}.weights`);
  const primitives = primitiveValues.map((value, primitiveIndex) => decodePrimitive(value, targetLists[primitiveIndex]!, meshIndex,
    primitiveIndex, names, reader, limits));
  return Object.freeze({ primitives: Object.freeze(primitives), initialWeights: Object.freeze(initialWeights), targetCount });
}

function decodePrimitive(value: unknown, targets: readonly unknown[], meshIndex: number, primitiveIndex: number,
  names: readonly string[], reader: MorphAccessorReader, limits: GltfMorphImportConfiguration): MorphPrimitiveSource {
  const path = `meshes[${meshIndex}].primitives[${primitiveIndex}]`, primitive = object(value, path);
  if (primitive.mode !== undefined && primitive.mode !== 4) unsupported(`${path}.mode`, "non-triangle morph topology");
  const attributes = object(primitive.attributes, `${path}.attributes`);
  if (attributes.POSITION === undefined) invalid(`${path}.attributes.POSITION`, "Morph primitive requires POSITION.");
  const vertexCount = reader.validateBase(attributes.POSITION, "VEC3", limits.maxVerticesPerPrimitive, `${path}.attributes.POSITION`);
  const targetObjects = targets.map((value, targetIndex) => {
    const targetPath = `${path}.targets[${targetIndex}]`, target = object(value, targetPath), names = Object.keys(target);
    for (const semantic of names) if (semantic !== "POSITION" && semantic !== "NORMAL" && semantic !== "TANGENT") {
      unsupported(`${targetPath}.${semantic}`, `morph target semantic ${semantic}`);
    }
    if (names.length === 0) invalid(targetPath, "Morph target must contain at least one delta attribute.");
    if (target.NORMAL !== undefined && attributes.NORMAL === undefined) invalid(targetPath, "NORMAL morph deltas require a base NORMAL attribute.");
    if (target.TANGENT !== undefined && attributes.TANGENT === undefined) invalid(targetPath, "TANGENT morph deltas require a base TANGENT attribute.");
    return target;
  });
  if (targetObjects.some((target) => target.NORMAL !== undefined)) assertCount(reader.validateBase(attributes.NORMAL, "VEC3",
    limits.maxVerticesPerPrimitive, `${path}.attributes.NORMAL`), vertexCount, path);
  if (targetObjects.some((target) => target.TANGENT !== undefined)) assertCount(reader.validateBase(attributes.TANGENT, "VEC4",
    limits.maxVerticesPerPrimitive, `${path}.attributes.TANGENT`), vertexCount, path);
  const decodedTargets = targetObjects.map((target, targetIndex) => {
    const targetPath = `${path}.targets[${targetIndex}]`;
    const position = delta(target.POSITION, vertexCount, reader, limits, `${targetPath}.POSITION`);
    const normal = delta(target.NORMAL, vertexCount, reader, limits, `${targetPath}.NORMAL`);
    const tangent = delta(target.TANGENT, vertexCount, reader, limits, `${targetPath}.TANGENT`);
    return Object.freeze({ index: targetIndex, name: names[targetIndex]!,
      ...(position ? { positionDeltas: position } : {}), ...(normal ? { normalDeltas: normal } : {}),
      ...(tangent ? { tangentDeltas: tangent } : {}) });
  });
  return Object.freeze({ id: `${limits.resourcePrefix}/mesh/${meshIndex}/primitive/${primitiveIndex}`,
    sourceMeshIndex: meshIndex, sourcePrimitiveIndex: primitiveIndex, vertexCount, targets: Object.freeze(decodedTargets) });
}

function bindNodes<TId extends SpatialItemId>(selection: AnimationNodeSelection<TId>, sourceNodes: readonly unknown[],
  sourceMeshes: readonly unknown[], meshes: ReadonlyMap<number, DecodedMorphMesh>, reader: MorphAccessorReader): GltfMorphBinding<TId>[] {
  const bindings: GltfMorphBinding<TId>[] = [];
  for (const selected of selection.nodes) {
    const path = `nodes[${selected.sourceNodeIndex}]`, node = object(sourceNodes[selected.sourceNodeIndex], path);
    if (node.mesh === undefined) continue;
    const meshIndex = reference(sourceMeshes, node.mesh, `${path}.mesh`), mesh = meshes.get(meshIndex);
    if (!mesh) {
      if (node.weights !== undefined) invalid(`${path}.weights`, "Node weights require morph targets.");
      continue;
    }
    const initial = weights(node.weights ?? mesh.initialWeights, mesh.targetCount, `${path}.weights`);
    reader.reserve(initial.length * 4);
    bindings.push(Object.freeze({ sourceNodeIndex: selected.sourceNodeIndex, nodeId: selected.id, sourceMeshIndex: meshIndex,
      primitiveIds: Object.freeze(mesh.primitives.map(({ id }) => id)), initialWeights: new Float32Array(initial) }));
  }
  return bindings;
}

function decodeWeightAnimations<TId extends SpatialItemId>(document: JsonObject, selection: AnimationNodeSelection<TId>,
  targetCounts: ReadonlyMap<number, number>, reader: MorphAccessorReader, limits: GltfMorphImportConfiguration,
  handledTransforms: boolean): MorphWeightClip<TId>[] {
  const sourceNodes = list(document.nodes, "nodes", limits.maxNodes), animations = list(document.animations, "animations", limits.maxAnimations);
  const clips: MorphWeightClip<TId>[] = [];
  animations.forEach((value, animationIndex) => {
    const path = `animations[${animationIndex}]`, animation = object(value, path); noExtensions(animation, path);
    if (animation.name !== undefined && typeof animation.name !== "string") invalid(`${path}.name`, "Animation name must be a string.");
    const samplers = array(animation.samplers, `${path}.samplers`, limits.maxChannelsPerAnimation)
      .map((entry, index) => morphSampler(entry, `${path}.samplers[${index}]`));
    const channels = array(animation.channels, `${path}.channels`, limits.maxChannelsPerAnimation), seen = new Set<number>();
    if (samplers.length === 0 || channels.length === 0) invalid(path, "Animations require at least one sampler and channel.");
    const usedSamplers = new Set<number>();
    const tracks: MorphWeightTrack<TId>[] = []; let duration = 0;
    channels.forEach((value, channelIndex) => {
      const channelPath = `${path}.channels[${channelIndex}]`, channel = object(value, channelPath); noExtensions(channel, channelPath);
      const samplerIndex = reference(samplers, channel.sampler, `${channelPath}.sampler`), target = object(channel.target, `${channelPath}.target`);
      usedSamplers.add(samplerIndex);
      noExtensions(target, `${channelPath}.target`);
      const nodeIndex = reference(sourceNodes, target.node, `${channelPath}.target.node`);
      if (target.path !== "weights") {
        if (!handledTransforms) unsupported(`${channelPath}.target.path`, "transform animation in morph-only import");
        return;
      }
      if (!selection.selected.has(nodeIndex)) invalid(`${channelPath}.target.node`, "Morph animation target is outside the selected scene.");
      if (seen.has(nodeIndex)) invalid(channelPath, "Animation has a duplicate weights channel for the same node.");
      seen.add(nodeIndex);
      const targetCount = targetCounts.get(nodeIndex);
      if (targetCount === undefined) invalid(`${channelPath}.target.node`, "Morph animation target node has no morph binding.");
      const sampler = samplers[samplerIndex]!, multiplier = sampler.interpolation === "CUBICSPLINE" ? 3 : 1;
      const times = reader.readScalar(sampler.input, limits.maxKeysPerTrack, `${path}.samplers[${samplerIndex}].input`);
      validateTimes(times.values, `${path}.samplers[${samplerIndex}].input`);
      const maximumValues = limits.maxKeysPerTrack * targetCount * multiplier;
      const values = reader.readScalar(sampler.output, maximumValues, `${path}.samplers[${samplerIndex}].output`);
      if (values.count !== times.count * targetCount * multiplier) invalid(`${path}.samplers[${samplerIndex}].output`, "Morph animation output count does not match keys, targets, and interpolation.");
      duration = Math.max(duration, times.values[times.values.length - 1]!);
      tracks.push(Object.freeze({ nodeId: selection.ids.get(nodeIndex)!, targetCount, interpolation: sampler.interpolation,
        times: times.values, values: values.values }));
    });
    if (usedSamplers.size !== samplers.length) invalid(`${path}.samplers`, "Animation contains an unused sampler.");
    if (tracks.length > 0) clips.push(Object.freeze({ id: `${limits.clipPrefix}/morph-animation/${animationIndex}`, duration,
      tracks: Object.freeze(tracks) }));
  });
  return clips;
}

function morphSampler(value: unknown, path: string): MorphSampler {
  const sampler = object(value, path); noExtensions(sampler, path);
  const interpolation = sampler.interpolation ?? "LINEAR";
  if (interpolation !== "STEP" && interpolation !== "LINEAR" && interpolation !== "CUBICSPLINE") unsupported(`${path}.interpolation`, `animation interpolation ${String(interpolation)}`);
  if (sampler.input === undefined || sampler.output === undefined) invalid(path, "Animation sampler input and output are required.");
  return Object.freeze({ input: sampler.input, output: sampler.output, interpolation });
}

function delta(value: unknown, count: number, reader: MorphAccessorReader, limits: GltfMorphImportConfiguration,
  path: string): Float32Array<ArrayBuffer> | undefined {
  if (value === undefined) return undefined;
  const result = reader.readDelta(value, limits.maxVerticesPerPrimitive, path); assertCount(result.count, count, path); return result.values;
}
function weights(value: unknown, count: number, path: string): number[] {
  const values = value === undefined ? Array<number>(count).fill(0) : array(value, path, count);
  if (values.length !== count || values.some((entry) => typeof entry !== "number" || !Number.isFinite(entry) || !Number.isFinite(Math.fround(entry)))) {
    invalid(path, `Expected ${count} finite float32 morph weights.`);
  }
  return (values as number[]).slice();
}
function targetNames(mesh: JsonObject, count: number, path: string): readonly string[] {
  const value = targetNameValue(mesh);
  if (value === undefined) return Object.freeze(Array.from({ length: count }, (_, index) => `target/${index}`));
  const names = array(value, `${path}.extras.targetNames`, count);
  if (names.length !== count || names.some((name) => typeof name !== "string" || name.length < 1 || name.length > 256)
    || new Set(names).size !== names.length) invalid(`${path}.extras.targetNames`, "Target names must be unique nonempty strings matching target count.");
  return Object.freeze((names as string[]).slice());
}
function targetNameValue(mesh: JsonObject): unknown {
  if (!mesh.extras || typeof mesh.extras !== "object" || Array.isArray(mesh.extras)) return undefined;
  return (mesh.extras as JsonObject).targetNames;
}
function validateTimes(values: Float32Array, path: string): void {
  for (let index = 0; index < values.length; index += 1) if (values[index]! < 0 || (index > 0 && values[index]! <= values[index - 1]!)) {
    invalid(path, "Morph animation input times must be non-negative and strictly increasing.");
  }
}
function assertCount(value: number, expected: number, path: string): void { if (value !== expected) invalid(path, "Morph attribute counts must match POSITION."); }
function numberOrder(left: number, right: number): number { return left - right; }
