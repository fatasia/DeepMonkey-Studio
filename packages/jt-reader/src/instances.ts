import { JtFormatError } from "./binaryReader.js";
import type { JtMesh, JtMeshInstance, JtSceneGraph } from "./types.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
const MAX_INSTANCES = 1_000_000;
const MAX_PATH_DEPTH = 10_000;

/** 两个列主序 4x4 矩阵相乘，结果可直接写入 glTF node.matrix。 */
export function multiplyJtMatrices(left: readonly number[], right: readonly number[]): number[] {
  if (left.length !== 16 || right.length !== 16) throw new JtFormatError("JT 变换矩阵必须包含 16 个值");
  const result = Array.from({ length: 16 }, () => 0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let value = 0;
      for (let index = 0; index < 4; index += 1) {
        value += left[index * 4 + row]! * right[column * 4 + index]!;
      }
      result[column * 4 + row] = value;
    }
  }
  if (!result.every(Number.isFinite)) throw new JtFormatError("JT 组合变换包含非有限数值");
  return result;
}

export function buildJtMeshInstances(sceneGraph: JtSceneGraph, meshes: readonly JtMesh[]): JtMeshInstance[] {
  const nodes = new Map(sceneGraph.nodes.map((node) => [node.objectId, node]));
  const meshesBySegment = new Map<string, JtMesh[]>();
  for (const mesh of meshes) {
    const list = meshesBySegment.get(mesh.segmentId) ?? [];
    list.push(mesh);
    meshesBySegment.set(mesh.segmentId, list);
  }
  const instances: JtMeshInstance[] = [];

  const visit = (objectId: number, parentTransform: readonly number[], path: readonly number[]): void => {
    const node = nodes.get(objectId);
    if (!node) throw new JtFormatError(`JT 场景图引用了不存在的节点 ${objectId}`);
    if (path.includes(objectId)) throw new JtFormatError(`JT 场景图在节点 ${objectId} 形成循环`);
    if (path.length >= MAX_PATH_DEPTH) throw new JtFormatError("JT 场景图路径深度超过安全上限");
    const currentPath = [...path, objectId];
    const worldTransform = node.transform
      ? multiplyJtMatrices(parentTransform, node.transform)
      : [...parentTransform];

    for (const reference of node.lateLoadedSegments ?? []) {
      for (const mesh of meshesBySegment.get(reference.id) ?? []) {
        if (instances.length >= MAX_INSTANCES) throw new JtFormatError("JT 网格实例数量超过安全上限");
        instances.push({
          id: `${mesh.id}:instance-${instances.length}`,
          meshId: mesh.id,
          sceneNodeObjectId: objectId,
          pathObjectIds: currentPath,
          worldTransform: [...worldTransform],
        });
      }
    }
    for (const childId of node.childObjectIds) visit(childId, worldTransform, currentPath);
  };

  for (const rootObjectId of sceneGraph.rootObjectIds) visit(rootObjectId, IDENTITY, []);
  return instances;
}
