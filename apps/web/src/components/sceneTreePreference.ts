import { createContext, useContext, useSyncExternalStore } from "react";

const key = "bim-studio:window-scene-tree", change = "bim-scene-tree-preference";
export const SceneTreeWindowingContext = createContext<boolean | undefined>(undefined);
function enabled() { try { return window.localStorage.getItem(key) !== "false"; } catch { return true; } }
function subscribe(listener: () => void) {
  window.addEventListener(change, listener); window.addEventListener("storage", listener);
  return () => { window.removeEventListener(change, listener); window.removeEventListener("storage", listener); };
}
export function useSceneTreeWindowing() {
  const override = useContext(SceneTreeWindowingContext), preference = useSyncExternalStore(subscribe, enabled, () => true);
  return override ?? preference;
}
export function setSceneTreeWindowing(value: boolean) {
  try { window.localStorage.setItem(key, String(value)); } catch { /* 隐私模式保留默认策略。 */ }
  window.dispatchEvent(new Event(change));
}
