import type { PublishedSceneRecord } from "@bim-studio/contracts";

/** 旧库可能只有当前发布快照；读取时补入视图，不写库、不推测缺失的历史。 */
export function withCurrentScenePublication(
  history: readonly PublishedSceneRecord[],
  current: PublishedSceneRecord | undefined,
): PublishedSceneRecord[] {
  if (!current || history.some(item => item.sceneId === current.sceneId
    && item.projectId === current.projectId && item.publishedAt === current.publishedAt)) return [...history];
  return [...history, current];
}
