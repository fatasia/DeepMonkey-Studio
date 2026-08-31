import { ServerRequestError } from "@bim-studio/server-sdk";
import { translate as tr, type AppLocale } from "../i18n";

export interface WorkspaceSaveFailureGuidance {
  message: string;
  pauseAutoSave: boolean;
}

/**
 * 版本冲突时不自动覆盖服务器，也不反复自动保存；当前页面中的编辑状态保持不变。
 * 其他错误继续交给通用错误处理，避免把短暂网络抖动误判为版本冲突。
 */
export function workspaceSaveFailureGuidance(reason: unknown, locale: AppLocale): WorkspaceSaveFailureGuidance | undefined {
  if (!(reason instanceof ServerRequestError) || reason.status !== 409) return undefined;
  const currentRevision = readCurrentRevision(reason.body);
  const version = currentRevision === undefined ? "" : tr(locale, `（服务器版本 v${currentRevision}）`, ` (server revision v${currentRevision})`);
  return {
    pauseAutoSave: true,
    message: tr(
      locale,
      `检测到其他页面或进程已保存新版本${version}。本页修改仍保留，系统已暂停自动保存且不会覆盖服务器。请先导出当前场景副本，再重新加载最新版本。`,
      `A newer version was saved elsewhere${version}. Your edits remain in this tab; autosave is paused and the server was not overwritten. Export this scene before loading the latest version.`
    )
  };
}

function readCurrentRevision(body: unknown): number | undefined {
  if (!body || typeof body !== "object" || !("currentRevision" in body)) return undefined;
  const value = (body as { currentRevision?: unknown }).currentRevision;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
