export type LayerDropPosition = "before" | "inside" | "after";
export interface LayerDropIntent { position: LayerDropPosition; targetKind?: "item" | "group"; sourceKind?: "item" | "group" }

/** 组头中央用于入组，边缘用于排序；普通元素只能放在前后。 */
export function resolveLayerDropPosition(kind: "item" | "group", clientY: number, rect: { top: number; height: number }): LayerDropPosition {
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  if (kind === "group") return ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
  return ratio < 0.5 ? "before" : "after";
}
