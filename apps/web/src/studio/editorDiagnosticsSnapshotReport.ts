import { readStudioFrameReadbacks } from "../viewer/studioFrameCaptureDiagnostics";
import { isPbrFrameReadbackSnapshot } from "@bim-studio/deep-engine";

export interface EditorDiagnosticsSnapshotReport {
  readonly sceneId: string;
  readonly revision: number;
  readonly capturedAtMs: number;
  readonly resources: readonly {
    readonly resourceId: string;
    readonly frameId: string;
    readonly width: number;
    readonly height: number;
    readonly format: string;
    readonly byteLength: number;
  }[];
}

const REPORT_LIMITS = { resources: 4, format: 32 } as const;

/**
 * 从浏览器 R12 readback 存储构建最近一次快照的有界摘要（仅元数据，字节不出浏览器）。
 * 无快照或条目越界时返回 undefined——半份目录不如没有目录（服务端全有或全无校验）。
 */
export function buildEditorDiagnosticsSnapshotReport(sceneId: string, revision: number,
): EditorDiagnosticsSnapshotReport | undefined {
  const entries = readStudioFrameReadbacks();
  const latest = entries.at(-1);
  if (!latest) return undefined;
  const resources: {
    resourceId: string; frameId: string; width: number; height: number;
    format: string; byteLength: number;
  }[] = [];
  const seen = new Set<string>();
  for (const result of latest.results) {
    if (resources.length >= REPORT_LIMITS.resources) break;
    const snapshot = isPbrFrameReadbackSnapshot(result) ? result : undefined;
    const resourceId = result.resourceId;
    if (!resourceId || resourceId.length > 64 || seen.has(resourceId)) return undefined;
    seen.add(resourceId);
    resources.push({
      resourceId, frameId: result.frameId.slice(0, 160),
      width: snapshot?.width ?? 0, height: snapshot?.height ?? 0,
      format: (snapshot?.format ?? "unavailable").slice(0, REPORT_LIMITS.format),
      byteLength: snapshot?.bytes.byteLength ?? 0,
    });
  }
  if (resources.length === 0) return undefined;
  return { sceneId, revision, capturedAtMs: Math.max(0, Math.floor(latest.receivedAtMs)), resources };
}
