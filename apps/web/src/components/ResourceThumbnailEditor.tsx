import { useEffect, useRef, useState } from "react";
import { Camera, ImagePlus, LoaderCircle, RotateCcw, Save } from "lucide-react";
import type { ModelRecord, ProjectAssetRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import { drawThumbnail, initialThumbnailCrop, loadThumbnailImage, thumbnailBlob, type ThumbnailCrop } from "./thumbnailCrop";
import "./ResourceThumbnailEditor.css";

export function ResourceThumbnailEditor({ item, locale, capture, onSaved, onBusyChange }: {
  item: ModelRecord | ProjectAssetRecord; locale: AppLocale; capture?: (() => Promise<Blob>) | undefined;
  onSaved: (item: ModelRecord | ProjectAssetRecord) => Promise<void> | void; onBusyChange: (busy: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const ticket = useRef(0);
  const locked = useRef(false);
  const [image, setImage] = useState<HTMLImageElement>();
  const [crop, setCrop] = useState<ThumbnailCrop>(initialThumbnailCrop);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [savedUrl, setSavedUrl] = useState(item.thumbnailUrl);
  useEffect(() => () => { ticket.current++; }, [item.id]);
  useEffect(() => {
    if (!image || !canvas.current) return;
    try { drawThumbnail(canvas.current, image, crop); } catch (reason) { setError(String(reason)); }
  }, [image, crop]);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); onBusyChange(true); setError(""); setNotice("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { locked.current = false; setBusy(false); onBusyChange(false); }
  }
  async function choose(source: Blob) {
    const version = ++ticket.current;
    const decoded = await loadThumbnailImage(source);
    if (version !== ticket.current) return;
    setImage(decoded); setCrop(initialThumbnailCrop);
  }
  async function save() {
    if (!canvas.current || !image) return;
    const updated = await api.saveResourceThumbnail(item.projectId, "status" in item ? "models" : "assets", item.id, await thumbnailBlob(canvas.current));
    setSavedUrl(updated.thumbnailUrl); setImage(undefined);
    setNotice(tr(locale, "缩略图已保存", "Thumbnail saved"));
    try { await onSaved(updated); }
    catch { setError(tr(locale, "缩略图已保存，列表刷新失败，请刷新资源列表", "Thumbnail saved. Refresh the asset list to see it.")); }
  }
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return <aside className="resource-thumbnail-editor" aria-label={t("缩略图设置", "Thumbnail settings")} aria-busy={busy}>
    <h3>{t("缩略图", "Thumbnail")}</h3>
    <div className="resource-thumbnail-crop" title={image ? t("拖动调整位置，也可使用下面的滑块", "Drag to reposition, or use the sliders below") : undefined}
      onPointerDown={event => {
        if (!image || busy || event.button !== 0) return;
        const element = event.currentTarget; element.setPointerCapture(event.pointerId);
        const start = { x: event.clientX, y: event.clientY, crop };
        const bounds = element.getBoundingClientRect();
        const move = (next: PointerEvent) => setCrop({ ...start.crop, x: Math.max(0, Math.min(1, start.crop.x - (next.clientX - start.x) / bounds.width)), y: Math.max(0, Math.min(1, start.crop.y - (next.clientY - start.y) / bounds.height)) });
        const stop = () => { element.removeEventListener("pointermove", move); element.removeEventListener("lostpointercapture", stop); };
        element.addEventListener("pointermove", move); element.addEventListener("lostpointercapture", stop, { once: true });
      }}>
      {image ? <canvas ref={canvas} aria-label={t("裁剪后的缩略图预览", "Cropped thumbnail preview")} /> : savedUrl ? <img src={savedUrl} alt={t("当前缩略图", "Current thumbnail")} /> : <span><ImagePlus size={28} />{t("使用默认预览", "Default preview")}</span>}
    </div>
    <div className="resource-thumbnail-actions">
      <button type="button" className="button" disabled={busy} onClick={() => input.current?.click()}><ImagePlus size={15} />{t("选择图片", "Choose image")}</button>
      <button type="button" className="button" disabled={busy || !capture} title={!capture ? t("等待资源预览就绪后可截取", "Wait for the preview to load before capturing") : undefined} onClick={() => void run(async () => { if (capture) await choose(await capture()); })}><Camera size={15} />{t("截取预览", "Capture preview")}</button>
    </div>
    <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp" aria-label={t("选择缩略图文件", "Choose thumbnail file")} onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file) return;
      void run(async () => { if (file.size > 8 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error(t("请选择 8 MB 以内的 PNG、JPG 或 WEBP 图片", "Choose a PNG, JPG or WEBP image under 8 MB")); await choose(file); });
    }} />
    {image && <fieldset disabled={busy} className="resource-thumbnail-adjustments">
      <legend>{t("裁剪 · 4:3", "Crop · 4:3")}</legend>
      {([["zoom", "缩放", "Zoom", 1, 4], ["x", "水平位置", "Horizontal position", 0, 1], ["y", "垂直位置", "Vertical position", 0, 1]] as const).map(([key, zh, en, min, max]) => <label key={key}><span>{t(zh, en)}</span><input type="range" min={min} max={max} step="0.01" value={crop[key]} onChange={event => setCrop(current => ({ ...current, [key]: event.target.valueAsNumber }))} /></label>)}
      <div className="resource-thumbnail-actions"><button type="button" className="button" onClick={() => setCrop(initialThumbnailCrop)}><RotateCcw size={14} />{t("重置裁剪", "Reset crop")}</button><button type="button" className="button" onClick={() => setImage(undefined)}>{t("取消", "Cancel")}</button></div>
      <button type="button" className="button primary" onClick={() => void run(save)}><Save size={15} />{t("保存缩略图", "Save thumbnail")}</button>
    </fieldset>}
    {busy && <p role="status"><LoaderCircle size={14} className="spin" />{t("正在处理…", "Processing…")}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="resource-thumbnail-error">{error}</p>}
  </aside>;
}
