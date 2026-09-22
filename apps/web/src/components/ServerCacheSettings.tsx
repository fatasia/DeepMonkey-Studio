import { useEffect, useRef, useState } from "react";
import { HardDrive, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../api";
import { isLocalDesktopMode } from "../adapters/desktopRuntimeMode";
import { translate, type AppLocale } from "../i18n";
import "../styles/cache-management.css";

export function ServerCacheSettings({ locale }: { locale: AppLocale }) {
  const t = (zh: string, en: string) => translate(locale, zh, en);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.getPackagingCache>>>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const active = useRef(false);
  const mounted = useRef(true);
  const local = isLocalDesktopMode();
  const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

  async function run(clear: boolean) {
    if (active.current) return;
    active.current = true;
    setBusy(true); setError(""); setMessage("");
    try {
      if (clear) {
        const result = await api.clearPackagingCache();
        if (mounted.current) setMessage(t(
          `已清理 ${result.removedEntries} 个文件，释放 ${size(result.removedBytes)}；跳过 ${result.skippedEntries} 项。`,
          `Removed ${result.removedEntries} files, freed ${size(result.removedBytes)}; skipped ${result.skippedEntries} items.`,
        ));
      }
      const latest = await api.getPackagingCache();
      if (mounted.current) setStats(latest);
    } catch (reason) {
      if (mounted.current) {
        const detail = reason instanceof Error ? reason.message : String(reason);
        setError(/not found|404/i.test(detail)
          ? t("服务器缓存接口尚未就绪，请更新并重启 API 服务后重试。", "The server cache endpoint is unavailable. Update and restart the API service, then retry.")
          : detail);
      }
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    if (!local) void run(false);
    return () => { mounted.current = false; };
  }, [local]);

  if (local) return null;
  return <section aria-label={t("服务器打包缓存", "Server packaging cache")}>
    <header><HardDrive size={16} /><div><strong>{t("服务器打包缓存", "Server packaging cache")}</strong>
      <small>{t("Three WebView · 可重新构建的临时副本", "Three WebView · rebuildable copies")}</small></div></header>
    <p>{stats ? t(`${stats.entries} 个文件 · ${size(stats.bytes)}`, `${stats.entries} files · ${size(stats.bytes)}`)
      : error ? t("缓存统计不可用", "Cache statistics unavailable") : t("正在读取…", "Loading…")}</p>
    <div className="cache-management-actions">
      <button type="button" className="secondary-button cache-refresh" disabled={busy} onClick={() => void run(false)}><RefreshCw size={14} />{t("刷新统计", "Refresh statistics")}</button>
      <button type="button" className="secondary-button cache-clear" disabled={busy || !stats?.entries} onClick={() => void run(true)}
        title={!stats?.entries ? t("暂无可清理的打包缓存", "No packaging cache to clear") : undefined}>
        <Trash2 size={14} />{t("清除打包缓存", "Clear packaging cache")}</button>
    </div>
    <small>{t("下次打包将重新构建；已发布文件保持不变。清理会等待当前打包完成。", "The next package rebuilds. Published files are preserved. Cleanup waits for active packaging.")}</small>
    <p role="status" aria-live="polite">{busy ? t("处理中…", "Working…") : message}</p>
    {error && <p role="alert">{error}</p>}
  </section>;
}
