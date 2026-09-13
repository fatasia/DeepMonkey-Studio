import type { SceneLocalTransform, SceneMatrix4, SceneQuaternion } from "../scene/types.js";
import { validateSpatialId } from "../spatial/octreeInternals.js";
import type { SpatialItemId, SpatialVec3 } from "../spatial/types.js";
import type { GltfAnimatedNode, GltfAnimationImportOptions } from "./animationTypes.js";
import { array, invalid, list, noExtensions, object, reference, unsupported, vector, type JsonObject } from "./validation.js";

interface SourceAnimationNode {
  readonly index: number;
  readonly children: readonly number[];
  readonly name?: string;
  readonly localTransform: SceneLocalTransform;
}

export interface AnimationNodeSelection<TId extends SpatialItemId> {
  readonly sceneIndex: number;
  readonly nodes: readonly GltfAnimatedNode<TId>[];
  readonly selected: ReadonlySet<number>;
  readonly ids: ReadonlyMap<number, TId>;
  readonly matrixNodes: ReadonlySet<number>;
}

export function selectAnimationNodes<TId extends SpatialItemId>(
  document: JsonObject,
  options: GltfAnimationImportOptions<TId>,
  maximum: number,
  allowMorphWeights = false,
): AnimationNodeSelection<TId> {
  const values = list(document.nodes, "nodes", maximum), parents = new Int32Array(values.length).fill(-1);
  const source = values.map((value, index) => node(value, index, values, parents, allowMorphWeights));
  assertAcyclic(source, parents);
  const scenes = list(document.scenes, "scenes");
  if (scenes.length === 0) invalid("scenes", "At least one explicit scene is required.");
  const selectedScene = reference(scenes, options.sceneIndex ?? document.scene ?? 0, "scene");
  const rootsByScene = scenes.map((value, index) => {
    const path = `scenes[${index}]`, scene = object(value, path);
    noExtensions(scene, path);
    const roots = scene.nodes === undefined ? [] : array(scene.nodes, `${path}.nodes`, maximum).map((entry) => reference(source, entry, `${path}.nodes`));
    if (new Set(roots).size !== roots.length || roots.some((root) => parents[root] !== -1)) invalid(path, "Scene roots must be distinct parentless nodes.");
    return roots;
  });
  const selected = new Set<number>(), ids = new Map<number, TId>(), usedIds = new Set<TId>(), result: GltfAnimatedNode<TId>[] = [];
  const matrixNodes = new Set<number>();
  const pending = [...rootsByScene[selectedScene]!].reverse().map((index) => ({ index, parent: null as TId | null }));
  while (pending.length > 0) {
    const current = pending.pop()!, sourceNode = source[current.index]!;
    selected.add(current.index);
    const id = mappedId(options, sourceNode);
    if (usedIds.has(id)) invalid(`nodes[${current.index}]`, "Mapped animation node ids must be unique.");
    ids.set(current.index, id);
    usedIds.add(id);
    if (sourceNode.localTransform.kind === "matrix") matrixNodes.add(current.index);
    result.push(Object.freeze({ sourceNodeIndex: current.index, id, parent: current.parent,
      ...(sourceNode.name === undefined ? {} : { name: sourceNode.name }), localTransform: sourceNode.localTransform }));
    for (let child = sourceNode.children.length - 1; child >= 0; child -= 1) {
      pending.push({ index: sourceNode.children[child]!, parent: id });
    }
  }
  return Object.freeze({ sceneIndex: selectedScene, nodes: Object.freeze(result), selected, ids, matrixNodes });
}

function node(value: unknown, index: number, all: readonly unknown[], parents: Int32Array, allowMorphWeights: boolean): SourceAnimationNode {
  const path = `nodes[${index}]`, source = object(value, path);
  noExtensions(source, path);
  if (source.weights !== undefined && !allowMorphWeights) unsupported(`${path}.weights`, "morph weights");
  if (source.name !== undefined && typeof source.name !== "string") invalid(`${path}.name`, "Node name must be a string.");
  const children = list(source.children, `${path}.children`).map((entry) => reference(all, entry, `${path}.children`));
  for (const child of children) {
    if (parents[child] !== -1) invalid(`${path}.children`, "Node has duplicate edges or multiple parents.");
    parents[child] = index;
  }
  return Object.freeze({ index, children: Object.freeze(children),
    ...(source.name === undefined ? {} : { name: source.name as string }), localTransform: localTransform(source, path) });
}

function localTransform(node: JsonObject, path: string): SceneLocalTransform {
  if (node.matrix !== undefined) {
    if (node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined) invalid(path, "matrix and TRS cannot coexist.");
    const values = vector(node.matrix, 16, `${path}.matrix`);
    if (values[3] !== 0 || values[7] !== 0 || values[11] !== 0 || values[15] !== 1) invalid(`${path}.matrix`, "Node matrix must be affine.");
    return Object.freeze({ kind: "matrix", matrix: Object.freeze(values) as unknown as SceneMatrix4 });
  }
  const translation = frozenVector(node.translation ?? [0, 0, 0], 3, `${path}.translation`) as SpatialVec3;
  const scale = frozenVector(node.scale ?? [1, 1, 1], 3, `${path}.scale`) as SpatialVec3;
  const rawRotation = vector(node.rotation ?? [0, 0, 0, 1], 4, `${path}.rotation`);
  const length = Math.hypot(...rawRotation);
  if (length <= Number.EPSILON || Math.abs(length - 1) > 1e-5) invalid(`${path}.rotation`, "Quaternion must be normalized.");
  const rotation = Object.freeze(rawRotation.map((value) => value / length)) as unknown as SceneQuaternion;
  return Object.freeze({ kind: "trs", translation, rotation, scale });
}

function assertAcyclic(nodes: readonly SourceAnimationNode[], parents: Int32Array): void {
  const state = new Uint8Array(nodes.length);
  for (let start = 0; start < nodes.length; start += 1) {
    let current = start;
    while (current !== -1 && state[current] === 0) { state[current] = 1; current = parents[current]!; }
    if (current !== -1 && state[current] === 1) invalid("nodes", "Node hierarchy contains a cycle.");
    current = start;
    while (current !== -1 && state[current] === 1) { state[current] = 2; current = parents[current]!; }
  }
}

function mappedId<TId extends SpatialItemId>(options: GltfAnimationImportOptions<TId>, node: SourceAnimationNode): TId {
  let id: TId;
  try { id = options.mapNodeId ? options.mapNodeId(node.index, node.name) : node.index as TId; }
  catch { invalid(`nodes[${node.index}]`, "Node id mapper failed."); }
  try { validateSpatialId(id!); } catch { invalid(`nodes[${node.index}]`, "Node id mapper returned an invalid id."); }
  return id!;
}

function frozenVector(value: unknown, length: number, path: string): readonly number[] {
  return Object.freeze(vector(value, length, path));
}
