import { useState, useSyncExternalStore } from "react";
import { Gauge } from "lucide-react";
import { translate, type AppLocale } from "../i18n";
import { getOffscreenGlobalStatus, subscribeOffscreenGlobalStatus } from "../viewer/viewerOffscreenController";
import { getViewerPerformancePreferences, setViewerPerformancePreference, subscribeViewerPerformancePreferences, type ViewerPerformancePreferences } from "../viewer/viewerPerformancePreferences";
import { setSceneTreeWindowing, useSceneTreeWindowing } from "./sceneTreePreference";

export function ViewerPerformanceSettings({ locale }: { locale: AppLocale }) {
  const preferences = useSyncExternalStore(subscribeViewerPerformancePreferences, getViewerPerformancePreferences);
  const windowTree = useSceneTreeWindowing();
  const offscreenStatus = useSyncExternalStore(subscribeOffscreenGlobalStatus, getOffscreenGlobalStatus);
  const [message, setMessage] = useState("");
  const t = (zh: string, en: string) => translate(locale, zh, en);
  const options: Array<{ key: keyof ViewerPerformancePreferences; label: string; hint: string }> = [
    { key: "demandRendering", label: t("静止场景按需渲染", "Render static scenes on demand"), hint: t("静止时暂停绘制，操作和动画立即恢复。", "Pause static frames; resume for interaction and animation.") },
    { key: "repeatedAssets", label: t("重复模型合批", "Batch repeated models"), hint: t("合并兼容模型的绘制，保留各对象独立编辑。", "Batch compatible draws while preserving individual editing.") },
    { key: "acceleratedPicking", label: t("高面数模型选择加速", "Accelerate dense model selection"), hint: t("高面数静态模型在后台准备，首次选择仍立即响应。", "Prepare dense static models in the background; first selections remain available.") },
    { key: "occlusionCulling", label: t("遮挡剔除", "Occlusion culling"), hint: t("跳过被实体墙完全遮住的静态模型。动态或剖切场景自动使用原路径。", "Skip static meshes fully behind solid walls; dynamic and clipped scenes use the regular path.") },
    { key: "offscreenRendering", label: t("后台线程渲染", "Render in a background thread"), hint: t("将兼容的 WebGL 场景交给后台线程绘制；不兼容或失败时自动恢复。", "Render compatible WebGL scenes in a worker; fall back automatically when needed.") },
  ];
  const applied = () => setMessage(t("本机性能偏好已应用", "Local performance preferences applied"));
  return <section>
    <header><Gauge size={16} /><div><strong>{t("性能", "Performance")}</strong><small>{t("仅此浏览器，即时生效", "This browser only · applied immediately")}</small></div></header>
    <div className="branding-form-grid">
      <label className="branding-switch wide" title={t("大型目录仅绘制可见行，关闭后显示完整目录。", "Render only visible rows in large trees; turn off to render the complete tree.")}>
        <input type="checkbox" checked={windowTree} onChange={event => { setSceneTreeWindowing(event.target.checked); applied(); }} />
        <span><b>{t("大型目录按需显示", "Render large trees on demand")}</b></span>
      </label>
      {options.map(option => <label className="branding-switch wide" key={option.key} title={option.hint}>
        <input type="checkbox" checked={preferences[option.key]} onChange={event => { setViewerPerformancePreference(option.key, event.target.checked); applied(); }} />
        <span><b>{option.label}</b></span>
      </label>)}
    </div>
    {message && <p role="status">{message}</p>}
    {offscreenStatus.mode !== "off" && <p role="status" data-offscreen-status={offscreenStatus.mode}>
      {offscreenStatus.mode === "active" && t("后台线程渲染运行中", "Background-thread rendering is active")}
      {offscreenStatus.mode === "starting" && t("后台线程渲染启动中…", "Starting background-thread rendering…")}
      {offscreenStatus.mode === "fallback" && t(`已回退主线程渲染:${offscreenStatus.reason ?? "原因未知"}`, `Fell back to main-thread rendering: ${offscreenStatus.reason ?? "unknown"}`)}
    </p>}
  </section>;
}
