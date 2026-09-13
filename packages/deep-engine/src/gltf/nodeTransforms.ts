import { packTransform } from "../instanceTransform.js";
import { array, invalid, list, noExtensions, object, reference, unsupported, vector, type JsonObject } from "./validation.js";

export const identity = (): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const QUATERNION_LENGTH_TOLERANCE = 1e-3;
function multiply(left: readonly number[], right: readonly number[]): number[] {
  const output = Array<number>(16).fill(0);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 4; k++) output[column * 4 + row]! += left[k * 4 + row]! * right[column * 4 + k]!;
  }
  return output;
}
function localTransform(node: JsonObject, path: string): number[] {
  if (node.matrix !== undefined) {
    if ([node.translation, node.rotation, node.scale].some(value => value !== undefined)) invalid(path, "matrix and TRS cannot coexist.");
    const matrix = vector(node.matrix, 16, `${path}.matrix`);
    if (matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) invalid(`${path}.matrix`, "Node matrix must be affine.");
    for (const [left, right] of [[0, 4], [0, 8], [4, 8]] as const) {
      const a = matrix.slice(left, left + 3), b = matrix.slice(right, right + 3);
      const dot = a.reduce((sum, value, axis) => sum + value * b[axis]!, 0);
      if (Math.abs(dot) > Math.hypot(...a) * Math.hypot(...b) * 1e-5) invalid(`${path}.matrix`, "Local node matrix must decompose to TRS without shear.");
    }
    return matrix;
  }
  const t = vector(node.translation === undefined ? [0, 0, 0] : node.translation, 3, `${path}.translation`);
  const s = vector(node.scale === undefined ? [1, 1, 1] : node.scale, 3, `${path}.scale`);
  const q = vector(node.rotation === undefined ? [0, 0, 0, 1] : node.rotation, 4, `${path}.rotation`);
  const length = Math.hypot(...q);
  // Real glTF exporters commonly round quaternion components to three decimals.
  // Normalize that bounded representation error, while rejecting corrupt values.
  if (length < 1e-8 || Math.abs(length - 1) > QUATERNION_LENGTH_TOLERANCE) {
    invalid(`${path}.rotation`, "Quaternion must be normalized within exporter precision.");
  }
  const [x, y, z, w] = q.map(value => value / length) as [number, number, number, number];
  return [
    (1 - 2 * (y * y + z * z)) * s[0]!, 2 * (x * y + z * w) * s[0]!, 2 * (x * z - y * w) * s[0]!, 0,
    2 * (x * y - z * w) * s[1]!, (1 - 2 * (x * x + z * z)) * s[1]!, 2 * (y * z + x * w) * s[1]!, 0,
    2 * (x * z + y * w) * s[2]!, 2 * (y * z - x * w) * s[2]!, (1 - 2 * (x * x + y * y)) * s[2]!, 0,
    t[0]!, t[1]!, t[2]!, 1,
  ];
}
export interface MeshNode { readonly index: number; readonly mesh: number; readonly transform: readonly number[] }

/** 验证整个节点森林，迭代遍历避免深层模型耗尽 JS 调用栈。只投影选中场景。 */
export function sceneMeshNodes(document: JsonObject, meshes: readonly unknown[], sceneIndex?: number): MeshNode[] {
  const source = list(document.nodes, "nodes"), parents = new Int32Array(source.length).fill(-1);
  const nodes = source.map((value, index) => {
    const path = `nodes[${index}]`, node = object(value, path);
    noExtensions(node, path);
    for (const field of ["skin", "weights", "camera"]) if (node[field] !== undefined) unsupported(`${path}.${field}`, field);
    const children = list(node.children, `${path}.children`).map(value => reference(source, value, `${path}.children`));
    for (const child of children) {
      if (parents[child] !== -1) invalid(`${path}.children`, "Node has duplicate edges or multiple parents.");
      parents[child] = index;
    }
    const mesh = node.mesh === undefined ? undefined : reference(meshes, node.mesh, `${path}.mesh`);
    const local = localTransform(node, path);
    try { packTransform(local, new Float32Array(24)); } catch (error) { invalid(path, (error as Error).message); }
    return { children, mesh, local };
  });
  const visited = new Uint8Array(nodes.length);
  for (let start = 0; start < nodes.length; start++) {
    let current = start;
    while (current !== -1 && visited[current] === 0) { visited[current] = 1; current = parents[current]!; }
    if (current !== -1 && visited[current] === 1) invalid("nodes", "Node hierarchy contains a cycle.");
    current = start;
    while (current !== -1 && visited[current] === 1) { visited[current] = 2; current = parents[current]!; }
  }
  const scenes = list(document.scenes, "scenes");
  if (!scenes.length) invalid("scenes", "At least one explicit scene is required.");
  const selected = reference(scenes, sceneIndex === undefined ? (document.scene === undefined ? 0 : document.scene) : sceneIndex, "scene");
  const sceneRoots = scenes.map((value, index) => {
    const path = `scenes[${index}]`, scene = object(value, path);
    noExtensions(scene, path);
    const roots = scene.nodes === undefined ? [] : array(scene.nodes, `${path}.nodes`).map(value => reference(nodes, value, `${path}.nodes`));
    if (new Set(roots).size !== roots.length || roots.some(root => parents[root] !== -1)) invalid(path, "Scene roots must be distinct nodes without parents.");
    return roots;
  });
  const pending = [...sceneRoots[selected]!].reverse().map(index => ({ index, parent: identity() })), result: MeshNode[] = [];
  while (pending.length) {
    const { index, parent } = pending.pop()!, node = nodes[index]!, transform = multiply(parent, node.local);
    try { packTransform(transform, new Float32Array(24)); } catch (error) { invalid(`nodes[${index}]`, (error as Error).message); }
    if (node.mesh !== undefined) result.push({ index, mesh: node.mesh, transform });
    for (let child = node.children.length - 1; child >= 0; child--) pending.push({ index: node.children[child]!, parent: transform });
  }
  return result;
}
