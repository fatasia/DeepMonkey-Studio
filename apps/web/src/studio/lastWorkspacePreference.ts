/**
 * 每项目记忆上次使用的工作区(2D 看板 / 3D 场景):"编辑场景"入口按记忆落点,无记录保持默认二维。
 * localStorage 在私密模式可能不可用:读写都包一层,失败时按无记忆处理。
 */

export type LastWorkspaceView = "studio" | "dashboard";

const keyPrefix = "bim-studio:last-workspace:";

export function readLastWorkspace(projectId: string): LastWorkspaceView | undefined {
  try {
    const value = window.localStorage.getItem(keyPrefix + projectId);
    return value === "studio" || value === "dashboard" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastWorkspace(projectId: string, view: LastWorkspaceView): void {
  try {
    window.localStorage.setItem(keyPrefix + projectId, view);
  } catch {
    /* 私密窗口:本次会话内不持久化,行为回退到默认二维。 */
  }
}
