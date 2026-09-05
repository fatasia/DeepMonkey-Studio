import { useEffect, useRef, useState } from "react";
import { Camera, Crosshair } from "lucide-react";
import { downloadBlob } from "../browserDownload";
import { translate as tr, type AppLocale } from "../i18n";

export function OptimizerPreviewActions({ locale, ready, onFit, onCapture }: {
  locale: AppLocale; ready: boolean; onFit: () => void; onCapture: () => Promise<Blob>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function capture() {
    if (busy || !ready) return;
    setBusy(true); setError("");
    try { const blob = await onCapture(); if (mounted.current) downloadBlob(blob, "model-preview.png"); }
    catch { if (mounted.current) setError(tr(locale, "预览图生成失败，请重试", "Preview capture failed. Try again.")); }
    finally { if (mounted.current) setBusy(false); }
  }
  return <div className="optimizer-preview-actions">
    <button className="optimizer-fit-view" disabled={!ready} onClick={onFit}><Crosshair size={13} />{tr(locale, "适应窗口", "Fit view")}</button>
    <button className="optimizer-fit-view" disabled={!ready || busy} onClick={() => void capture()}><Camera size={13} />{tr(locale, "下载预览图", "Download preview")}</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
