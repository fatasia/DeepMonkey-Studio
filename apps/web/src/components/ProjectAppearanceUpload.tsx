import { useEffect, useRef, useState } from "react";
import { LoaderCircle, Mountain, Paintbrush, X } from "lucide-react";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import "./ProjectResourceDialogs.css";
import type { ProjectAssetRecord } from "@bim-studio/contracts";

const mapLabels = [
  ["base-color", "基础色", "Base color"], ["normal", "法线", "Normal"],
  ["roughness", "粗糙度", "Roughness"], ["metalness", "金属度", "Metalness"], ["ao", "环境遮蔽", "Ambient occlusion"],
] as const;

export function ProjectAppearanceUpload({ projectId, locale, disabled, onUploaded, onResourcesUploaded }: {
  projectId: string; locale: AppLocale; disabled: boolean; onUploaded: () => Promise<void>; onResourcesUploaded?: (items: ProjectAssetRecord[]) => void;
}) {
  const environmentInput = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const uploadLock = useRef(false);
  const materialUploaded = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [maps, setMaps] = useState<Parameters<typeof api.uploadMaterialAsset>[1]>({});
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);

  async function uploadEnvironment(files: FileList | null) {
    if (!files?.length || uploadLock.current) return;
    uploadLock.current = true;
    setBusy(true); setError("");
    try {
      const uploaded: ProjectAssetRecord[] = [];
      for (const file of Array.from(files)) { uploaded.push(await api.uploadEnvironmentMap(projectId, file)); if (mounted.current) onResourcesUploaded?.([...uploaded]); }
      await onUploaded();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); await onUploaded().catch(() => undefined); }
    finally { uploadLock.current = false; setBusy(false); if (environmentInput.current) environmentInput.current.value = ""; }
  }
  async function uploadMaterial() {
    if (!maps["base-color"] || uploadLock.current) return;
    uploadLock.current = true;
    setBusy(true); setError("");
    try {
      if (!materialUploaded.current) { const asset = await api.uploadMaterialAsset(projectId, maps); materialUploaded.current = true; if (mounted.current) onResourcesUploaded?.([asset]); }
      await onUploaded(); setOpen(false); setMaps({});
    } catch (reason) {
      setError(materialUploaded.current ? tr(locale, "材质已保存，资源列表刷新失败，请重试刷新", "Material saved, but the asset list could not refresh. Retry refresh") : reason instanceof Error ? reason.message : String(reason));
    }
    finally { uploadLock.current = false; setBusy(false); }
  }
  return <>
    <button className="button" disabled={disabled || busy} onClick={() => environmentInput.current?.click()}><Mountain size={16} />{tr(locale, "上传环境", "Upload environment")}</button>
    <button className="button" disabled={disabled || busy} onClick={() => { materialUploaded.current = false; setError(""); setMaps({}); setOpen(true); }}><Paintbrush size={16} />{tr(locale, "上传材质", "Upload material")}</button>
    <input ref={environmentInput} type="file" hidden multiple accept=".hdr,.exr,.jpg,.jpeg,.png,.webp" onChange={event => void uploadEnvironment(event.target.files)} />
    {busy && !open && <span role="status"><LoaderCircle className="spin" size={14} />{tr(locale, "正在上传环境…", "Uploading environment…")}</span>}
    {error && !open && <span className="project-resource-error" role="alert">{error}</span>}
    <dialog ref={dialog} className="project-resource-dialog material-upload-dialog" aria-label={tr(locale, "上传 PBR 材质", "Upload PBR material")} onCancel={event => { event.preventDefault(); if (!busy) setOpen(false); }}>
      <form onSubmit={event => { event.preventDefault(); void uploadMaterial(); }}>
        <header><h2>{tr(locale, "上传 PBR 材质", "Upload PBR material")}</h2><button type="button" disabled={busy} aria-label={tr(locale, "关闭", "Close")} onClick={() => setOpen(false)}><X size={18} /></button></header>
        <div className="material-upload-fields">
          {mapLabels.map(([kind, zh, en]) => <label key={kind}><span>{tr(locale, zh, en)}{kind === "base-color" ? " *" : ""}</span><input key={`${kind}-${open}`} type="file" required={kind === "base-color"} disabled={busy || materialUploaded.current} accept=".jpg,.jpeg,.png,.webp" onChange={event => { const file = event.target.files?.[0]; setMaps(current => { const next = { ...current }; if (file) next[kind] = file; else delete next[kind]; return next; }); }} /></label>)}
        </div>
        {error && <p className="project-resource-error" role="alert">{error}</p>}
        <footer><span>{tr(locale, "JPG、PNG、WEBP · 每张最多 32 MB", "JPG, PNG, WEBP · Up to 32 MB each")}</span><button className="button primary" disabled={busy || !maps["base-color"]}>{busy && <LoaderCircle className="spin" size={14} />}{materialUploaded.current ? tr(locale, "刷新资源", "Refresh assets") : tr(locale, "上传材质", "Upload material")}</button></footer>
      </form>
    </dialog>
  </>;
}
