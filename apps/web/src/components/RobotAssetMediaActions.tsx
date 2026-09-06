import { Camera, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ModelRecord } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { translate as tr, type AppLocale } from "../i18n";
import { downloadRobotScreenshot, downloadRobotSource } from "../robots/robotAssetMedia";

export function RobotAssetMediaActions({ locale, model, engine, disabled = false, screenshot = true, compact = false }: {
  locale: AppLocale; model: ModelRecord; engine?: ViewerEngine | undefined; disabled?: boolean | undefined; screenshot?: boolean; compact?: boolean;
}) {
  const operation = useRef<AbortController | undefined>(undefined);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => { setError(""); setBusy(false); return () => { operation.current?.abort(); operation.current = undefined; }; }, [model.projectId, model.id, model.updatedAt]);
  if (model.format !== "urdf" && model.format !== "zip") return null;
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const download = async () => {
    if (operation.current) return;
    const request = new AbortController(); operation.current = request; setBusy(true); setError("");
    try { await downloadRobotSource(model, request.signal); }
    catch (reason) { if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (operation.current === request) { operation.current = undefined; setBusy(false); } }
  };
  return <div className="model-asset-actions">
    <button className={compact ? "manager-icon-button" : "button"} disabled={disabled || busy || model.status !== "ready"} aria-label={t(`下载原包 ${model.name}`, `Download source ${model.name}`)} title={t("下载原包", "Download source")} onClick={() => void download()}><Download size={15} />{!compact && t("原包", "Source")}</button>
    {screenshot && <button className="button" disabled={disabled || busy || !engine} title={t("导出当前预览画面", "Export the current preview frame")} onClick={() => {
      if (!engine) return; setError("");
      try { downloadRobotScreenshot(engine, model.name); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    }}><Camera size={15} />{t("截图", "Screenshot")}</button>}
    {busy && !compact && <span role="status">{t("正在下载…", "Downloading…")}</span>}
    {error && <span role="alert">{error}</span>}
  </div>;
}
