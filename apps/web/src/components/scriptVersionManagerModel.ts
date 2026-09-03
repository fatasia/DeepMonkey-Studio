import type { ScriptModule } from "@bim-studio/contracts";

export interface ScriptSnapshotDiff {
  added: ScriptModule[];
  updated: ScriptModule[];
  removed: ScriptModule[];
  unchanged: ScriptModule[];
}

const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SCP_REMOTE_PATTERN = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+:[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validateCommitMessage(value: string): string | undefined {
  const message = value.trim();
  if (!message) return "请填写本次脚本修改说明";
  if (value.length > 200) return "提交说明不能超过 200 个字符";
  if (/[\r\n\0]/.test(value)) return "提交说明只能填写一行";
  return undefined;
}

export function validateRemoteDraft(urlValue: string, branchValue: string): string | undefined {
  const url = urlValue.trim();
  const branch = branchValue.trim();
  if (!url || url.length > 2_048 || url.startsWith("-") || /[\s\0]/.test(url)) return "请填写有效的远端地址";
  if (!isAllowedRemote(url)) return "仅支持不含凭据的 HTTP(S)、SSH 或 git@host:path 地址";
  if (!BRANCH_PATTERN.test(branch)
    || branch.endsWith("/") || branch.endsWith(".") || branch.endsWith(".lock")
    || branch.includes("..") || branch.includes("//") || branch.includes("@{")) return "远端分支名称无效";
  return undefined;
}

export function diffScriptSnapshots(current: readonly ScriptModule[], incoming: readonly ScriptModule[]): ScriptSnapshotDiff {
  const currentById = new Map(current.map((script) => [script.id, script]));
  const incomingById = new Map(incoming.map((script) => [script.id, script]));
  const added: ScriptModule[] = [];
  const updated: ScriptModule[] = [];
  const unchanged: ScriptModule[] = [];
  const removed = current.filter((script) => !incomingById.has(script.id));

  for (const script of incoming) {
    const existing = currentById.get(script.id);
    if (!existing) added.push(script);
    else if (sameScript(existing, script)) unchanged.push(script);
    else updated.push(script);
  }
  return { added, updated, removed, unchanged };
}

export function hasScriptSnapshotChanges(diff: ScriptSnapshotDiff): boolean {
  return Boolean(diff.added.length || diff.updated.length || diff.removed.length);
}

export function resolveEscapeAction(hasPendingPull: boolean, busy: boolean): "none" | "cancel-pull" | "close" {
  if (busy) return "none";
  return hasPendingPull ? "cancel-pull" : "close";
}

export function resolveFocusTrapIndex(length: number, activeIndex: number, shiftKey: boolean): number | undefined {
  if (length <= 0) return undefined;
  if (shiftKey && activeIndex <= 0) return length - 1;
  if (!shiftKey && (activeIndex < 0 || activeIndex === length - 1)) return 0;
  return undefined;
}

export function formatCommitTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function isAllowedRemote(value: string): boolean {
  if (SCP_REMOTE_PATTERN.test(value)) return true;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "ssh:"].includes(url.protocol) || !url.hostname || url.password || url.search || url.hash) return false;
    return !((url.protocol === "https:" || url.protocol === "http:") && url.username);
  } catch {
    return false;
  }
}

function sameScript(left: ScriptModule, right: ScriptModule): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
