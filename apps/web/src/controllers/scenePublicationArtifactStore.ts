import { readRecoveryRecords, writeRecoveryRecord } from "../studio/recoveryDatabase";
import { assertSceneArtifactRecord, recoverSceneArtifactRecord, type SceneArtifactRecord } from "./scenePublicationArtifactRecord";

function namespace(ownerId: string, projectId: string, sceneId: string): string {
  if (![ownerId, projectId, sceneId].every((value) => typeof value === "string" && value.trim())) throw new Error("打包任务缺少用户或场景身份。");
  return `scene-artifact-record:${JSON.stringify([ownerId, projectId, sceneId])}:`;
}

/** 每项使用独立IDB键，重试目标不会覆盖同场景的其他版本或用户记录。 */
export async function saveSceneArtifactRecord(ownerId: string, record: SceneArtifactRecord): Promise<void> {
  assertSceneArtifactRecord(record);
  const prefix = namespace(ownerId, record.projectId, record.sceneId);
  const stored = { key: prefix + record.key, record: structuredClone(record) };
  await writeRecoveryRecord(stored);
}

/** 只在恢复会话时调用；历史building转为中断，不自动触发下载。存储故障交调用方显示。 */
export async function restoreSceneArtifactRecords(ownerId: string, projectId: string, sceneId: string): Promise<SceneArtifactRecord[]> {
  const prefix = namespace(ownerId, projectId, sceneId);
  const values = await readRecoveryRecords(prefix);
  const records = values.map((value) => {
    if (!value || typeof value !== "object") throw new Error("本地打包任务损坏。");
    const stored = value as { key?: unknown; record?: SceneArtifactRecord };
    if (!stored.record || stored.record.projectId !== projectId || stored.record.sceneId !== sceneId
      || stored.key !== prefix + stored.record.key) throw new Error("本地打包任务身份不匹配。");
    return { record: recoverSceneArtifactRecord(stored.record), interrupted: stored.record.status === "preparing" || stored.record.status === "building" };
  });
  for (const entry of records) if (entry.interrupted) await saveSceneArtifactRecord(ownerId, entry.record);
  return records.map((entry) => entry.record).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
