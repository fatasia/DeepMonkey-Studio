import { useMemo, useRef, useState } from "react";
import { Box, CalendarDays, Copy, Eye, ExternalLink, FileUp, Gauge, Layers3, Pencil, Plus, RefreshCw, Rocket, Trash2, Undo2, X } from "lucide-react";
import type { ConversionStatus, ModelRecord, ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { SceneExportMenu } from "./SceneExportMenu";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

const ACCEPTED_MODELS = ".rvt,.ifc,.step,.stp,.dwg,.dxf,.gltf,.glb,.fbx";

interface SceneManagerProps {
  locale: AppLocale;
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
  onDelete: (scene: SceneSnapshot) => Promise<void>;
  onOptimizer: () => void;
  onUploadModels: (files: FileList) => Promise<void>;
  onDeleteModel: (model: ModelRecord) => Promise<void>;
  onRefreshModels: () => Promise<void>;
}

export function SceneManager({
  locale,
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
  onDelete,
  onOptimizer,
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
  const modelUploadRef = useRef<HTMLInputElement>(null);

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

  return (
    <main className="scene-manager-page">
      <header className="manager-header">
        <div className="manager-brand">
          <span><img src={`${import.meta.env.BASE_URL}brand/logo-transparent.png`} alt="BIM Studio" /></span>
          <div><strong>BIM Studio</strong><small>{tr(locale, "场景管理中心", "Scene management")}</small></div>
        </div>
        <div className="manager-actions">
          <select value={project?.id ?? ""} onChange={(event) => onProjectChange(event.target.value)} aria-label={tr(locale, "项目", "Project")}>
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button className="button" onClick={onCreateProject}><Plus size={16} />{tr(locale, "新建项目", "New project")}</button>
          <button className="manager-icon-button" title={tr(locale, "重命名项目", "Rename project")} disabled={!project} onClick={onRenameProject}><Pencil size={15} /></button>
          <button className="manager-icon-button danger" title={tr(locale, "删除项目", "Delete project")} disabled={!project} onClick={onDeleteProject}><Trash2 size={15} /></button>
          <button className="button" disabled={!project} onClick={() => setModelLibraryOpen(true)}><Layers3 size={16} />{tr(locale, "模型资源库", "Model library")}</button>
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
                      <SceneExportMenu locale={locale} compact onExportLoose={() => onExportLoose(scene)} onExportSingle={() => void onExportSingle(scene)} onExportGlb={() => void onExportGlb(scene)} />
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

      <div className="app-copyright">Copyright © 张文鹏 Charlie</div>

      {modelLibraryOpen && (
        <div className="dialog-backdrop" onMouseDown={() => setModelLibraryOpen(false)}>
          <section className="model-library-dialog" aria-label={tr(locale, "模型资源库", "Model library")} onMouseDown={(event) => event.stopPropagation()}>
            <header className="model-library-head">
              <div>
                <span className="eyebrow">MODEL LIBRARY</span>
                <h2>{tr(locale, "模型资源库", "Model library")}</h2>
                <p>{project?.name ?? tr(locale, "当前项目", "Current project")} {tr(locale, "中的源模型与转换状态。", "source models and conversion status.")}</p>
              </div>
              <button className="manager-icon-button" title={tr(locale, "关闭", "Close")} onClick={() => setModelLibraryOpen(false)}><X size={16} /></button>
            </header>
            <div className="model-library-toolbar">
              <button className="button primary" disabled={modelLibraryBusy} onClick={() => modelUploadRef.current?.click()}><FileUp size={16} />{tr(locale, "上传模型", "Upload models")}</button>
              <button className="button" disabled={modelLibraryBusy} onClick={() => void refreshLibraryModels()}><RefreshCw className={modelLibraryBusy ? "spin" : ""} size={15} />{tr(locale, "刷新状态", "Refresh")}</button>
              <span>{tr(locale, "支持", "Supports")} RVT、IFC、STEP、DWG、DXF、GLTF、GLB、FBX</span>
              <input ref={modelUploadRef} hidden multiple type="file" accept={ACCEPTED_MODELS} onChange={(event) => void uploadLibraryModels(event.target.files)} />
            </div>
            <div className="model-library-list">
              {project?.models.length ? project.models.map((model) => (
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
                  <button className="manager-icon-button danger" title={tr(locale, "删除模型", "Delete model")} disabled={modelLibraryBusy} onClick={() => void deleteLibraryModel(model)}><Trash2 size={15} /></button>
                </article>
              )) : (
                <div className="model-library-empty"><Box size={34} /><strong>{tr(locale, "还没有模型", "No models yet")}</strong><span>{tr(locale, "上传模型后，可在场景编辑器中加载使用。", "Upload models to load them in the scene editor.")}</span></div>
              )}
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
