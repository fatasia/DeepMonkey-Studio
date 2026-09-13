import type { AppRoute } from "./appRoute";

/** 项目身份进入可复制的路由；独立模块刷新后仍操作同一项目。 */
export function carriesProjectContext(view: AppRoute["view"]): boolean {
  return ["manager", "data", "optimizer", "parametric", "vision", "operations", "system", "branding"].includes(view);
}

const storageKey = (userId: string) => `bim-studio:active-project:${encodeURIComponent(userId)}`;

export function readProjectContext(userId: string): string | undefined {
  try { return window.sessionStorage.getItem(storageKey(userId)) || undefined; }
  catch { return undefined; }
}

export function rememberProjectContext(userId: string, projectId: string | undefined): void {
  if (!userId) return;
  try {
    if (projectId) window.sessionStorage.setItem(storageKey(userId), projectId);
    else window.sessionStorage.removeItem(storageKey(userId));
  } catch { /* 浏览器禁用存储时仍可通过 URL 恢复，不阻断正常编辑。 */ }
}
