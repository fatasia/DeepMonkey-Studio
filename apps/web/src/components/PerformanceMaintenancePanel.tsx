import { useEffect, useState } from "react";
import { Activity, Wrench } from "lucide-react";
import type { SystemBrandingSettings } from "@bim-studio/contracts";
import { api } from "../api";
import { ViewerPerformanceSettings } from "./ViewerPerformanceSettings";
import { translate as tr, type AppLocale } from "../i18n";

type Translate = (zh: string, en: string) => string;

/**
 * 设置中心「性能与维护」面板（批次 E 用户指令：性能与运行状态板块从品牌页迁出）。
 * 性能开关浏览器即时生效；维护模式经 saveBranding(PATCH 语义) 独立保存，不影响品牌其它字段。
 */
export function PerformanceMaintenancePanel({ locale, onError }: {
  locale: AppLocale;
  onError: (message: string) => void;
}) {
  const t: Translate = (zh, en) => tr(locale, zh, en);
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.getBranding().then((branding: SystemBrandingSettings) => {
      if (cancelled) return;
      setMaintenanceEnabled(branding.maintenanceEnabled);
      setMaintenanceMessage(branding.maintenanceMessage);
      setLoaded(true);
    }).catch((reason: unknown) => {
      if (!cancelled) onError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [onError]);

  async function saveMaintenance(next: { maintenanceEnabled: boolean; maintenanceMessage: string }): Promise<void> {
    setBusy(true);
    try {
      const saved = await api.saveBranding(next);
      setMaintenanceEnabled(saved.maintenanceEnabled);
      setMaintenanceMessage(saved.maintenanceMessage);
    } catch (reason: unknown) {
      onError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return <div className="system-performance-maintenance">
    <ViewerPerformanceSettings locale={locale} />
    <section>
      <header>
        <Activity size={16} />
        <div>
          <strong>{t("运行状态", "Runtime status")}</strong>
          <small>{t("维护期间管理员仍可登录检查系统", "Administrators can still sign in during maintenance")}</small>
        </div>
      </header>
      <div className="branding-form-grid">
        <label className="branding-switch wide">
          <input type="checkbox" disabled={!loaded || busy} checked={maintenanceEnabled}
            onChange={(event) => {
              const next = event.currentTarget.checked;
              setMaintenanceEnabled(next);
              void saveMaintenance({ maintenanceEnabled: next, maintenanceMessage });
            }} />
          <span>
            <b>{t("维护模式", "Maintenance mode")}</b>
            <small>{t("阻止普通用户进入和修改数据", "Block standard users from entering or changing data")}</small>
          </span>
        </label>
        <label className="wide">
          <span>{t("维护提示", "Maintenance message")}</span>
          <input value={maintenanceMessage} disabled={!loaded || busy}
            onChange={(event) => setMaintenanceMessage(event.currentTarget.value)}
            onBlur={() => { if (loaded) void saveMaintenance({ maintenanceEnabled, maintenanceMessage }); }} />
        </label>
      </div>
      <p className="system-performance-note">
        <Wrench size={12} />
        {t("维护模式即保存即生效；性能开关仅影响当前浏览器。", "Maintenance applies on save; performance toggles affect this browser only.")}
      </p>
    </section>
  </div>;
}
