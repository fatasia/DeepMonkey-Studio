import type { PublishedSceneRecord } from "@bim-studio/contracts";
import { isDeepStrictEqual } from "node:util";

/** 旧库可能只有当前发布快照；读取时补入视图，不写库、不推测缺失的历史。 */
export function withCurrentScenePublication(
  history: readonly PublishedSceneRecord[],
  current: PublishedSceneRecord | undefined,
): PublishedSceneRecord[] {
  if (!current || history.some(item => samePublication(item, current))) return [...history];
  return [...history, current];
}

function samePublication(left: PublishedSceneRecord, right: PublishedSceneRecord): boolean {
  if (left.sceneId !== right.sceneId || left.projectId !== right.projectId || left.publishedAt !== right.publishedAt
    || (left.version !== undefined && right.version !== undefined && left.version !== right.version)) return false;
  // 旧记录可能缺少 version；只允许完整 JSON 内容相同的记录兼容该缺失值。
  const a = JSON.parse(JSON.stringify(left)) as PublishedSceneRecord;
  const b = JSON.parse(JSON.stringify(right)) as PublishedSceneRecord;
  if (a.version === undefined || b.version === undefined) { delete a.version; delete b.version; }
  return isDeepStrictEqual(a, b);
}
