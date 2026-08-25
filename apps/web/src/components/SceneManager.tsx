import { useMemo, useRef, useState } from "react";
import { Box, CalendarDays, Copy, Database, Eye, ExternalLink, FileImage, FileUp, FileVideo, Gauge, Image as ImageIcon, Layers3, Pencil, Plus, RefreshCw, Rocket, ScanSearch, Search, Trash2, Undo2, Video, X } from "lucide-react";
import type { ConversionStatus, ModelRecord, ProjectAssetRecord, ProjectRecord, SceneSnapshot, SystemBrandingSettings } from "@bim-studio/contracts";
import { SceneExportMenu } from "./SceneExportMenu";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { api } from "../api";

const ACCEPTED_MODELS = ".rvt,.ifc,.step,.stp,.dwg,.dxf,.gltf,.glb,.fbx";
const ACCEPTED_IMAGES = ".jpg,.jpeg,.png,.webp,.gif,.svg";
const ACCEPTED_VIDEOS = ".mp4,.webm,.ogv,.mov";

interface SceneManagerProps {
  locale: AppLocale;
  branding: SystemBrandingSettings;
  projects: ProjectRecord[];
  project: ProjectRecord | undefined;
  scenes: SceneSnapshot[];
  onProjectChange: (projectId: string) => void;
  onCreateProject: () => void;
  onRenameProject: () => void;
  onDeleteProject: () => void;
  onCreate: (name: string) => Promise<void>;
  onOpen: (scene: SceneSnapshot) => Promise<void>;
  onCopy: (scene: SceneSnapshot) => Promise<void>;
  onRename: (scene: SceneSnapshot, name: string) => Promise<void>;
  onPublish: (scene: SceneSnapshot) => Promise<void>;
  onUnpublish: (scene: SceneSnapshot) => Promise<void>;
  onBrowse: (scene: SceneSnapshot) => void;
  onBrowsePublished: (scene: SceneSnapshot) => void;
  onImport: () => void;
  onExportLoose: (scene: SceneSnapshot) => void;
  onExportSingle: (scene: SceneSnapshot) => Promise<void>;
  onExportGlb: (scene: SceneSnapshot) => Promise<void>;
  onExportFbx: (scene: SceneSnapshot) => Promise<void>;
  onDelete: (scene: SceneSnapshot) => Promise<void>;
  onOptimizer: () => void;
  onDataCenter: () => void;
  onVisionCenter: () => void;
  onUploadModels: (files: FileList) => Promise<void>;
  onDeleteModel: (model: ModelRecord) => Promise<void>;
  onRefreshModels: () => Promise<void>;
}

export function SceneManager({
  locale,
  branding,
  projects,
  project,
  scenes,
  onProjectChange,
  onCreateProject,
  onRenameProject,
  onDeleteProject,
  onCreate,
  onOpen,
  onCopy,
  onRename,
  onPublish,
  onUnpublish,
  onBrowse,
  onBrowsePublished,
  onImport,
  onExportLoose,
  onExportSingle,
  onExportGlb,
  onExportFbx,
  onDelete,
  onOptimizer,
  onDataCenter,
  onVisionCenter,
  onUploadModels,
  onDeleteModel,
  onRefreshModels
}: SceneManagerProps) {
  const [dialogMode, setDialogMode] = useState<"create" | "rename">();
  const [targetScene, setTargetScene] = useState<SceneSnapshot>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);
  const [modelLibraryBusy, setModelLibraryBusy] = useState(false);
  const [assetTab, setAssetTab] = useState<"all" | "model" | "image" | "video">("all");
  const [assetSearch, setAssetSearch] = useState("");
  const modelUploadRef = useRef<HTMLInputElement>(null);
  const imageUploadRef = useRef<HTMLInputElement>(null);
  const videoUploadRef = useRef<HTMLInputElement>(null);

  const sortedScenes = useMemo(() => [...scenes].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)), [scenes]);

  function openCreateDialog() {
    setTargetScene(undefined);
    setName("");
    setDialogMode("create");
  }

  function openRenameDialog(scene: SceneSnapshot) {
    setTargetScene(scene);
    setName(scene.name);
    setDialogMode("rename");
  }

  async function submitSceneDialog() {
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    try {
      if (dialogMode === "rename" && targetScene) await onRename(targetScene, value);
      else await onCreate(value);
      setName("");
      setTargetScene(undefined);
      setDialogMode(undefined);
    } finally {
      setBusy(false);
    }
  }

  async function uploadLibraryModels(files: FileList | null) {
    if (!files?.length) return;
    setModelLibraryBusy(true);
    try {
      await onUploadModels(files);
    } finally {
      setModelLibraryBusy(false);
      if (modelUploadRef.current) modelUploadRef.current.value = "";
    }
  }

  async function deleteLibraryModel(model: ModelRecord) {
    if (!window.confirm(tr(locale, `确定删除模型“${model.name}”吗？引用它的场景将无法再次加载该模型。`, `Delete model “${model.name}”? Scenes that reference it will no longer be able to load it.`))) return;
    setModelLibraryBusy(true);
    try {
      await onDeleteModel(model);
    } finally {
      setModelLibraryBusy(false);
    }
  }

  async function refreshLibraryModels() {
    setModelLibraryBusy(true);
    try {
      await onRefreshModels();
    } finally {
      setModelLibraryBusy(false);
    }
  }

  async function uploadLibraryImages(files: FileList | null) {
    if (!files?.length || !project) return;
    setModelLibraryBusy(true);
    try {
      for (const file of [...files]) await api.uploadImageAsset(project.id, file);
      await onRefreshModels();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setModelLibraryBusy(false);
      if (imageUploadRef.current) imageUploadRef.current.value = "";
    }
  }

  async function uploadLibraryVideos(files: FileList | null) {
    if (!files?.length || !project) return;
    setModelLibraryBusy(true);
    try {
      for (const file of [...files]) await api.uploadVideoAsset(project.id, file);
      await onRefreshModels();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setModelLibraryBusy(false);
      if (videoUploadRef.current) videoUploadRef.current.value = "";
    }
  }

  async function renameLibraryItem(item: ModelRecord | ProjectAssetRecord, kind: "model" | "asset") {
    if (!project) return;
    const nextName = window.prompt(tr(locale, "输入新的资源名称", "Enter a new asset name"), item.name)?.trim();
    if (!nextName || nextName === item.name) return;
    setModelLibraryBusy(true);
    try {
      if (kind === "model") await api.renameModel(project.id, item.id, nextName);
      else await api.renameAsset(project.id, item.id, nextName);
      await onRefreshModels();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setModelLibraryBusy(false);
    }
  }

  async function deleteLibraryAsset(asset: ProjectAssetRecord) {
    const kindName = asset.kind === "video" ? tr(locale, "视频", "video") : tr(locale, "图片", "image");
    if (!project || !window.confirm(tr(locale, `确定删除${kindName}“${asset.name}”吗？`, `Delete ${kindName} “${asset.name}”?`))) return;
    setModelLibraryBusy(true);
    try {
      await api.deleteAsset(project.id, asset.id);
      await onRefreshModels();
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setModelLibraryBusy(false);
    }
  }

  const normalizedSearch = assetSearch.trim().toLocaleLowerCase();
  const visibleModels = (project?.models ?? []).filter((model) => (assetTab === "all" || assetTab === "model") && (!normalizedSearch || model.name.toLocaleLowerCase().includes(normalizedSearch)));
  const visibleImages = (project?.assets ?? []).filter((asset) => asset.kind === "image" && (assetTab === "all" || assetTab === "image") && (!normalizedSearch || asset.name.toLocaleLowerCase().includes(normalizedSearch)));
  const visibleVideos = (project?.assets ?? []).filter((asset) => asset.kind === "video" && (assetTab === "all" || assetTab === "video") && (!normalizedSearch || asset.name.toLocaleLowerCase().includes(normalizedSearch)));

  return (
    <main className="scene-manager-page">
      <header className="manager-header">
        <div className="manager-brand">
          <span><img src={branding.logoUrl} alt={branding.systemName} /></span>
          <div><strong>{branding.systemName}</strong><small>{tr(locale, "场景管理中心", "Scene management")}</small></div>
        </div>
        <div className="manager-actions">
          <select value={project?.id ?? ""} onChange={(event) => onProjectChange(event.target.value)} aria-label={tr(locale, "项目", "Project")}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button className="button" onClick={onCreateProject}><Plus size={16} />{tr(locale, "新建项目", "New project")}</button>
          <button className="manager-icon-button" title={tr(locale, "重命名项目", "Rename project")} disabled={!project} onClick={onRenameProject}><Pencil size={15} /></button>
          <button className="manager-icon-button danger" title={tr(locale, "删除项目", "Delete project")} disabled={!project} onClick={onDeleteProject}><Trash2 size={15} /></button>
          <button className="button" disabled={!project} onClick={() => setModelLibraryOpen(true)}><Layers3 size={16} />{tr(locale, "资源库", "Assets")}</button>
          <button className="button" disabled={!project} onClick={onDataCenter}><Database size={16} />{tr(locale, "数据中心", "Data center")}</button>
          <button className="button" disabled={!project} onClick={onVisionCenter}><ScanSearch size={16} />{tr(locale, "视觉中心", "Vision")}</button>
          <button className="button" onClick={onOptimizer}><Gauge size={16} />{tr(locale, "模型优化", "Optimize")}</button>
          <button className="button" onClick={onImport}><FileUp size={16} />{tr(locale, "导入场景", "Import scene")}</button>
          <button className="button primary" onClick={openCreateDialog}><Plus size={17} />{tr(locale, "新建场景", "New scene")}</button>
        </div>
      </header>

      <section className="manager-content">
        <div className="manager-hero">
          <div><span className="eyebrow">SCENE LIBRARY</span><h1>{tr(locale, "场景", "Scenes")}</h1><p>{tr(locale, "一个场景可以组合多个 BIM、CAD 与通用三维模型，并独立保存视图和图层状态。", "A scene can combine multiple BIM, CAD and general 3D models while preserving view and layer state.")}</p></div>
          <div className="manager-stats">
            <div><strong>{scenes.length}</strong><span>{tr(locale, "场景", "Scenes")}</span></div>
          </div>
        </div>

        {scenes.length > 0 ? (
          <div className="scene-card-grid">
            {sortedScenes.map((scene) => (
              <article className="scene-card" key={scene.id}>
                <button className="scene-card-preview" onClick={() => void onOpen(scene)}>
                  {scene.publishedAt && <span className="scene-published-badge"><Rocket size={11} />{tr(locale, "已发布", "Published")}</span>}
                  <span className="scene-card-orbit" />
                  <Layers3 size={34} />
                  <small>{scene.models.length + scene.primitives.length + scene.measurements.length + (scene.annotations?.length ?? 0)} {tr(locale, "个对象", "objects")}</small>
                </button>
                <div className="scene-card-body">
                  <button className="scene-card-title" onClick={() => void onOpen(scene)}>{scene.name}</button>
                  <div className="scene-card-meta"><CalendarDays size={12} />{tr(locale, "更新于", "Updated")} {new Date(scene.updatedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}</div>
                  {scene.publishedAt && <div className="scene-card-publish-time"><Rocket size={11} />{tr(locale, "发布于", "Published")} {new Date(scene.publishedAt).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}</div>}
                  <div className="scene-card-footer">
                    <span>{scene.measurements.length} {tr(locale, "条测量", "measurements")} · {scene.annotations?.length ?? 0} {tr(locale, "个标签", "annotations")}</span>
                    <div>
                      <button title={tr(locale, "复制场景", "Copy scene")} onClick={() => void onCopy(scene)}><Copy size={14} /></button>
                      <button title={tr(locale, "重命名场景", "Rename scene")} onClick={() => openRenameDialog(scene)}><Pencil size={14} /></button>
                      <button title={tr(locale, "浏览当前保存版", "View saved version")} onClick={() => onBrowse(scene)}><Eye size={14} /></button>
                      <button title={scene.publishedAt ? tr(locale, "重新发布当前版本", "Republish current version") : tr(locale, "发布场景", "Publish scene")} onClick={() => void onPublish(scene)}><Rocket size={14} /></button>
                      {scene.publishedAt && <button title={tr(locale, "浏览已发布版本", "View published version")} onClick={() => onBrowsePublished(scene)}><ExternalLink size={14} /></button>}
                      {scene.publishedAt && <button title={tr(locale, "撤回发布", "Unpublish")} className="danger" onClick={() => void onUnpublish(scene)}><Undo2 size={14} /></button>}
                      <SceneExportMenu locale={locale} compact onExportLoose={() => onExportLoose(scene)} onExportSingle={() => void onExportSingle(scene)} onExportGlb={() => void onExportGlb(scene)} onExportFbx={() => void onExportFbx(scene)} />
                      <button title={tr(locale, "删除场景", "Delete scene")} className="danger" onClick={() => void onDelete(scene)}><Trash2 size={15} /></button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="manager-empty">
            <Box size={42} />
            <h2>{tr(locale, "还没有场景", "No scenes yet")}</h2>
            <p>{tr(locale, "新建场景后，可以加载多个模型、调整图层并保存当前视图。", "Create a scene to load models, adjust layers and save the current view.")}</p>
            <button className="button primary" onClick={openCreateDialog}><Plus size={17} />{tr(locale, "新建第一个场景", "Create first scene")}</button>
          </div>
        )}
      </section>

      <div className="app-copyright">{branding.copyright}</div>

      {modelLibraryOpen && (
        <div className="dialog-backdrop" onMouseDown={() => setModelLibraryOpen(false)}>
          <section className="model-library-dialog asset-library-dialog" aria-label={tr(locale, "项目资源库", "Project assets")} onMouseDown={(event) => event.stopPropagation()}>
            <header className="model-library-head">
              <div>
                <span className="eyebrow">PROJECT ASSETS</span>
                <h2>{tr(locale, "项目资源库", "Project assets")}</h2>
                <p>{tr(locale, "模型、图片和视频上传一次，即可被多个场景直接引用。", "Upload models, images and videos once, then reuse them across scenes.")}</p>
              </div>
              <button className="manager-icon-button" title={tr(locale, "关闭", "Close")} onClick={() => setModelLibraryOpen(false)}><X size={16} /></button>
            </header>
            <div className="model-library-toolbar">
              <button className="button primary" disabled={modelLibraryBusy} onClick={() => modelUploadRef.current?.click()}><FileUp size={16} />{tr(locale, "上传模型", "Upload models")}</button>
              <button className="button" disabled={modelLibraryBusy} onClick={() => imageUploadRef.current?.click()}><FileImage size={16} />{tr(locale, "上传图片", "Upload images")}</button>
              <button className="button" disabled={modelLibraryBusy} onClick={() => videoUploadRef.current?.click()}><FileVideo size={16} />{tr(locale, "上传视频", "Upload videos")}</button>
              <button className="button" disabled={modelLibraryBusy} onClick={() => void refreshLibraryModels()}><RefreshCw className={modelLibraryBusy ? "spin" : ""} size={15} />{tr(locale, "刷新状态", "Refresh")}</button>
              <input ref={modelUploadRef} hidden multiple type="file" accept={ACCEPTED_MODELS} onChange={(event) => void uploadLibraryModels(event.target.files)} />
              <input ref={imageUploadRef} hidden multiple type="file" accept={ACCEPTED_IMAGES} onChange={(event) => void uploadLibraryImages(event.target.files)} />
              <input ref={videoUploadRef} hidden multiple type="file" accept={ACCEPTED_VIDEOS} onChange={(event) => void uploadLibraryVideos(event.target.files)} />
            </div>
            <div className="asset-library-filter"><div>{(["all", "model", "image", "video"] as const).map((tab) => <button key={tab} className={assetTab === tab ? "active" : ""} onClick={() => setAssetTab(tab)}>{tab === "all" ? tr(locale, "全部", "All") : tab === "model" ? tr(locale, `模型 ${project?.models.length ?? 0}`, `Models ${project?.models.length ?? 0}`) : tab === "image" ? tr(locale, `图片 ${(project?.assets ?? []).filter((asset) => asset.kind === "image").length}`, `Images ${(project?.assets ?? []).filter((asset) => asset.kind === "image").length}`) : tr(locale, `视频 ${(project?.assets ?? []).filter((asset) => asset.kind === "video").length}`, `Videos ${(project?.assets ?? []).filter((asset) => asset.kind === "video").length}`)}</button>)}</div><label><Search size={14} /><input value={assetSearch} onChange={(event) => setAssetSearch(event.target.value)} placeholder={tr(locale, "搜索资源", "Search assets")} /></label></div>
            <div className="model-library-list">
              {visibleModels.map((model) => (
                <article className="model-library-item" key={model.id}>
                  <div className="model-library-format">{model.format.toUpperCase()}</div>
                  <div className="model-library-info">
                    <strong title={model.name}>{model.name}</strong>
                    <span>{formatBytes(model.size)} · {new Date(model.updatedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</span>
                    {model.status !== "ready" && <small title={model.message}>{model.message}</small>}
                  </div>
                  <div className="model-library-state">
                    <span className={`model-status model-status-${model.status}`}>{statusLabel(model.status, locale)}</span>
                    {model.status === "processing" && <progress max={100} value={model.progress} aria-label={`${tr(locale, "转换进度", "Conversion progress")} ${model.progress}%`} />}
                  </div>
                  <button className="manager-icon-button" title={tr(locale, "重命名", "Rename")} disabled={modelLibraryBusy} onClick={() => void renameLibraryItem(model, "model")}><Pencil size={14} /></button>
                  <button className="manager-icon-button danger" title={tr(locale, "删除模型", "Delete model")} disabled={modelLibraryBusy} onClick={() => void deleteLibraryModel(model)}><Trash2 size={15} /></button>
                </article>
              ))}
              {visibleImages.map((asset) => <article className="model-library-item asset-image-item" key={asset.id}><div className="asset-image-preview"><img src={asset.url} alt="" loading="lazy" /></div><div className="model-library-info"><strong title={asset.name}>{asset.name}</strong><span>{formatBytes(asset.size)} · {new Date(asset.updatedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</span><small>{tr(locale, "可用于二维看板图片组件", "Ready for dashboard image widgets")}</small></div><div className="model-library-state"><span className="model-status model-status-ready">{tr(locale, "可使用", "Ready")}</span></div><button className="manager-icon-button" title={tr(locale, "重命名", "Rename")} disabled={modelLibraryBusy} onClick={() => void renameLibraryItem(asset, "asset")}><Pencil size={14} /></button><button className="manager-icon-button danger" title={tr(locale, "删除图片", "Delete image")} disabled={modelLibraryBusy} onClick={() => void deleteLibraryAsset(asset)}><Trash2 size={15} /></button></article>)}
              {visibleVideos.map((asset) => <article className="model-library-item asset-video-item" key={asset.id}><div className="asset-video-preview"><Video size={21} /><span>{asset.fileName.split(".").at(-1)?.toUpperCase()}</span></div><div className="model-library-info"><strong title={asset.name}>{asset.name}</strong><span>{formatBytes(asset.size)} · {new Date(asset.updatedAt).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })}</span><small>{tr(locale, "可用于二维看板本地视频组件", "Ready for local dashboard video widgets")}</small></div><div className="model-library-state"><span className="model-status model-status-ready">{tr(locale, "可使用", "Ready")}</span></div><button className="manager-icon-button" title={tr(locale, "重命名", "Rename")} disabled={modelLibraryBusy} onClick={() => void renameLibraryItem(asset, "asset")}><Pencil size={14} /></button><button className="manager-icon-button danger" title={tr(locale, "删除视频", "Delete video")} disabled={modelLibraryBusy} onClick={() => void deleteLibraryAsset(asset)}><Trash2 size={15} /></button></article>)}
              {visibleModels.length === 0 && visibleImages.length === 0 && visibleVideos.length === 0 && <div className="model-library-empty">{assetTab === "image" ? <ImageIcon size={34} /> : assetTab === "video" ? <Video size={34} /> : <Box size={34} />}<strong>{normalizedSearch ? tr(locale, "没有匹配的资源", "No matching assets") : tr(locale, "还没有资源", "No assets yet")}</strong><span>{tr(locale, "上传模型、图片或视频后，可在场景编辑器中直接引用。", "Upload a model, image or video to reuse it in Studio.")}</span></div>}
            </div>
          </section>
        </div>
      )}

      {dialogMode && (
        <div className="dialog-backdrop" onMouseDown={() => setDialogMode(undefined)}>
          <form className="dialog" onSubmit={(event) => { event.preventDefault(); void submitSceneDialog(); }} onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">{dialogMode === "rename" ? "RENAME SCENE" : "NEW SCENE"}</span>
            <h2>{dialogMode === "rename" ? tr(locale, "重命名场景", "Rename scene") : tr(locale, "新建场景", "New scene")}</h2>
            <p>{dialogMode === "rename" ? tr(locale, "修改场景在管理中心和编辑器中显示的名称。", "Change the scene name shown in management and the editor.") : tr(locale, "新场景从空画布开始，之后可以连续加载多个模型。", "A new scene starts empty and can load multiple models.")}</p>
            <label><span>{tr(locale, "场景名称", "Scene name")}</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={tr(locale, "例如：1 号楼施工总览", "For example: Building 1 overview")} /></label>
            <div className="dialog-actions"><button type="button" className="button" onClick={() => setDialogMode(undefined)}>{tr(locale, "取消", "Cancel")}</button><button className="button primary" disabled={!name.trim() || busy}>{dialogMode === "rename" ? tr(locale, "保存名称", "Save name") : tr(locale, "创建并进入", "Create and open")}</button></div>
          </form>
        </div>
      )}
    </main>
  );
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function statusLabel(status: ConversionStatus, locale: AppLocale): string {
  const zh = ({ queued: "排队中", processing: "转换中", ready: "可使用", waiting_converter: "等待转换器", failed: "失败" })[status];
  const en = ({ queued: "Queued", processing: "Converting", ready: "Ready", waiting_converter: "Waiting for converter", failed: "Failed" })[status];
  return tr(locale, zh, en);
}
