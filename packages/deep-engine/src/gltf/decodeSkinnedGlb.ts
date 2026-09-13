import type { SpatialItemId } from "../spatial/types.js";
import { validateAnimationDocument } from "./animationImportValidation.js";
import { selectAnimationNodes, type AnimationNodeSelection } from "./animationNodes.js";
import { parseGlb } from "./parseGlb.js";
import { SkinAccessorReader } from "./skinAccessors.js";
import { resolveSkinOptions } from "./skinImportValidation.js";
import {
  GLTF_SKINNING_SOURCE_ABI_VERSION,
  type DecodedSkinnedGlb,
  type GltfSkin,
  type GltfSkinBinding,
  type GltfSkinImportConfiguration,
  type GltfSkinImportOptions,
  type GltfSkinPrimitive,
} from "./skinTypes.js";
import { array, budget, invalid, list, noExtensions, object, reference, unsupported, validateJson, type JsonObject } from "./validation.js";

interface PendingBinding<TId extends SpatialItemId> {
  readonly sourceNodeIndex: number;
  readonly nodeId: TId;
  readonly sourceSkinIndex: number;
  readonly sourceMeshIndex: number;
}
interface DecodedPrimitive {
  readonly output: GltfSkinPrimitive;
  readonly maximumJoint: number;
}

/** Decodes embedded glTF 2.0 skin palettes and four-influence vertex streams without IO. */
export function decodeSkinnedGlb<TNodeId extends SpatialItemId = number>(
  bytes: Uint8Array,
  options: GltfSkinImportOptions<TNodeId> = {},
): DecodedSkinnedGlb<TNodeId> {
  const parsed = parseGlb(bytes);
  validateJson(parsed.json);
  const document = validateAnimationDocument(parsed.json);
  return decodeSkinnedDocument(document, parsed.buffers, options);
}

/** Internal parsed-document entry used by composite importers to avoid reparsing GLB bytes. */
export function decodeSkinnedDocument<TNodeId extends SpatialItemId = number>(
  document: JsonObject,
  buffers: readonly Uint8Array[],
  options: GltfSkinImportOptions<TNodeId> = {},
  selectedNodes?: AnimationNodeSelection<TNodeId>,
): DecodedSkinnedGlb<TNodeId> {
  const configuration = resolveSkinOptions(options);
  const selection = selectedNodes ?? selectAnimationNodes(document, options, configuration.maxNodes);
  const sourceNodes = list(document.nodes, "nodes", configuration.maxNodes);
  const sourceSkins = list(document.skins, "skins", configuration.maxSkins);
  const sourceMeshes = list(document.meshes, "meshes", 16_384);
  const pending = collectBindings(selection, sourceNodes, sourceSkins, sourceMeshes, configuration);
  const reader = new SkinAccessorReader(document, buffers, configuration);
  const usedSkinIndices = [...new Set(pending.map((binding) => binding.sourceSkinIndex))].sort(numberOrder);
  const skins = usedSkinIndices.map((index) => decodeSkin(sourceSkins[index], index, sourceNodes, selection, reader, configuration));
  const skinsByIndex = new Map(skins.map((skin) => [skin.sourceSkinIndex, skin] as const));
  const usedMeshIndices = [...new Set(pending.map((binding) => binding.sourceMeshIndex))].sort(numberOrder);
  let primitiveCount = 0;
  const primitivesByMesh = new Map<number, readonly DecodedPrimitive[]>();
  for (const meshIndex of usedMeshIndices) {
    const decoded = decodeMesh(sourceMeshes[meshIndex], meshIndex, reader, configuration, primitiveCount);
    primitiveCount += decoded.length;
    primitivesByMesh.set(meshIndex, decoded);
  }
  const bindings = pending.map((binding) => bind(binding, skinsByIndex, primitivesByMesh));
  const primitives = usedMeshIndices.flatMap((meshIndex) => primitivesByMesh.get(meshIndex)!.map(({ output }) => output));
  return Object.freeze({ abiVersion: GLTF_SKINNING_SOURCE_ABI_VERSION, sceneIndex: selection.sceneIndex, nodes: selection.nodes,
    skins: Object.freeze(skins), primitives: Object.freeze(primitives), bindings: Object.freeze(bindings), decodedBytes: reader.decodedBytes });
}

function collectBindings<TId extends SpatialItemId>(
  selection: AnimationNodeSelection<TId>,
  sourceNodes: readonly unknown[],
  sourceSkins: readonly unknown[],
  sourceMeshes: readonly unknown[],
  limits: GltfSkinImportConfiguration,
): PendingBinding<TId>[] {
  const result: PendingBinding<TId>[] = [];
  for (const selected of selection.nodes) {
    const path = `nodes[${selected.sourceNodeIndex}]`, node = object(sourceNodes[selected.sourceNodeIndex], path);
    if (node.skin === undefined) continue;
    budget(result.length + 1, limits.maxSkinnedNodes, "skinnedNodes");
    const sourceSkinIndex = reference(sourceSkins, node.skin, `${path}.skin`);
    if (node.mesh === undefined) invalid(path, "A node with skin must reference a mesh.");
    const sourceMeshIndex = reference(sourceMeshes, node.mesh, `${path}.mesh`);
    result.push(Object.freeze({ sourceNodeIndex: selected.sourceNodeIndex, nodeId: selected.id, sourceSkinIndex, sourceMeshIndex }));
  }
  return result;
}

function decodeSkin<TId extends SpatialItemId>(
  value: unknown,
  skinIndex: number,
  sourceNodes: readonly unknown[],
  selection: AnimationNodeSelection<TId>,
  reader: SkinAccessorReader,
  limits: GltfSkinImportConfiguration,
): GltfSkin<TId> {
  const path = `skins[${skinIndex}]`, skin = object(value, path);
  noExtensions(skin, path);
  if (skin.name !== undefined && typeof skin.name !== "string") invalid(`${path}.name`, "Skin name must be a string.");
  const jointEntries = array(skin.joints, `${path}.joints`, limits.maxJointsPerSkin);
  if (jointEntries.length === 0) invalid(`${path}.joints`, "Skin must contain at least one joint.");
  const sourceJoints = jointEntries.map((entry, index) => reference(sourceNodes, entry, `${path}.joints[${index}]`));
  if (new Set(sourceJoints).size !== sourceJoints.length) invalid(`${path}.joints`, "Skin joints must be unique.");
  for (const joint of sourceJoints) if (!selection.selected.has(joint)) invalid(`${path}.joints`, "Every skin joint must be reachable from the selected scene.");
  const sourceSkeleton = skin.skeleton === undefined ? null : reference(sourceNodes, skin.skeleton, `${path}.skeleton`);
  if (sourceSkeleton !== null && !selection.selected.has(sourceSkeleton)) invalid(`${path}.skeleton`, "Skin skeleton must be reachable from the selected scene.");
  reader.reserve(sourceJoints.length * 4, "skins.decodedBytes");
  const sourceJointIndices = new Uint32Array(sourceJoints);
  let inverseBindMatrices: Float32Array<ArrayBuffer>;
  if (skin.inverseBindMatrices === undefined) {
    reader.reserve(sourceJoints.length * 64, "skins.decodedBytes");
    inverseBindMatrices = identityMatrices(sourceJoints.length);
  } else {
    const matrices = reader.readInverseBindMatrices(skin.inverseBindMatrices, limits.maxJointsPerSkin, `${path}.inverseBindMatrices`);
    if (matrices.count !== sourceJoints.length) invalid(`${path}.inverseBindMatrices`, "Inverse bind matrix count must equal the joint count.");
    inverseBindMatrices = matrices.values;
  }
  return Object.freeze({
    id: `${limits.resourcePrefix}/skin/${skinIndex}`,
    sourceSkinIndex: skinIndex,
    sourceJointIndices,
    joints: Object.freeze(sourceJoints.map((joint) => selection.ids.get(joint)!)),
    sourceSkeletonIndex: sourceSkeleton,
    skeleton: sourceSkeleton === null ? null : selection.ids.get(sourceSkeleton)!,
    inverseBindMatrices,
  });
}

function decodeMesh(value: unknown, meshIndex: number, reader: SkinAccessorReader,
  limits: GltfSkinImportConfiguration, priorCount: number): readonly DecodedPrimitive[] {
  const path = `meshes[${meshIndex}]`, mesh = object(value, path);
  noExtensions(mesh, path);
  if (mesh.weights !== undefined) unsupported(`${path}.weights`, "morph weights");
  const primitives = array(mesh.primitives, `${path}.primitives`, 4_096);
  budget(priorCount + primitives.length, limits.maxPrimitives, "skinPrimitives");
  if (primitives.length === 0) invalid(path, "A skinned mesh must contain at least one primitive.");
  return Object.freeze(primitives.map((value, primitiveIndex) => {
    const location = `${path}.primitives[${primitiveIndex}]`, primitive = object(value, location);
    noExtensions(primitive, location);
    if (primitive.mode !== undefined && primitive.mode !== 4) unsupported(`${location}.mode`, "non-triangle skinned topology");
    if (primitive.targets !== undefined) unsupported(`${location}.targets`, "morph targets");
    const attributes = object(primitive.attributes, `${location}.attributes`);
    for (const name of Object.keys(attributes)) {
      if ((name.startsWith("JOINTS_") && name !== "JOINTS_0") || (name.startsWith("WEIGHTS_") && name !== "WEIGHTS_0")) {
        unsupported(`${location}.attributes.${name}`, "more than four skin influences");
      }
    }
    if (attributes.POSITION === undefined) invalid(`${location}.attributes.POSITION`, "Skinned primitive requires POSITION.");
    if (attributes.JOINTS_0 === undefined || attributes.WEIGHTS_0 === undefined) {
      invalid(`${location}.attributes`, "Skinned primitive requires JOINTS_0 and WEIGHTS_0.");
    }
    const vertexCount = reader.validatePosition(attributes.POSITION, limits.maxVerticesPerPrimitive, `${location}.attributes.POSITION`);
    const joints = reader.readJoints(attributes.JOINTS_0, limits.maxVerticesPerPrimitive, `${location}.attributes.JOINTS_0`);
    const weights = reader.readWeights(attributes.WEIGHTS_0, limits.maxVerticesPerPrimitive, `${location}.attributes.WEIGHTS_0`);
    if (joints.count !== vertexCount || weights.count !== vertexCount) invalid(location, "POSITION, JOINTS_0 and WEIGHTS_0 counts must match.");
    let maximumJoint = 0;
    for (const joint of joints.values) maximumJoint = Math.max(maximumJoint, joint);
    const id = `${limits.resourcePrefix}/mesh/${meshIndex}/primitive/${primitiveIndex}`;
    return Object.freeze({ maximumJoint, output: Object.freeze({ id, sourceMeshIndex: meshIndex,
      sourcePrimitiveIndex: primitiveIndex, vertexCount, joints: joints.values, weights: weights.values }) });
  }));
}

function bind<TId extends SpatialItemId>(pending: PendingBinding<TId>, skins: ReadonlyMap<number, GltfSkin<TId>>,
  primitives: ReadonlyMap<number, readonly DecodedPrimitive[]>): GltfSkinBinding<TId> {
  const skin = skins.get(pending.sourceSkinIndex)!, meshPrimitives = primitives.get(pending.sourceMeshIndex)!;
  for (const primitive of meshPrimitives) if (primitive.maximumJoint >= skin.joints.length) {
    invalid(`meshes[${pending.sourceMeshIndex}].primitives[${primitive.output.sourcePrimitiveIndex}].attributes.JOINTS_0`,
      "Joint palette index exceeds the bound skin joint count.");
  }
  return Object.freeze({ sourceNodeIndex: pending.sourceNodeIndex, nodeId: pending.nodeId,
    sourceSkinIndex: skin.sourceSkinIndex, skinId: skin.id, sourceMeshIndex: pending.sourceMeshIndex,
    primitiveIds: Object.freeze(meshPrimitives.map(({ output }) => output.id)) });
}

function identityMatrices(count: number): Float32Array<ArrayBuffer> {
  const values = new Float32Array(count * 16);
  for (let index = 0; index < count; index += 1) {
    const base = index * 16;
    values[base] = 1; values[base + 5] = 1; values[base + 10] = 1; values[base + 15] = 1;
  }
  return values;
}

function numberOrder(left: number, right: number): number { return left - right; }
