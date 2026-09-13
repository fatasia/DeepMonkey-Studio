export interface ViewerPerformancePreferences {
  demandRendering: boolean;
  repeatedAssets: boolean;
  acceleratedPicking: boolean;
  occlusionCulling: boolean;
  offscreenRendering: boolean;
}
const key = "bim-studio:viewer-performance";
const eventName = "bim-viewer-performance-change";
const defaults: ViewerPerformancePreferences = {
  demandRendering: true, repeatedAssets: true, acceleratedPicking: true, occlusionCulling: false, offscreenRendering: false,
};
let cached: ViewerPerformancePreferences | undefined;

export function getViewerPerformancePreferences(): ViewerPerformancePreferences {
  if (cached) return cached;
  cached = { ...defaults };
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    if (stored && typeof stored === "object") for (const name of Object.keys(defaults) as Array<keyof ViewerPerformancePreferences>) {
      const value = (stored as Record<string, unknown>)[name];
      if (typeof value === "boolean") cached[name] = value;
    }
  } catch { /* 存储不可用时，本次打开仍可即时调整。 */ }
  return cached;
}

export function setViewerPerformancePreference<K extends keyof ViewerPerformancePreferences>(name: K, value: ViewerPerformancePreferences[K]): void {
  cached = { ...getViewerPerformancePreferences(), [name]: value };
  try { window.localStorage.setItem(key, JSON.stringify(cached)); } catch { /* 私密窗口仍保留本次会话选择。 */ }
  window.dispatchEvent(new Event(eventName));
}

export function subscribeViewerPerformancePreferences(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) { cached = undefined; listener(); } };
  window.addEventListener(eventName, listener); window.addEventListener("storage", storage);
  return () => { window.removeEventListener(eventName, listener); window.removeEventListener("storage", storage); };
}
