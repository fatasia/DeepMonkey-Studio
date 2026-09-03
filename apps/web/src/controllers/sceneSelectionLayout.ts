import type { ModelTransform } from "@bim-studio/contracts";

export type SceneSelectionLayoutAxis = "x" | "y" | "z";
export type SceneSelectionLayoutMode = "align" | "distribute";

export interface SceneSelectionLayoutItem {
  id: string;
  transform: ModelTransform;
}

/**
 * Computes project-space layout transforms without mutating the source values.
 * Alignment uses the primary object as the anchor; distribution preserves both
 * extremes and spaces every selected object evenly between them.
 */
export function layoutSceneSelection(
  items: SceneSelectionLayoutItem[],
  mode: SceneSelectionLayoutMode,
  axis: SceneSelectionLayoutAxis,
  primaryId?: string,
): SceneSelectionLayoutItem[] {
  if (items.length < 2) return items.map(cloneItem);
  if (mode === "align") {
    const anchor = items.find((item) => item.id === primaryId) ?? items[0]!;
    const coordinate = anchor.transform.position[axis];
    return items.map((item) => withCoordinate(item, axis, coordinate));
  }
  if (items.length < 3) return items.map(cloneItem);
  const ordered = items.map(cloneItem).sort((left, right) =>
    left.transform.position[axis] - right.transform.position[axis]
      || left.id.localeCompare(right.id));
  const start = ordered[0]!.transform.position[axis];
  const end = ordered.at(-1)!.transform.position[axis];
  const interval = (end - start) / (ordered.length - 1);
  return ordered.map((item, index) => withCoordinate(item, axis, start + interval * index));
}

function cloneItem(item: SceneSelectionLayoutItem): SceneSelectionLayoutItem {
  return {
    id: item.id,
    transform: {
      position: { ...item.transform.position },
      rotation: { ...item.transform.rotation },
      scale: { ...item.transform.scale },
    },
  };
}

function withCoordinate(
  item: SceneSelectionLayoutItem,
  axis: SceneSelectionLayoutAxis,
  coordinate: number,
): SceneSelectionLayoutItem {
  const clone = cloneItem(item);
  clone.transform.position[axis] = coordinate;
  return clone;
}
