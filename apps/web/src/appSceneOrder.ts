import type { SceneSnapshot } from "@bim-studio/contracts";

export function sortScenesByTime(items: SceneSnapshot[]): SceneSnapshot[] {
  return [...items].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}
