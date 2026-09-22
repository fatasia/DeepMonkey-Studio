import { useState } from "react";
import { Database, RefreshCw, Trash2 } from "lucide-react";
import { translate, type AppLocale } from "../i18n";
import { clearThumbnailCaches, inspectThumbnailCaches } from "../settings/thumbnailCache";
import "../styles/cache-management.css";

export function CacheManagementSettings({ locale }: { locale: AppLocale }) {
  const t = (zh: string, en: string) => translate(locale, zh, en);
  const [stats, setStats] = useState(inspectThumbnailCaches);
  const [message, setMessage] = useState("");
  const refresh = () => { setStats(inspectThumbnailCaches()); setMessage(t("缓存统计已更新", "Cache statistics refreshed")); };
  const clear = () => {
    const removed = clearThumbnailCaches();
    setStats(inspectThumbnailCaches());
    setMessage(t(`已清除 ${removed.entries} 张缩略图缓存，下次查看时自动生成。`, `Cleared ${removed.entries} cached thumbnails. They will regenerate when viewed.`));
  };
  return <section aria-label={t("缓存管理", "Cache management")}>
    <header><Database size={16} /><div><strong>{t("缓存管理", "Cache management")}</strong>
      <small>{t("当前会话 · 资源与预制体缩略图", "Current session · resource and prefab thumbnails")}</small></div></header>
    <p>{t(`${stats.entries} 张 · 估算 ${(stats.estimatedBytes / 1024 / 1024).toFixed(2)} MB`, `${stats.entries} thumbnails · estimated ${(stats.estimatedBytes / 1024 / 1024).toFixed(2)} MB`)}</p>
    <div className="cache-management-actions">
      <button type="button" className="secondary-button cache-refresh" onClick={refresh}><RefreshCw size={14} />{t("刷新统计", "Refresh statistics")}</button>
      <button type="button" className="secondary-button cache-clear" onClick={clear} disabled={stats.entries === 0}
        title={stats.entries === 0 ? t("暂无可清理的缩略图缓存", "No cached thumbnails to clear") : undefined}>
        <Trash2 size={14} />{t("清除缓存", "Clear cache")}</button>
    </div>
    <small>{t("仅释放缩略图缓存引用；项目、模型、草稿与登录状态保持不变。", "Releases thumbnail cache references; projects, models, drafts and sign-in are preserved.")}</small>
    <p role="status" aria-live="polite">{message}</p>
  </section>;
}
