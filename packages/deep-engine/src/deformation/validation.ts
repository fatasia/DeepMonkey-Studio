import { prepareMorphInput } from "../webgpu/gpuMorphPacking.js";
import { prepareSkinningInput, validateSkinTangents } from "../webgpu/gpuSkinningPacking.js";
import type { DeformationSnapshot, DeformationSource } from "./types.js";

export { shape as validateDeformationObject };

/** Candidate preparation only: existing GPU packers also check numeric output limits. */
export function validateDeformationSnapshot(snapshot: DeformationSnapshot): void {
  shape(snapshot, ["sources", "poses"]);
  if (!Array.isArray(snapshot.sources) || !Array.isArray(snapshot.poses)) fail("Source and pose lists are required.");
  const sources = new Map<string, DeformationSource>();
  for (const source of snapshot.sources) {
    validateSource(source);
    if (sources.has(source.id)) fail(`Duplicate source ${source.id}.`);
    sources.set(source.id, source);
  }
  const poses = new Set<string>();
  for (const pose of snapshot.poses) {
    shape(pose, ["id", "source", "revision", "morphWeights", "palette"]);
    id(pose.id); id(pose.source); revision(pose.revision);
    if (poses.has(pose.id)) fail(`Duplicate pose ${pose.id}.`);
    poses.add(pose.id);
    const source = sources.get(pose.source);
    if (!source) fail(`Unknown deformation source ${pose.source}.`);
    if (Boolean(source.morph) !== (pose.morphWeights !== undefined)
      || Boolean(source.skinning) !== (pose.palette !== undefined)) fail("Pose fields do not match source kind.");
    if (pose.morphWeights !== undefined) {
      shape(pose.morphWeights, ["revision", "values"]);
      prepareMorphInput(source.morph!, pose.morphWeights);
    }
    if (pose.palette !== undefined) {
      shape(pose.palette, ["revision", "matrices", "normalMatrices"]);
      prepareSkinningInput(source.skinning!, pose.palette);
    }
  }
}

/** Arrays are privately copied; callers must treat returned typed arrays as read-only. */
export function snapshotDeformation(snapshot: DeformationSnapshot): DeformationSnapshot {
  validateDeformationSnapshot(snapshot);
  return copy(snapshot);
}

function validateSource(source: DeformationSource): void {
  shape(source, ["id", "revision", "geometry", "kind", "semantics", "morph", "skinning"]);
  id(source.id); id(source.geometry); revision(source.revision);
  if (source.semantics !== "three-r185" || !["morph", "skin", "morph-skin"].includes(source.kind)) fail("Invalid deformation semantics or kind.");
  if ((source.kind !== "skin") !== (source.morph !== undefined)
    || (source.kind !== "morph") !== (source.skinning !== undefined)) fail("Source fields do not match kind.");
  if (source.morph !== undefined) {
    const morph = source.morph;
    shape(morph, ["revision", "primitive", "positions", "normals", "tangents"]);
    shape(morph.primitive, ["id", "sourceMeshIndex", "sourcePrimitiveIndex", "vertexCount", "targets"]);
    id(morph.primitive.id); revision(morph.primitive.sourceMeshIndex); revision(morph.primitive.sourcePrimitiveIndex);
    if (!Array.isArray(morph.primitive.targets)) fail("Morph targets are required.");
    for (const target of morph.primitive.targets) {
      shape(target, ["index", "name", "positionDeltas", "normalDeltas", "tangentDeltas"]);
      if (typeof target.name !== "string") fail("Morph target name must be a string.");
    }
    prepareMorphInput(morph, { revision: 0, values: new Float32Array(morph.primitive.targets.length) });
  }
  if (source.skinning !== undefined) {
    const skin = source.skinning;
    shape(skin, ["revision", "positions", "normals", "tangents", "joints", "weights", "weightMode"]);
    revision(skin.revision);
    if (skin.weightMode !== undefined && skin.weightMode !== "normalize" && skin.weightMode !== "preserve") fail("Invalid skin weight mode.");
    floats(skin.positions); floats(skin.normals); floats(skin.weights);
    if (!(skin.joints instanceof Uint16Array || skin.joints instanceof Uint32Array)
      || !(skin.joints.buffer instanceof ArrayBuffer)) fail("Skin joints must be unshared integer arrays.");
    const count = skin.positions.length / 3;
    if (!Number.isInteger(count) || count < 1 || count > 16_000_000 || skin.normals.length !== count * 3
      || skin.joints.length !== count * 4 || skin.weights.length !== count * 4) fail("Skin vertex counts do not match.");
    validateSkinTangents(skin.tangents, skin.normals);
    for (let vertex = 0; vertex < count; vertex++) {
      const normal = vertex * 3, weights = vertex * 4;
      if (Math.hypot(skin.normals[normal]!, skin.normals[normal + 1]!, skin.normals[normal + 2]!) < 1e-8) fail("Degenerate skin normal.");
      let sum = 0;
      for (let lane = 0; lane < 4; lane++) {
        const weight = skin.weights[weights + lane]!;
        if (weight < 0 || skin.joints[weights + lane]! >= 65_535) fail("Invalid skin weight or joint.");
        sum += weight;
      }
      if (sum < 1e-8) fail("Skin vertex has zero total weight.");
    }
  }
  if (source.morph && source.skinning) {
    equal(source.morph.positions, source.skinning.positions, "Fused base positions");
    if (!source.morph.normals) fail("Fused morph source requires base normals.");
    equal(source.morph.normals, source.skinning.normals, "Fused base normals");
  }
}

function equal(a: Float32Array, b: Float32Array, label: string): void {
  if (a.length !== b.length || a.some((value, index) => value !== b[index])) fail(`${label} do not match.`);
}
function floats(value: unknown): asserts value is Float32Array<ArrayBuffer> {
  if (!(value instanceof Float32Array) || !(value.buffer instanceof ArrayBuffer)
    || value.some(item => !Number.isFinite(item))) fail("Expected finite unshared Float32Array.");
}
function shape(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("Expected a plain deformation object.");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) fail(`Unknown deformation field ${String(key)}.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail("Deformation fields must be enumerable data properties.");
  }
}
function id(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) fail("Deformation ID must be nonempty.");
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) fail("Deformation revision/index must be a nonnegative safe integer.");
}
function fail(message: string): never { throw new Error(message); }
function copy<T>(value: T): T {
  if (value instanceof Float32Array) return value.slice() as T;
  if (value instanceof Uint16Array || value instanceof Uint32Array) return value.slice() as T;
  if (Array.isArray(value)) return Object.freeze(value.map(item => copy(item))) as T;
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]))) as T;
  }
  return value;
}
