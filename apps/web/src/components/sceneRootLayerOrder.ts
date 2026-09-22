import type { SceneRootLayerRef } from "@bim-studio/contracts";

export const sceneRootLayerKey = (ref: SceneRootLayerRef): string => `${ref.kind}:${ref.id}`;

/** 以当前存在的根行为准：保留显式次序，忽略旧引用，新行按原次序追加。 */
export function normalizeSceneRootLayerOrder(
  order: readonly SceneRootLayerRef[] | undefined,
  available: readonly SceneRootLayerRef[],
): SceneRootLayerRef[] {
  const byKey = new Map(available.map(ref => [sceneRootLayerKey(ref), ref]));
  const result: SceneRootLayerRef[] = [];
  for (const ref of [...(order ?? []), ...available]) {
    const key = sceneRootLayerKey(ref), current = byKey.get(key);
    if (!current) continue;
    result.push({ ...current });
    byKey.delete(key);
  }
  return result;
}

/** 只返回新的行数组；行载荷与空间变换保持原对象引用。 */
export function sortSceneRootLayers<T>(
  rows: readonly T[], order: readonly SceneRootLayerRef[] | undefined, reference: (row: T) => SceneRootLayerRef,
): T[] {
  const byKey = new Map(rows.map(row => [sceneRootLayerKey(reference(row)), row]));
  return normalizeSceneRootLayerOrder(order, rows.map(reference)).map(ref => byKey.get(sceneRootLayerKey(ref))!);
}

/** moving 必须已由调用者按锁定/权限过滤；移动块保持当前目录相对顺序。 */
export function moveSceneRootLayers(
  order: readonly SceneRootLayerRef[] | undefined,
  available: readonly SceneRootLayerRef[],
  moving: readonly SceneRootLayerRef[],
  before?: SceneRootLayerRef,
): SceneRootLayerRef[] {
  const current = normalizeSceneRootLayerOrder(order, available);
  const movingKeys = new Set(moving.map(sceneRootLayerKey));
  const beforeKey = before && sceneRootLayerKey(before);
  if (beforeKey && (movingKeys.has(beforeKey) || !current.some(ref => sceneRootLayerKey(ref) === beforeKey))) return current;
  const moved = current.filter(ref => movingKeys.has(sceneRootLayerKey(ref)));
  if (!moved.length) return current;
  const remaining = current.filter(ref => !movingKeys.has(sceneRootLayerKey(ref)));
  const index = beforeKey ? remaining.findIndex(ref => sceneRootLayerKey(ref) === beforeKey) : remaining.length;
  return [...remaining.slice(0, index), ...moved, ...remaining.slice(index)];
}
