import type { PublishedSceneRecord } from "@bim-studio/contracts";
import { createEvidenceFingerprint } from "@bim-studio/studio-core";
import type { SceneClientPackageTarget } from "../delivery/sceneClientPackage";
import type { ClientPackageBranding } from "../components/clientPackageBranding";
import { freezeSceneClientBranding } from "../delivery/sceneClientBranding";

export type SceneArtifactStatus = "preparing" | "building" | "ready" | "failed" | "cancelled";

export interface SceneArtifactOptions {
  target: Exclude<SceneClientPackageTarget, "none">;
  renderer: "webgl" | "webgpu-preferred";
  toolbarVisible: boolean;
  branding?: ClientPackageBranding;
  format?: "executable";
}

/** 仅定位已发布场景快照，不表示项目资源与应用依赖已冻结。 */
export interface SceneArtifactRecord extends SceneArtifactOptions {
  schemaVersion: 1;
  key: string;
  projectId: string;
  sceneId: string;
  publicationVersion: number;
  publishedAt: string;
  snapshotFingerprint: string;
  status: SceneArtifactStatus;
  attemptId: number;
  updatedAt: string;
  error?: string;
  errorCode?: string;
}

export function createSceneArtifactRecord(publication: PublishedSceneRecord, options: SceneArtifactOptions): SceneArtifactRecord {
  assertPublication(publication);
  assertOptions(options);
  const branding = freezeSceneClientBranding(options.branding);
  const record: SceneArtifactRecord = {
    schemaVersion: 1, key: "", projectId: publication.projectId, sceneId: publication.sceneId,
    publicationVersion: publication.version!, publishedAt: publication.publishedAt,
    snapshotFingerprint: createEvidenceFingerprint(publication.snapshot),
    target: options.target, renderer: options.renderer, toolbarVisible: options.toolbarVisible,
    ...(branding ? { branding } : {}),
    ...(options.format ? { format: options.format } : {}),
    status: "preparing", attemptId: 0, updatedAt: new Date().toISOString(),
  };
  record.key = artifactKey(record);
  return record;
}

/** 历史缺失或内容变化必须拒绝，不能替换成当前发布或草稿。 */
export function resolveSceneArtifactPublication(record: SceneArtifactRecord, publications: readonly PublishedSceneRecord[]): PublishedSceneRecord {
  assertSceneArtifactRecord(record);
  const matches = publications.filter((publication) => publication.projectId === record.projectId
    && publication.sceneId === record.sceneId && publication.version === record.publicationVersion
    && publication.publishedAt === record.publishedAt);
  if (matches.length !== 1) throw new Error("无法唯一定位原发布版本，版本可能已清理或历史记录存在冲突。");
  const publication = matches[0]!;
  assertPublication(publication);
  if (createEvidenceFingerprint(publication.snapshot) !== record.snapshotFingerprint) {
    throw new Error("原发布快照与打包记录不一致，请重新核对发布历史。");
  }
  return structuredClone(publication);
}

/** 刷新后不会自动重启下载；只将中断任务恢复为可重试失败状态。 */
export function recoverSceneArtifactRecord(record: SceneArtifactRecord): SceneArtifactRecord {
  assertSceneArtifactRecord(record);
  if (record.status !== "preparing" && record.status !== "building") return structuredClone(record);
  return { ...record, status: "failed", errorCode: "interrupted", error: "上次打包已中断，请重试。", updatedAt: new Date().toISOString() };
}

function artifactKey(record: Pick<SceneArtifactRecord, "projectId" | "sceneId" | "publicationVersion" | "publishedAt" | "target" | "renderer" | "toolbarVisible" | "branding" | "format">): string {
  return `scene-artifact:${JSON.stringify([record.projectId, record.sceneId, record.publicationVersion, record.publishedAt, record.target, record.renderer, record.toolbarVisible,
    ...(record.branding ? [createEvidenceFingerprint(record.branding)] : []), ...(record.format ? [record.format] : [])])}`;
}

function assertPublication(publication: PublishedSceneRecord): void {
  if (!positiveInteger(publication.version) || !nonblank(publication.projectId) || !nonblank(publication.sceneId)
    || !Number.isFinite(Date.parse(publication.publishedAt))) throw new Error("发布版本必须包含有效项目、场景、版本号和发布时间。");
  if (publication.snapshot.schemaVersion !== 1 || publication.snapshot.id !== publication.sceneId || publication.snapshot.projectId !== publication.projectId) {
    throw new Error("发布快照身份与发布版本不一致。");
  }
}

export function assertSceneArtifactRecord(record: SceneArtifactRecord): void {
  assertOptions(record);
  if (record.schemaVersion !== 1 || !nonblank(record.projectId) || !nonblank(record.sceneId)
    || !positiveInteger(record.publicationVersion) || !Number.isFinite(Date.parse(record.publishedAt))
    || !nonblank(record.snapshotFingerprint) || !Number.isFinite(Date.parse(record.updatedAt)) || record.key !== artifactKey(record)
    || !["preparing", "building", "ready", "failed", "cancelled"].includes(record.status)
    || !Number.isSafeInteger(record.attemptId) || record.attemptId < 0) throw new Error("客户端打包任务记录无效。");
}

function assertOptions(options: SceneArtifactOptions): void {
  if (options.format !== undefined && options.format !== "executable") throw new Error("客户端交付格式无效");
  freezeSceneClientBranding(options.branding);
  if (!["three-webview", "deep-native"].includes(options.target) || !["webgl", "webgpu-preferred"].includes(options.renderer)
    || typeof options.toolbarVisible !== "boolean") throw new Error("客户端打包目标或渲染配置无效。");
}
function positiveInteger(value: number | undefined): boolean { return Number.isSafeInteger(value) && value! > 0; }
function nonblank(value: string): boolean { return typeof value === "string" && value.trim().length > 0; }
