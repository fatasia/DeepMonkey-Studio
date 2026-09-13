import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { X, LoaderCircle } from "lucide-react";
import type { AssetLibraryItem, ModelRecord, ProjectAssetRecord, ProjectAssetMapRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import type { ResourcePreviewDefinition } from "./resourcePreviewRuntime";
import "./ProjectResourceDialogs.css";
import { ResourceLinkButton } from "./ResourceLinkButton";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { ResourceThumbnailEditor } from "./ResourceThumbnailEditor";
import { captureThumbnailSource } from "./thumbnailCrop";

const ModelPreview = lazy(() => import("./RobotAssetPreview").then(module => ({ default: module.RobotAssetPreview })));
export type ResourcePreviewItem = ModelRecord | ProjectAssetRecord | AssetLibraryItem;

export function ProjectResourcePreview({ item, locale, onClose, onThumbnailSaved }: { item: ResourcePreviewItem; locale: AppLocale; onClose: () => void; onThumbnailSaved?: ((item: ModelRecord | ProjectAssetRecord) => Promise<void> | void) | undefined }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState("");
  const [savingThumbnail, setSavingThumbnail] = useState(false);
  const [capture, setCapture] = useState<() => Promise<Blob>>();
  const captureReady = useCallback((next: (() => Promise<Blob>) | undefined) => setCapture(() => next), []);
  const library = "dimension" in item;
  const model = "status" in item;
  const kind = library ? item.dimension === "3d" ? "model" : item.dimension === "material" ? "pbr-material" : "environment" : model ? "model" : item.kind;
  const url = library ? item.previewUrl : model ? item.sourceUrl : item.url;
  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const onReady = useCallback((engine: ViewerEngine | undefined) => captureReady(engine ? async () => { engine.renderer.render(engine.scene, engine.camera); return captureThumbnailSource(engine.renderer.domElement); } : undefined), [captureReady]);
  const editable = !library && Boolean(onThumbnailSaved);
  return <dialog ref={dialog} className="project-resource-dialog resource-preview-dialog" aria-label={tr(locale, `浏览 ${item.name}`, `Browse ${item.name}`)} onCancel={event => { event.preventDefault(); if (!savingThumbnail) onClose(); }}>
    <header><h2>{item.name}</h2><button type="button" disabled={savingThumbnail} aria-label={tr(locale, "关闭资源浏览", "Close asset preview")} onClick={onClose}><X size={18} /></button></header>
    <div className={editable ? "resource-preview-workspace" : undefined}>
    <div className="project-resource-preview-content">
      {kind === "image" ? <img src={url} alt={item.name} onLoad={event => { const element = event.currentTarget; captureReady(() => captureThumbnailSource(element)); }} onError={() => { captureReady(undefined); setError(tr(locale, "图片加载失败", "Image could not be loaded")); }} />
        : kind === "video" ? <video src={url} controls playsInline preload="auto" aria-label={item.name} onLoadedData={event => { const element = event.currentTarget; captureReady(() => { element.pause(); return captureThumbnailSource(element); }); }} onError={() => { captureReady(undefined); setError(tr(locale, "视频无法播放，请检查文件或浏览器支持的编码", "Video cannot be played; check the file and browser codec support")); }} />
          : model && item.manifest ? <Suspense fallback={<Loading locale={locale} />}><ModelPreview locale={locale} model={item} onReady={onReady} label={tr(locale, "三维资源浏览", "3D asset preview")} /></Suspense>
            : model && item.format !== "glb" ? <p role="status">{item.message || tr(locale, "资源需要完成转换后才能浏览三维几何", "Finish conversion to browse 3D geometry")}</p>
              : <AppearancePreview key={item.id} definition={{ kind, url, ...(!library && !model && item.maps ? { maps: item.maps } : {}) }} {...(library && kind !== "model" ? { libraryItemId: item.id } : {})} locale={locale} onCapture={captureReady} />}
      {error && <p className="project-resource-error" role="alert">{error}</p>}
    </div>
    {editable && !library && <ResourceThumbnailEditor item={item} locale={locale} capture={capture} onSaved={onThumbnailSaved!} onBusyChange={setSavingThumbnail} />}
    </div>
    {!library && !model && item.kind === "pbr-material" && item.maps && item.maps.length > 1 && <details className="resource-map-links"><summary>{tr(locale, "贴图外链", "Texture file links")}</summary>{item.maps.map(map => <div key={map.kind}><span>{map.name}</span><ResourceLinkButton locale={locale} name={map.name} resource={{ ...item, url: map.url }} /></div>)}</details>}
    <footer><span>{item.size >= 1024 * 1024 ? `${(item.size / 1024 / 1024).toFixed(1)} MB` : `${Math.max(.1, item.size / 1024).toFixed(1)} KB`}</span><span>{kind === "image" || kind === "video" ? "" : tr(locale, "拖动旋转 · 滚轮缩放", "Drag to orbit · Scroll to zoom")}</span><ResourceLinkButton locale={locale} name={item.name} {...(library ? { browse: { kind: "library", id: item.id } as const } : { resource: item })} /></footer>
  </dialog>;
}

function AppearancePreview({ definition, libraryItemId, locale, onCapture }: { definition: ResourcePreviewDefinition; libraryItemId?: string; locale: AppLocale; onCapture: (capture: (() => Promise<Blob>) | undefined) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    setLoading(true); setError("");
    void (async () => {
      const maps: ProjectAssetMapRecord[] | undefined = libraryItemId ? await api.getAssetLibraryMaps(libraryItemId, controller.signal) : definition.maps;
      const { createResourcePreview } = await import("./resourcePreviewRuntime");
      if (controller.signal.aborted || !host.current) return;
      if (definition.kind === "pbr-material" && !maps?.some(map => map.kind === "base-color")) throw new Error(tr(locale, "材质缺少基础色贴图", "Material is missing a base color map"));
      dispose = createResourcePreview(host.current, { ...definition, ...(maps ? { maps } : {}) }, message => { if (!controller.signal.aborted) { setLoading(false); setError(message ?? ""); if (message) onCapture(undefined); } }, onCapture);
    })().catch(reason => { if (!controller.signal.aborted) { setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)); } });
    return () => { controller.abort(); dispose?.(); };
  }, [definition.url, libraryItemId, retry]);
  return <div className="appearance-resource-preview"><div ref={host} className="appearance-resource-canvas" />{loading && <Loading locale={locale} />}{error && <div className="resource-preview-feedback" role="alert"><p>{error}</p><button className="button" onClick={() => setRetry(value => value + 1)}>{tr(locale, "重试", "Retry")}</button></div>}</div>;
}
function Loading({ locale }: { locale: AppLocale }) { return <span className="resource-preview-feedback" role="status"><LoaderCircle className="spin" size={18} />{tr(locale, "正在加载资源…", "Loading asset…")}</span>; }
