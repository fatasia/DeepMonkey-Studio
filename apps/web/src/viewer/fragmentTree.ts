import * as FRAGS from "@thatopen/fragments";
import type { LayerTreeNode } from "./viewerTypes";

export function collectSpatialLocalIds(item: FRAGS.SpatialTreeItem, output = new Set<number>()): Set<number> {
  if (item.localId !== null) output.add(item.localId);
  for (const child of item.children ?? []) collectSpatialLocalIds(child, output);
  return output;
}

export function setTreeVisibility(node: LayerTreeNode, visible: boolean): void {
  node.visible = visible;
  for (const child of node.children) setTreeVisibility(child, visible);
}

export function setTreeLock(node: LayerTreeNode, locked: boolean): void {
  node.locked = locked;
  for (const child of node.children) setTreeLock(child, locked);
}

export function humanizeIfcCategory(category: string | null): string {
  if (!category) return "";
  return category.replace(/^IFC/i, "").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").trim();
}

export function fragmentItemProperties(data: FRAGS.ItemData | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (!data) return output;
  for (const [key, raw] of Object.entries(data)) {
    if (Array.isArray(raw)) {
      if (raw.length > 0) output[key] = `${raw.length} 项`;
      continue;
    }
    const value = raw?.value;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") output[key] = String(value);
    else {
      try { output[key] = JSON.stringify(value); } catch { output[key] = String(value); }
    }
  }
  return output;
}

export function fragmentPropertyValue(properties: Record<string, string>, candidates: string[]): string | undefined {
  const entries = Object.entries(properties);
  for (const candidate of candidates) {
    const match = entries.find(([key]) => key.toLocaleLowerCase("zh-CN") === candidate.toLocaleLowerCase("zh-CN"));
    if (match?.[1]) return match[1];
  }
  return undefined;
}
