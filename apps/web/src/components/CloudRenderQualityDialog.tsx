import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "lucide-react";
import { CLOUD_RENDER_RESOLUTIONS, type CloudRenderResolution, type CloudRenderSceneControl } from "@bim-studio/server-sdk";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import "./ProjectResourceDialogs.css";

export function CloudRenderQualityEntry({ sceneId, locale }: { sceneId: string; locale: AppLocale }) {
  const [open, setOpen] = useState(false);
  return <><button type="button" onClick={event => {
    const menu = event.currentTarget.closest("details");
    if (menu) { menu.open = false; menu.querySelector("summary")?.focus(); }
    setOpen(true);
  }}><SlidersHorizontal size={13} />{tr(locale, "云渲染画质", "Cloud quality")}</button>
    {open && createPortal(<CloudRenderQualityDialog sceneId={sceneId} locale={locale} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

function CloudRenderQualityDialog({ sceneId, locale, onClose }: { sceneId: string; locale: AppLocale; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [scene, setScene] = useState<CloudRenderSceneControl>();
  const [resolution, setResolution] = useState<CloudRenderResolution>(1080);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saving = useRef(false);
  const t = (zh: string, en: string) => tr(locale, zh, en);
  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current;
    let closed = false;
    element?.showModal();
    void api.getCloudRenderOverview().then(overview => {
      if (closed) return;
      const item = overview.scenes.find(candidate => candidate.sceneId === sceneId);
      if (!item) throw new Error(t("场景尚未发布", "Scene is not published"));
      setScene(item); setResolution(item.resolution ?? 1080);
    }).catch(reason => { if (!closed) setError(String(reason)); });
    return () => { closed = true; element?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [sceneId]);
  async function save() {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await api.setCloudRenderResolution(sceneId, resolution);
      setNotice(t("画质已保存，下次开启云渲染时生效", "Quality saved; applies when cloud rendering is next started"));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { saving.current = false; setBusy(false); }
  }
  const session = scene?.session;
  const media = session && ["streaming", "degraded"].includes(session.state) ? session.mediaEvidence : undefined;
  return <dialog ref={dialog} className="project-resource-dialog material-upload-dialog" aria-label={t("云渲染画质", "Cloud quality")} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    <header><h2>{t("云渲染画质", "Cloud quality")}</h2><button type="button" disabled={busy} onClick={onClose} aria-label={t("关闭画质设置", "Close quality settings")}><X size={18} /></button></header>
    <div className="material-upload-fields">
      <label><span>{t("分辨率", "Resolution")}</span><select aria-label={t("云渲染分辨率", "Cloud resolution")} value={resolution} disabled={!scene || busy} onChange={event => { setResolution(Number(event.target.value) as CloudRenderResolution); setNotice(""); }}>
        {CLOUD_RENDER_RESOLUTIONS.map(value => <option key={value} value={value}>{value}P · {value * 16 / 9} × {value}</option>)}
      </select></label>
      <span>{t("目标帧率", "Target frame rate")} · 60 FPS</span>
      {media && <span>{t("当前实际输出", "Current output")} · {media.width} × {media.height} · {media.codec.toUpperCase()}{media.framesPerSecond !== undefined ? ` · ${media.framesPerSecond.toFixed(0)} FPS` : ""}</span>}
      {!scene && !error && <span role="status">{t("正在读取画质…", "Loading quality…")}</span>}
      {notice && <span role="status">{notice}</span>}
      {error && <span className="project-resource-error" role="alert">{error}</span>}
    </div>
    <footer><span>{t("画质按场景保存", "Quality is saved per scene")}</span><button type="button" className="button primary" disabled={!scene || busy} onClick={() => void save()}>{t(busy ? "保存中…" : "保存画质", busy ? "Saving…" : "Save quality")}</button></footer>
  </dialog>;
}
