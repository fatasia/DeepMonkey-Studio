import { useRef, useState, type CSSProperties } from "react";
import { Check, Image, MonitorCog, Palette, Save, Upload } from "lucide-react";
import type { SystemBrandingSettings } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { SecondaryPageBack } from "./SecondaryPageBack";
import { ViewerPerformanceSettings } from "./ViewerPerformanceSettings";

interface BrandingSettingsPageProps {
  value: SystemBrandingSettings;
  locale: AppLocale;
  onChange: (value: SystemBrandingSettings) => void;
  onBack: () => void;
}

export function BrandingSettingsPage({ value, locale, onChange, onBack }: BrandingSettingsPageProps) {
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const logoRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<HTMLInputElement>(null);
  const t = (chinese: string, english: string) => tr(locale, chinese, english);
  const patch = <K extends keyof SystemBrandingSettings>(key: K, next: SystemBrandingSettings[K]) => setDraft((current) => ({ ...current, [key]: next }));

  async function save() {
    setBusy(true);
    setMessage(undefined);
    try {
      const saved = await api.saveBranding(draft);
      setDraft(saved);
      onChange(saved);
      setMessage(t("全局设置已生效", "Global settings applied"));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function upload(kind: "logo" | "icon", file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage(undefined);
    try {
      const result = await api.uploadBrandingAsset(kind, file);
      setDraft(result.settings);
      onChange(result.settings);
      setMessage(kind === "logo" ? t("Logo 已替换", "Logo updated") : t("Icon 已替换", "Icon updated"));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="branding-settings-page">
      <header className="secondary-page-header">
        <div className="secondary-page-heading-row">
          <SecondaryPageBack locale={locale} onBack={onBack} />
          <div className="secondary-page-title">
            <small>SYSTEM SETTINGS</small>
            <h1>{t("外观与全局设置", "Appearance & global settings")}</h1>
            <p>{t("统一管理产品品牌、默认体验与维护状态。", "Manage product identity, defaults, and maintenance status in one place.")}</p>
          </div>
          <button className="branding-save" disabled={busy} onClick={() => void save()}>
            <Save size={15} />
            {t("保存并应用", "Save & apply")}
          </button>
        </div>
      </header>

      <div className="branding-layout">
        <section className="branding-preview">
          <div className={`branding-preview-window theme-${draft.themeMode}`} style={{ "--preview-accent": draft.primaryColor } as CSSProperties}>
            <div className="branding-preview-bar">
              <img src={draft.iconUrl} alt="Icon" />
              <span>{draft.browserTitle}</span>
              <i />
              <i />
              <i />
            </div>
            <div className="branding-preview-login">
              <img src={draft.logoUrl} alt="Logo" />
              <strong>{draft.systemName}</strong>
              <span>{draft.loginSubtitle}</span>
              <button>{t("登录", "Sign in")}</button>
            </div>
            <footer>{draft.copyright}</footer>
          </div>
          <div className="branding-asset-row">
            <article>
              <span>
                <img src={draft.logoUrl} alt={t("当前 Logo", "Current logo")} />
              </span>
              <div>
                <strong>Logo</strong>
                <small>{t("登录页、管理中心与工作台", "Login, manager, and studio")}</small>
              </div>
              <button onClick={() => logoRef.current?.click()}>
                <Upload size={14} />
                {t("替换", "Replace")}
              </button>
            </article>
            <article>
              <span className="icon">
                <img src={draft.iconUrl} alt={t("当前 Icon", "Current icon")} />
              </span>
              <div>
                <strong>{t("应用 Icon", "App icon")}</strong>
                <small>{t("浏览器标签与快捷入口", "Browser tab and shortcuts")}</small>
              </div>
              <button onClick={() => iconRef.current?.click()}>
                <Upload size={14} />
                {t("替换", "Replace")}
              </button>
            </article>
          </div>
          <input ref={logoRef} hidden type="file" accept="image/png,image/webp,image/svg+xml,image/jpeg" onChange={(event) => void upload("logo", event.target.files?.[0])} />
          <input ref={iconRef} hidden type="file" accept="image/png,image/webp,image/svg+xml,image/x-icon" onChange={(event) => void upload("icon", event.target.files?.[0])} />
        </section>

        <div className="branding-sections">
          <ViewerPerformanceSettings locale={locale} />
          <section>
            <header>
              <Image size={16} />
              <div>
                <strong>{t("品牌标识", "Brand identity")}</strong>
                <small>{t("影响所有主要页面与浏览器标签", "Used across primary pages and browser tabs")}</small>
              </div>
            </header>
            <div className="branding-form-grid">
              <label>
                <span>{t("界面主题", "Interface theme")}</span>
                <select value={draft.themeMode} onChange={(event) => patch("themeMode", event.target.value as SystemBrandingSettings["themeMode"])}>
                  <option value="dark">{t("深色", "Dark")}</option>
                  <option value="light">{t("浅色", "Light")}</option>
                </select>
              </label>
              <label>
                <span>{t("系统名称", "System name")}</span>
                <input value={draft.systemName} onChange={(event) => patch("systemName", event.target.value)} />
              </label>
              <label>
                <span>{t("浏览器标题", "Browser title")}</span>
                <input value={draft.browserTitle} onChange={(event) => patch("browserTitle", event.target.value)} />
              </label>
              <label className="wide">
                <span>{t("登录页副标题", "Login subtitle")}</span>
                <input value={draft.loginSubtitle} onChange={(event) => patch("loginSubtitle", event.target.value)} />
              </label>
              <label className="wide">
                <span>{t("版权标识", "Copyright")}</span>
                <input value={draft.copyright} onChange={(event) => patch("copyright", event.target.value)} />
              </label>
            </div>
          </section>

          <section>
            <header>
              <Palette size={16} />
              <div>
                <strong>{t("界面与默认场景", "Interface & scene defaults")}</strong>
                <small>{t("新场景采用这里的背景和网格偏好", "New scenes use these background and grid defaults")}</small>
              </div>
            </header>
            <div className="branding-form-grid">
              <label>
                <span>{t("主题色", "Accent color")}</span>
                <div className="branding-color">
                  <input type="color" value={draft.primaryColor} onChange={(event) => patch("primaryColor", event.target.value)} />
                  <input value={draft.primaryColor} onChange={(event) => patch("primaryColor", event.target.value)} />
                </div>
              </label>
              <label>
                <span>{t("场景背景", "Scene background")}</span>
                <div className="branding-color">
                  <input type="color" value={draft.defaultSceneBackground} onChange={(event) => patch("defaultSceneBackground", event.target.value)} />
                  <input value={draft.defaultSceneBackground} onChange={(event) => patch("defaultSceneBackground", event.target.value)} />
                </div>
              </label>
              <label>
                <span>{t("默认语言", "Default language")}</span>
                <select value={draft.defaultLocale} onChange={(event) => patch("defaultLocale", event.target.value as SystemBrandingSettings["defaultLocale"])}>
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English</option>
                </select>
              </label>
              <label>
                <span>{t("登录后入口", "After-login page")}</span>
                <select value={draft.defaultEntry} onChange={(event) => patch("defaultEntry", event.target.value as SystemBrandingSettings["defaultEntry"])}>
                  <option value="manager">{t("场景管理", "Scene manager")}</option>
                  <option value="studio">{t("最近场景工作台", "Recent scene studio")}</option>
                  <option value="data">{t("数据中心", "Data center")}</option>
                </select>
              </label>
              <label className="branding-switch wide">
                <input type="checkbox" checked={draft.defaultGridVisible} onChange={(event) => patch("defaultGridVisible", event.target.checked)} />
                <span>
                  <b>{t("新场景默认显示网格", "Show grid in new scenes")}</b>
                  <small>{t("已有场景继续使用各自保存的设置", "Existing scenes keep their saved settings")}</small>
                </span>
              </label>
            </div>
          </section>

          <section>
            <header>
              <MonitorCog size={16} />
              <div>
                <strong>{t("运行状态", "Runtime status")}</strong>
                <small>{t("维护期间管理员仍可登录检查系统", "Administrators can still sign in during maintenance")}</small>
              </div>
            </header>
            <div className="branding-form-grid">
              <label className="branding-switch wide">
                <input type="checkbox" checked={draft.maintenanceEnabled} onChange={(event) => patch("maintenanceEnabled", event.target.checked)} />
                <span>
                  <b>{t("维护模式", "Maintenance mode")}</b>
                  <small>{t("阻止普通用户进入和修改数据", "Block standard users from entering or changing data")}</small>
                </span>
              </label>
              <label className="wide">
                <span>{t("维护提示", "Maintenance message")}</span>
                <input value={draft.maintenanceMessage} onChange={(event) => patch("maintenanceMessage", event.target.value)} />
              </label>
            </div>
          </section>
        </div>
      </div>
      {message && (
        <div className="branding-toast">
          <Check size={14} />
          {message}
        </div>
      )}
    </main>
  );
}
