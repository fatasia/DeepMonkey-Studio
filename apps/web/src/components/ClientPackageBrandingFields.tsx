import { useEffect, useRef, useState } from "react";
import { ImagePlus, RotateCcw } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { clientBrandingNameInvalid, DEFAULT_CLIENT_NAME, readClientIcon, type ClientPackageBranding } from "./clientPackageBranding";
import "./ClientPackageBrandingFields.css";

export function ClientPackageBrandingFields({ locale, value, onChange, disabled, onPendingChange, scopeLabel, scopeNote }: {
  locale: AppLocale; value: ClientPackageBranding; onChange(value: ClientPackageBranding): void;
  disabled: boolean; onPendingChange(pending: boolean): void;
  scopeLabel?: string; scopeNote?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null), ticket = useRef(0);
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  useEffect(() => () => { ticket.current += 1; onPendingChange(false); }, []);
  const choose = async (file: File | undefined) => {
    if (!file) return;
    const current = ++ticket.current;
    setError(""); setReading(true); onPendingChange(true);
    try {
      const iconDataUrl = await readClientIcon(file);
      if (current === ticket.current) onChange({ ...value, iconDataUrl });
    } catch (reason) {
      if (current === ticket.current) setError(reason instanceof Error && reason.message === "icon_size"
        ? tr(locale, "图标不能为空，且不能超过 2 MiB。", "Choose a non-empty icon up to 2 MiB.")
        : tr(locale, "请选择 PNG 或 ICO 图标。", "Choose a PNG or ICO icon."));
    } finally {
      if (current === ticket.current) { setReading(false); onPendingChange(false); }
    }
  };
  const invalidName = clientBrandingNameInvalid(value.applicationName);
  return <fieldset className="dashboard-client-branding" disabled={disabled}>
    <legend>{scopeLabel ?? tr(locale, "Windows 客户端", "Windows client")}</legend>
    <label className="dashboard-client-name">
      <span>{tr(locale, "客户端名称", "Client name")}</span>
      <input value={value.applicationName ?? ""} placeholder={DEFAULT_CLIENT_NAME} maxLength={80}
        aria-invalid={invalidName} disabled={disabled || reading}
        onChange={event => onChange({ ...value, applicationName: event.target.value })} />
    </label>
    <div className="dashboard-client-icon-row">
      <img className="dashboard-client-icon" src={value.iconDataUrl ?? "/brand/app-icon-industrial.svg"}
        alt={tr(locale, "客户端图标预览", "Client icon preview")} />
      <div className="dashboard-client-icon-actions">
        <span>{tr(locale, "LOGO / 图标", "Logo / icon")}</span>
        <button type="button" disabled={disabled || reading} onClick={() => fileInput.current?.click()}>
          <ImagePlus size={14} />{reading ? tr(locale, "读取中…", "Reading…") : tr(locale, "选择图标", "Choose icon")}
        </button>
        <small>PNG / ICO · ≤ 2 MiB</small>
      </div>
      <button type="button" className="dashboard-client-reset" disabled={disabled}
        onClick={() => { ticket.current += 1; setReading(false); onPendingChange(false); setError(""); onChange({}); }}>
        <RotateCcw size={13} />{tr(locale, "恢复默认", "Reset")}
      </button>
      <input ref={fileInput} hidden tabIndex={-1} type="file" accept="image/png,image/x-icon,image/vnd.microsoft.icon,.png,.ico"
        onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void choose(file); }} />
    </div>
    <p className="dashboard-offline-meta">{scopeNote ?? tr(locale, "仅用于 EXE 和 ZIP；Web 静态包与 DMDA 不包含 Windows 客户端。", "EXE and ZIP only; Web packages and DMDA do not include a Windows client.")}</p>
    {(error || invalidName) && <p className="dashboard-offline-error" role="alert">{error || tr(locale,
      "名称最多 80 个字符，不能包含控制字符。", "Use up to 80 characters without control characters.")}</p>}
  </fieldset>;
}
