import type { EditorPresence } from "./editorPresence.js";

/**
 * 浏览器活跃编辑器渲染诊断快照的摘要镜像（R12 readback 白名单资源）。字节本身留在
 * 浏览器（readback 存储），presence 通道只回传有界元数据；MCP 观察资源据此列出
 * 「现在能取到什么快照」。全有或全无：任一资源摘要不合法即整体丢弃，绝不提供半个快照目录。
 */
export interface EditorDiagnosticsSnapshotMirror {
  readonly sceneId: string;
  /** 摘要对应的草稿 revision；必须与 presence.draftRevision 一致才可信。 */
  readonly revision: number;
  readonly capturedAtMs: number;
  readonly resources: readonly EditorDiagnosticsSnapshotResource[];
}

export interface EditorDiagnosticsSnapshotResource {
  readonly resourceId: string;
  readonly frameId: string;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly byteLength: number;
}

export const DIAGNOSTICS_SNAPSHOT_LIMITS = {
  resources: 4,
  resourceId: 64,
  frameId: 160,
  format: 32,
  maxDimension: 32_768,
  maxByteLength: 256 * 1024 * 1024,
} as const;

/** 校验浏览器上报的快照摘要镜像；undefined 表示不可信，presence 摘要本身不受影响。 */
export function parseEditorDiagnosticsSnapshotMirror(value: unknown): EditorDiagnosticsSnapshotMirror | undefined {
  if (!isRecord(value)) return undefined;
  const sceneId = value.sceneId, revision = value.revision, capturedAtMs = value.capturedAtMs;
  if (!identifier(sceneId) || !safeRevision(revision) || !safeTimestamp(capturedAtMs)) return undefined;
  const resources = parseResources(value.resources);
  if (!resources) return undefined;
  return { sceneId, revision, capturedAtMs, resources };
}

/** 活跃编辑器 presence 上可用且 revision 一致的快照摘要；任何漂移都返回 undefined。 */
export function activeDiagnosticsSnapshot(entry: EditorPresence): EditorDiagnosticsSnapshotMirror | undefined {
  const mirror = entry.diagnosticsSnapshot;
  if (!mirror || !entry.dirty) return undefined;
  if (mirror.revision !== entry.draftRevision || mirror.sceneId !== entry.targetId) return undefined;
  return mirror;
}

function parseResources(value: unknown): readonly EditorDiagnosticsSnapshotResource[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > DIAGNOSTICS_SNAPSHOT_LIMITS.resources) return undefined;
  const resources: EditorDiagnosticsSnapshotResource[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!isRecord(candidate)) return undefined;
    const resourceId = candidate.resourceId, frameId = candidate.frameId;
    const width = candidate.width, height = candidate.height;
    const format = candidate.format, byteLength = candidate.byteLength;
    if (typeof resourceId !== "string" || resourceId.length === 0 || resourceId.length > DIAGNOSTICS_SNAPSHOT_LIMITS.resourceId
      || typeof frameId !== "string" || frameId.length === 0 || frameId.length > DIAGNOSTICS_SNAPSHOT_LIMITS.frameId
      || !safeDimension(width) || !safeDimension(height)
      || typeof format !== "string" || format.length === 0 || format.length > DIAGNOSTICS_SNAPSHOT_LIMITS.format
      || typeof byteLength !== "number" || !Number.isSafeInteger(byteLength)
      || byteLength < 0 || byteLength > DIAGNOSTICS_SNAPSHOT_LIMITS.maxByteLength) return undefined;
    if (seen.has(resourceId)) return undefined;
    seen.add(resourceId);
    resources.push({ resourceId, frameId, width, height, format, byteLength });
  }
  return resources;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 160;
}
function safeDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= DIAGNOSTICS_SNAPSHOT_LIMITS.maxDimension;
}
function safeRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
