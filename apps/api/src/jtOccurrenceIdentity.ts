import { JtFormatError, type JtMeshInstance, type JtSceneGraph, type JtSceneNode } from "@bim-studio/jt-reader";

const MAX_OCCURRENCES = 1_000_000;
const MAX_PATH_DEPTH = 10_000;

export interface JtOccurrence {
  id: string;
  prototypeId: string;
  pathObjectIds: number[];
  parentId: string | undefined;
  source: JtSceneNode;
  meshIds: string[];
  children: JtOccurrence[];
}

function validatePath(path: readonly number[]): void {
  if (path.length === 0 || path.length > MAX_PATH_DEPTH
    || path.some((id) => !Number.isSafeInteger(id) || id < 0)
    || new Set(path).size !== path.length) {
    throw new JtFormatError("JT 装配路径为空、含无效对象编号或循环引用");
  }
}

export function jtOccurrenceElementId(path: readonly number[]): string {
  validatePath(path);
  return `jt-occurrence:${path.join("/")}`;
}

/** 身份只由源网格与装配路径决定，不使用遍历顺序或全局实例计数。 */
export function jtInstanceElementId(instance: Pick<JtMeshInstance, "meshId" | "sceneNodeObjectId" | "pathObjectIds">): string {
  validatePath(instance.pathObjectIds);
  if (!instance.meshId || instance.meshId.length > 1024
    || instance.pathObjectIds.at(-1) !== instance.sceneNodeObjectId) {
    throw new JtFormatError("JT 实例缺少网格身份或装配路径末端不匹配");
  }
  return `jt-instance:${instance.meshId}:path-${instance.pathObjectIds.join("/")}`;
}

/** 原型可被多条路径复用；无法区分的重复同路径引用拒绝进入可选择产物。 */
export function buildJtOccurrences(
  graph: Pick<JtSceneGraph, "nodes" | "rootObjectIds">,
  instances: readonly JtMeshInstance[],
): { roots: JtOccurrence[]; all: JtOccurrence[] } {
  const nodes = new Map(graph.nodes.map((node) => [node.objectId, node]));
  if (nodes.size !== graph.nodes.length) throw new JtFormatError("JT 源节点编号重复");
  const roots: JtOccurrence[] = [];
  const all: JtOccurrence[] = [];
  const byPath = new Map<string, JtOccurrence>();
  const stack = graph.rootObjectIds.toReversed().map((objectId) => ({ objectId, parent: undefined as JtOccurrence | undefined }));
  while (stack.length) {
    const { objectId, parent } = stack.pop()!;
    const source = nodes.get(objectId);
    if (!source) throw new JtFormatError(`JT 装配路径引用缺失节点 ${objectId}`);
    const pathObjectIds = [...(parent?.pathObjectIds ?? []), objectId];
    const id = jtOccurrenceElementId(pathObjectIds);
    if (byPath.has(id)) throw new JtFormatError(`JT 装配含无法区分的重复路径 ${pathObjectIds.join("/")}`);
    if (all.length >= MAX_OCCURRENCES) throw new JtFormatError("JT 装配出现数量超过安全上限");
    const occurrence: JtOccurrence = {
      id, prototypeId: `jt-node:${objectId}`, pathObjectIds, parentId: parent?.id,
      source, meshIds: [], children: [],
    };
    (parent?.children ?? roots).push(occurrence);
    byPath.set(id, occurrence);
    all.push(occurrence);
    for (const child of source.childObjectIds.toReversed()) stack.push({ objectId: child, parent: occurrence });
  }
  const meshIds = new Set<string>();
  for (const instance of instances) {
    const id = jtInstanceElementId(instance);
    const occurrence = byPath.get(jtOccurrenceElementId(instance.pathObjectIds));
    if (!occurrence) throw new JtFormatError("JT 网格实例引用不存在的装配路径");
    if (meshIds.has(id)) throw new JtFormatError("JT 网格实例在同一装配路径重复");
    meshIds.add(id);
    occurrence.meshIds.push(id);
  }
  return { roots, all };
}
