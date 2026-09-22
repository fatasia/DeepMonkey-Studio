import type { SceneRootLayerRef } from "@bim-studio/contracts";
import { normalizeSceneRootLayerOrder } from "./sceneRootLayerOrder";

export interface LayerSelectionIntent { additive?: boolean; range?: boolean; orderedIds?: readonly string[]; anchorId?: string }

/** 从目录数据而不是已挂载 DOM 构造顺序，虚拟滚动不会丢失范围中间行。 */
export function visibleLayerIds(orderedIds: readonly string[], groups: readonly { id: string; objectIds: readonly string[] }[],
  collapsed: ReadonlySet<string>, rootOrder?: readonly SceneRootLayerRef[]): string[] {
  const available = new Set(orderedIds), grouped = new Set(groups.flatMap(group => [...group.objectIds]));
  const roots: SceneRootLayerRef[] = [...groups.map(group => ({ kind: "group" as const, id: group.id })),
    ...orderedIds.filter(id => !grouped.has(id)).map(id => ({ kind: "object" as const, id }))];
  const groupsById = new Map(groups.map(group => [group.id, group]));
  return [...new Set(normalizeSceneRootLayerOrder(rootOrder, roots).flatMap(ref => ref.kind === "object" ? [ref.id]
    : collapsed.has(ref.id) ? [] : groupsById.get(ref.id)?.objectIds.filter(id => available.has(id)) ?? []))];
}

/** 可见顺序仅定义区间；实体有效性由适配器校验，折叠不能清除追加选择。 */
export function selectLayerIds(orderedIds: readonly string[], selectedIds: readonly string[], id: string,
  intent: LayerSelectionIntent = {}, anchorId = selectedIds.at(-1)): string[] {
  if (!orderedIds.includes(id)) return [...selectedIds];
  const current = [...new Set(selectedIds)];
  if (intent.range) {
    const anchor = orderedIds.indexOf(anchorId ?? id);
    const target = orderedIds.indexOf(id);
    const range = anchor < 0 ? [id] : orderedIds.slice(Math.min(anchor, target), Math.max(anchor, target) + 1);
    const next = intent.additive ? [...new Set([...current, ...range])] : [...range];
    return [...next.filter(value => value !== id), id];
  }
  if (intent.additive) return current.includes(id) ? current.filter(value => value !== id) : [...current, id];
  return [id];
}
