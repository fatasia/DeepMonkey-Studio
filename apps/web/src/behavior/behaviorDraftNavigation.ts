import type { ScriptModule } from "@bim-studio/contracts";

export interface PendingBehaviorDraftRef {
  current: ScriptModule | undefined;
}

/**
 * 提交脚本工作台尚未应用的草稿。导航方必须检查返回值；名称校验失败时保留
 * 原草稿和当前工作区，避免全局导航绕过面板校验造成静默丢稿。
 */
export function flushPendingBehaviorDraft(
  pendingRef: PendingBehaviorDraftRef,
  upsert: (draft: ScriptModule) => void | boolean,
): "unchanged" | "saved" | "name-required" | "write-rejected" {
  const draft = pendingRef.current;
  if (!draft) return "unchanged";
  if (!draft.name.trim()) return "name-required";
  if (upsert(draft) === false) return "write-rejected";
  pendingRef.current = undefined;
  return "saved";
}
