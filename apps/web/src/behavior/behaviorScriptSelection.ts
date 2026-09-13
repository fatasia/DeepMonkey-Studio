/** 每个账号/应用只记文件 ID；恢复时仍由已授权应用中的脚本集合校验。 */
function key(userId: string, applicationId: string): string {
  return `bim-studio:script-selection:${encodeURIComponent(userId)}:${encodeURIComponent(applicationId)}`;
}

export function readBehaviorScriptSelection(userId: string, applicationId: string): string | undefined {
  try { return window.sessionStorage.getItem(key(userId, applicationId)) || undefined; }
  catch { return undefined; }
}

export function rememberBehaviorScriptSelection(userId: string, applicationId: string, scriptId: string): void {
  try { window.sessionStorage.setItem(key(userId, applicationId), scriptId); }
  catch { /* 存储不可用时仍保留当前内存中的选中状态。 */ }
}
