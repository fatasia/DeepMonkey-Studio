import { sampleMorphWeightTrack } from "../morph/runtime.js";
import type { MorphWeightClip } from "../morph/types.js";
import type { InstanceUpdate, RenderInstance } from "../renderPacketTypes.js";
import { SceneTransformGraph } from "../scene/SceneTransformGraph.js";
import type { SpatialItemId } from "../spatial/types.js";
import type { GltfMorphBinding } from "./morphTypes.js";
import type {
  GltfMorphSkinningFrame, GltfMorphWeightsFrame, GltfRenderAnimationBridgeOptions, GltfRenderAnimationFrame,
  GltfRenderNodeFrame, GltfSkinPaletteFrame, ResolvedGltfRenderAnimationSources,
} from "./renderAnimationBridgeTypes.js";
import { GltfRenderAnimationBridgeError } from "./renderAnimationBridgeTypes.js";
import type { GltfSkin, GltfSkinBinding } from "./skinTypes.js";

interface MutableRevision { revision: number }
interface MutableFrame<TId extends SpatialItemId> extends GltfRenderAnimationFrame<TId> { revision: number; time: number; paused: boolean }
interface SkinLayout<TId extends SpatialItemId> { readonly binding: GltfSkinBinding<TId>; readonly skin: GltfSkin<TId> }

export interface BridgeLayout<TId extends SpatialItemId> {
  readonly source: ResolvedGltfRenderAnimationSources<TId>;
  readonly nodeIndices: ReadonlyMap<TId, number>;
  readonly skins: readonly SkinLayout<TId>[];
  readonly morphs: readonly GltfMorphBinding<TId>[];
  readonly morphIndices: ReadonlyMap<TId, number>;
  readonly inverseScratch: Float64Array<ArrayBuffer>;
  readonly multiplyScratch: Float64Array<ArrayBuffer>;
}
export interface BridgeBank<TId extends SpatialItemId> {
  readonly frame: MutableFrame<TId>;
  readonly worlds: Float32Array<ArrayBuffer>;
}

export function createBridgeLayout<TId extends SpatialItemId>(source: ResolvedGltfRenderAnimationSources<TId>): BridgeLayout<TId> {
  const nodeIndices = new Map<TId, number>();
  source.nodes.forEach((node, index) => nodeIndices.set(node.id, index));
  const skinsById = new Map<string, GltfSkin<TId>>(), skinSourceIndices = new Set<number>();
  for (const skin of source.skinning?.skins ?? []) {
    if (!skin.id || skinsById.has(skin.id) || skinSourceIndices.has(skin.sourceSkinIndex)) fail("duplicate-binding", `Duplicate skin identity: ${skin.id}.`);
    skinsById.set(skin.id, skin); skinSourceIndices.add(skin.sourceSkinIndex);
  }
  const skinPrimitiveIds = new Set<string>(), skins: SkinLayout<TId>[] = [];
  const skinNodes = new Set<TId>(), skinPrimitives = new Map((source.skinning?.primitives ?? []).map((primitive) => [primitive.id, primitive] as const));
  for (const binding of source.skinning?.bindings ?? []) {
    const skin = skinsById.get(binding.skinId);
    if (!skin || !nodeIndices.has(binding.nodeId) || skin.joints.some((joint) => !nodeIndices.has(joint))) {
      fail("invalid-binding", "Skin binding references an unknown skin or scene node.");
    }
    if (skin.sourceSkinIndex !== binding.sourceSkinIndex || skinNodes.has(binding.nodeId)
      || binding.primitiveIds.some((id) => !skinPrimitives.has(id))) fail("invalid-binding", "Skin binding identity is inconsistent.");
    skinNodes.add(binding.nodeId);
    if (!(skin.inverseBindMatrices instanceof Float32Array) || skin.inverseBindMatrices.length !== skin.joints.length * 16) {
      fail("invalid-binding", `Skin ${skin.id} inverse-bind layout is invalid.`);
    }
    uniquePrimitives(binding.primitiveIds, skinPrimitiveIds, "skin");
    skins.push({ binding, skin });
  }
  const morphs = [...(source.morph?.bindings ?? [])], morphPrimitiveIds = new Set<string>(), morphIndices = new Map<TId, number>();
  const morphPrimitives = new Map((source.morph?.primitives ?? []).map((primitive) => [primitive.id, primitive] as const));
  for (let index = 0; index < morphs.length; index += 1) {
    const binding = morphs[index]!; uniquePrimitives(binding.primitiveIds, morphPrimitiveIds, "morph");
    if (binding.primitiveIds.some((id) => morphPrimitives.get(id)?.targets.length !== binding.initialWeights.length)
      || [...binding.initialWeights].some((value) => !Number.isFinite(value))) fail("invalid-binding", "Morph binding and primitive targets are inconsistent.");
    morphIndices.set(binding.nodeId, index);
  }
  return { source, nodeIndices, skins, morphs, morphIndices, inverseScratch: new Float64Array(16), multiplyScratch: new Float64Array(16) };
}

export function createBridgeBank<TId extends SpatialItemId>(layout: BridgeLayout<TId>, options: GltfRenderAnimationBridgeOptions<TId>): BridgeBank<TId> {
  const worlds = new Float32Array(layout.source.nodes.length * 16);
  const nodeWorldTransforms: GltfRenderNodeFrame<TId>[] = layout.source.nodes.map((node, index) => Object.freeze({
    nodeId: node.id, worldTransform: worldView(worlds, index),
  }));
  const skinPalettes = layout.skins.map(({ binding, skin }) => {
    const palette: MutableRevision & { matrices: Float32Array<ArrayBuffer>; normalMatrices: Float32Array<ArrayBuffer> } = {
      revision: 0, matrices: new Float32Array(skin.joints.length * 16), normalMatrices: new Float32Array(skin.joints.length * 12),
    };
    return Object.freeze({ nodeId: binding.nodeId, skinId: binding.skinId, primitiveIds: binding.primitiveIds, palette });
  });
  const morphWeights = layout.morphs.map((binding) => {
    const weights: MutableRevision & { values: Float32Array<ArrayBuffer> } = {
      revision: 0, values: new Float32Array(binding.initialWeights.length),
    };
    return Object.freeze({ nodeId: binding.nodeId, primitiveIds: binding.primitiveIds, weights });
  });
  const morphSkinning = pairedDynamics(skinPalettes, morphWeights);
  const instanceUpdate = options.instances ? projectInstances(options.instances.materials, options.instances.bindings, nodeWorldTransforms) : undefined;
  const frame: MutableFrame<TId> = { revision: 0, time: 0, paused: false, nodeWorldTransforms: Object.freeze(nodeWorldTransforms),
    skinPalettes: Object.freeze(skinPalettes), morphWeights: Object.freeze(morphWeights), morphSkinning,
    ...(instanceUpdate ? { instanceUpdate } : {}) };
  return { frame, worlds };
}

export function fillBridgeBank<TId extends SpatialItemId>(bank: BridgeBank<TId>, layout: BridgeLayout<TId>, graph: SceneTransformGraph<TId>,
  morphClip: MorphWeightClip<TId> | null, time: number, wrapMode: "loop" | "clamp"): void {
  for (let index = 0; index < layout.source.nodes.length; index += 1) {
    const node = layout.source.nodes[index]!, snapshot = graph.getNode(node.id);
    if (!snapshot) fail("missing-node", `Animation graph lost node ${String(node.id)}.`);
    if (snapshot.worldMatrix.some((value) => !Number.isFinite(Math.fround(value)))) {
      fail("singular-transform", `Node ${String(node.id)} world transform exceeds finite float32 range.`);
    }
    bank.frame.nodeWorldTransforms[index]!.worldTransform.set(snapshot.worldMatrix);
  }
  fillMorphs(bank.frame.morphWeights, layout.morphs, morphClip, time, wrapMode, layout.morphIndices);
  fillSkins(bank.frame.skinPalettes, layout, bank.worlds);
}

export function sameBridgeBank<TId extends SpatialItemId>(left: BridgeBank<TId>, right: BridgeBank<TId>): boolean {
  if (!sameArray(left.worlds, right.worlds)) return false;
  for (let index = 0; index < left.frame.skinPalettes.length; index += 1) {
    const a = left.frame.skinPalettes[index]!.palette, b = right.frame.skinPalettes[index]!.palette;
    if (!sameArray(a.matrices, b.matrices) || !sameArray(a.normalMatrices!, b.normalMatrices!)) return false;
  }
  return left.frame.morphWeights.every((entry, index) => sameArray(entry.weights.values, right.frame.morphWeights[index]!.weights.values));
}

export function initializeBankState<TId extends SpatialItemId>(bank: BridgeBank<TId>, revision: number, time: number, paused: boolean): void {
  bank.frame.revision = revision; bank.frame.time = time; bank.frame.paused = paused;
  for (const entry of bank.frame.skinPalettes) (entry.palette as MutableRevision).revision = revision;
  for (const entry of bank.frame.morphWeights) (entry.weights as MutableRevision).revision = revision;
}

export function commitBankState<TId extends SpatialItemId>(previous: BridgeBank<TId>, next: BridgeBank<TId>, revision: number,
  time: number, paused: boolean): void {
  next.frame.revision = revision; next.frame.time = time; next.frame.paused = paused;
  for (let index = 0; index < next.frame.skinPalettes.length; index += 1) {
    const before = previous.frame.skinPalettes[index]!.palette, after = next.frame.skinPalettes[index]!.palette;
    (after as MutableRevision).revision = before.revision + (sameArray(before.matrices, after.matrices)
      && sameArray(before.normalMatrices!, after.normalMatrices!) ? 0 : 1);
  }
  for (let index = 0; index < next.frame.morphWeights.length; index += 1) {
    const before = previous.frame.morphWeights[index]!.weights, after = next.frame.morphWeights[index]!.weights;
    (after as MutableRevision).revision = before.revision + (sameArray(before.values, after.values) ? 0 : 1);
  }
}

function fillMorphs<TId extends SpatialItemId>(outputs: readonly GltfMorphWeightsFrame<TId>[], bindings: readonly GltfMorphBinding<TId>[],
  clip: MorphWeightClip<TId> | null, time: number, wrapMode: "loop" | "clamp", indices?: ReadonlyMap<TId, number>): void {
  for (let index = 0; index < outputs.length; index += 1) outputs[index]!.weights.values.set(bindings[index]!.initialWeights);
  if (!clip) return;
  for (const track of clip.tracks) {
    const index = indices?.get(track.nodeId) ?? bindings.findIndex((binding) => Object.is(binding.nodeId, track.nodeId));
    if (index < 0) fail("invalid-binding", `Morph track references an unknown binding: ${String(track.nodeId)}.`);
    sampleMorphWeightTrack(track, time, { wrapMode }, outputs[index]!.weights.values);
  }
}

function fillSkins<TId extends SpatialItemId>(outputs: readonly GltfSkinPaletteFrame<TId>[], layout: BridgeLayout<TId>, worlds: Float32Array): void {
  const inverse = layout.inverseScratch, scratch = layout.multiplyScratch;
  for (let skinIndex = 0; skinIndex < layout.skins.length; skinIndex += 1) {
    const { binding, skin } = layout.skins[skinIndex]!, meshOffset = layout.nodeIndices.get(binding.nodeId)! * 16;
    if (!invertAffine(worlds, meshOffset, inverse)) fail("singular-transform", `Skinned node ${String(binding.nodeId)} has a singular world transform.`);
    const output = outputs[skinIndex]!.palette;
    for (let joint = 0; joint < skin.joints.length; joint += 1) {
      const jointOffset = layout.nodeIndices.get(skin.joints[joint]!)! * 16, destination = joint * 16;
      multiply(inverse, 0, worlds, jointOffset, scratch, 0);
      multiply(scratch, 0, skin.inverseBindMatrices, joint * 16, output.matrices, destination);
      inverseTranspose(output.matrices, destination, output.normalMatrices!, joint * 12, joint);
    }
  }
}

function pairedDynamics<TId extends SpatialItemId>(skins: readonly GltfSkinPaletteFrame<TId>[], morphs: readonly GltfMorphWeightsFrame<TId>[]): readonly GltfMorphSkinningFrame[] {
  const skinByPrimitive = new Map<string, GltfSkinPaletteFrame<TId>>();
  for (const skin of skins) for (const id of skin.primitiveIds) skinByPrimitive.set(id, skin);
  const result: GltfMorphSkinningFrame[] = [];
  for (const morph of morphs) for (const primitiveId of morph.primitiveIds) {
    const skin = skinByPrimitive.get(primitiveId);
    if (skin) result.push(Object.freeze({ primitiveId, dynamics: Object.freeze({ morphWeights: morph.weights, palette: skin.palette }) }));
  }
  return Object.freeze(result);
}

function projectInstances<TId extends SpatialItemId>(materials: InstanceUpdate["materials"], bindings: readonly { nodeId: TId; id: string; geometry: string; material: string }[],
  nodes: readonly GltfRenderNodeFrame<TId>[]): InstanceUpdate {
  const matrices = new Map(nodes.map((node) => [node.nodeId, node.worldTransform] as const));
  const instances: RenderInstance[] = bindings.map((binding) => Object.freeze({ id: binding.id, geometry: binding.geometry,
    material: binding.material, transform: matrices.get(binding.nodeId)! }));
  return Object.freeze({ materials, instances: Object.freeze(instances) });
}

function worldView(worlds: Float32Array<ArrayBuffer>, index: number): Float32Array<ArrayBuffer> {
  return worlds.subarray(index * 16, index * 16 + 16) as Float32Array<ArrayBuffer>;
}
function sameArray(left: Float32Array, right: Float32Array): boolean {
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
function uniquePrimitives(ids: readonly string[], seen: Set<string>, label: string): void {
  if (!Array.isArray(ids) || ids.length === 0) fail("invalid-binding", `${label} binding must contain primitive ids.`);
  const local = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || !id.length || local.has(id) || seen.has(id)) fail("duplicate-binding", `Invalid or duplicate ${label} primitive id: ${id}.`);
    local.add(id); seen.add(id);
  }
}
function fail(code: ConstructorParameters<typeof GltfRenderAnimationBridgeError>[0], message: string): never {
  throw new GltfRenderAnimationBridgeError(code, message);
}

function multiply(left: ArrayLike<number>, lo: number, right: ArrayLike<number>, ro: number, output: { [index: number]: number }, oo: number): void {
  for (let column = 0; column < 4; column += 1) for (let row = 0; row < 4; row += 1) {
    let value = 0; for (let axis = 0; axis < 4; axis += 1) value += left[lo + axis * 4 + row]! * right[ro + column * 4 + axis]!;
    if (!Number.isFinite(value) || !Number.isFinite(Math.fround(value))) fail("singular-transform", "Skin palette exceeded finite float32 range.");
    output[oo + column * 4 + row] = value;
  }
}

function invertAffine(value: ArrayLike<number>, offset: number, output: Float64Array): boolean {
  const a = value[offset]!, b = value[offset + 4]!, c = value[offset + 8]!, d = value[offset + 1]!, e = value[offset + 5]!, f = value[offset + 9]!,
    g = value[offset + 2]!, h = value[offset + 6]!, i = value[offset + 10]!;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, determinant = a * A + b * B + c * C;
  const conditioning = Math.hypot(a, d, g) * Math.hypot(b, e, h) * Math.hypot(c, f, i);
  if (!Number.isFinite(determinant) || !conditioning || Math.abs(determinant) / conditioning < 1e-10) return false;
  const inverse = 1 / determinant;
  output.set([A * inverse, B * inverse, C * inverse, 0, (c * h - b * i) * inverse, (a * i - c * g) * inverse,
    (b * g - a * h) * inverse, 0, (b * f - c * e) * inverse, (c * d - a * f) * inverse, (a * e - b * d) * inverse, 0, 0, 0, 0, 1]);
  const x = value[offset + 12]!, y = value[offset + 13]!, z = value[offset + 14]!;
  output[12] = -(output[0]! * x + output[4]! * y + output[8]! * z);
  output[13] = -(output[1]! * x + output[5]! * y + output[9]! * z);
  output[14] = -(output[2]! * x + output[6]! * y + output[10]! * z);
  return true;
}

function inverseTranspose(matrix: Float32Array, offset: number, output: Float32Array, destination: number, joint: number): void {
  const a = matrix[offset]!, b = matrix[offset + 4]!, c = matrix[offset + 8]!, d = matrix[offset + 1]!, e = matrix[offset + 5]!, f = matrix[offset + 9]!,
    g = matrix[offset + 2]!, h = matrix[offset + 6]!, i = matrix[offset + 10]!;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, determinant = a * A + b * B + c * C;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) fail("singular-transform", `Skin palette joint ${joint} is singular.`);
  const inverse = 1 / determinant;
  output.set([A * inverse, B * inverse, C * inverse, 0, (c * h - b * i) * inverse, (a * i - c * g) * inverse,
    (b * g - a * h) * inverse, 0, (b * f - c * e) * inverse, (c * d - a * f) * inverse, (a * e - b * d) * inverse, 0], destination);
}
