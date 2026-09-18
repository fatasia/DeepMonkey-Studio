import { RENDERER_BACKEND_STORAGE_KEY } from "../appDefaults";
import type { RendererBackend } from "./ViewerEngine";

export interface PendingRendererPreference {
  current: RendererBackend | undefined;
}

interface RendererPreferenceStorage {
  setItem(key: string, value: string): void;
}

/** 失败后由用户重试；自动恢复不能因仍保存旧偏好而不断重启候选。 */
export function canAutomaticallyChangeRenderer(
  phase: "idle" | "preparing" | "recovering" | "failed",
  switching: boolean,
): boolean {
  return phase === "idle" && !switching;
}

/** 仅登记用户意图；候选后端初始化和场景恢复完成前不得写入持久化偏好。 */
export function stageRendererPreference(
  pending: PendingRendererPreference,
  backend: RendererBackend,
  persist: boolean,
): void {
  pending.current = persist ? backend : undefined;
}

/** 只接受当前已激活后端，避免失败候选或迟到切换污染下次启动。 */
export function commitRendererPreference(
  pending: PendingRendererPreference,
  active: RendererBackend,
  storage: RendererPreferenceStorage = window.localStorage,
): boolean {
  if (pending.current !== active) return false;
  pending.current = undefined;
  storage.setItem(RENDERER_BACKEND_STORAGE_KEY, active);
  return true;
}
