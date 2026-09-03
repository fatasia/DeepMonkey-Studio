import type { SceneSnapshot } from "@bim-studio/contracts";

export type SceneStatusFilter = "all" | "published" | "draft";
export type SceneSortKey = "updated" | "name" | "objects";

export interface SceneThumbnailItem {
  id: string;
  kind: "model" | SceneSnapshot["primitives"][number]["kind"];
  color: string;
  left: number;
  top: number;
}

export function sceneObjectCount(scene: SceneSnapshot): number {
  return scene.models.length
    + scene.primitives.length
    + scene.measurements.length
    + (scene.annotations?.length ?? 0);
}

/**
 * 用场景自身的可见对象、位置和显式颜色生成轻量缩略图数据。
 * 普通模型没有全局颜色覆盖时保持中性，避免把旧版 `color` 字段误当成原始材质。
 */
export function sceneThumbnailItems(scene: SceneSnapshot, limit = 8): SceneThumbnailItem[] {
  const sources = [
    ...scene.models.filter((model) => model.visible).map((model) => ({
      id: model.modelId,
      kind: "model" as const,
      color: model.colorOverride ?? "#708892",
      position: model.transform.position,
    })),
    ...scene.primitives.filter((primitive) => primitive.visible).map((primitive) => ({
      id: primitive.modelId,
      kind: primitive.kind,
      color: primitive.color,
      position: primitive.transform.position,
    })),
  ].slice(0, Math.max(0, limit));
  if (sources.length === 0) return [];

  const xValues = sources.map((item) => item.position.x);
  const zValues = sources.map((item) => item.position.z);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minZ = Math.min(...zValues);
  const maxZ = Math.max(...zValues);
  const xSpan = maxX - minX;
  const zSpan = maxZ - minZ;

  return sources.map((item, index) => ({
    id: item.id,
    kind: item.kind,
    color: item.color,
    left: xSpan > 0.001 ? 14 + ((item.position.x - minX) / xSpan) * 68 : 22 + (index % 4) * 18,
    top: zSpan > 0.001 ? 20 + ((maxZ - item.position.z) / zSpan) * 45 : 26 + Math.floor(index / 4) * 25,
  }));
}

export function filterAndSortScenes(
  scenes: SceneSnapshot[],
  query: string,
  status: SceneStatusFilter,
  sort: SceneSortKey,
): SceneSnapshot[] {
  const keyword = query.trim().toLocaleLowerCase();
  return scenes
    .filter((scene) => {
      if (status === "published" && !scene.publishedAt) return false;
      if (status === "draft" && scene.publishedAt) return false;
      return !keyword || scene.name.toLocaleLowerCase().includes(keyword);
    })
    .sort((left, right) => {
      if (sort === "name") return left.name.localeCompare(right.name, "zh-CN", { numeric: true });
      if (sort === "objects") return sceneObjectCount(right) - sceneObjectCount(left) || Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
    });
}
