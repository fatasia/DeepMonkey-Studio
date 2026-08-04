import { useMemo, useState } from "react";
import { Box, CalendarDays, Copy, Eye, ExternalLink, FileUp, Gauge, Layers3, Pencil, Plus, Rocket, Trash2, Undo2 } from "lucide-react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { SceneExportMenu } from "./SceneExportMenu";

interface SceneManagerProps {
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
}

export function SceneManager({
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
  onOptimizer
}: SceneManagerProps) {
  const [dialogMode, setDialogMode] = useState<"create" | "rename">();
  const [targetScene, setTargetScene] = useState<SceneSnapshot>();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

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

  return (
    <main className="scene-manager-page">
      <header className="manager-header">
        <div className="manager-brand">
          <span><img src={`${import.meta.env.BASE_URL}brand/logo-transparent.png`} alt="BIM Studio" /></span>
          <div><strong>BIM Studio</strong><small>场景管理中心</small></div>
        </div>
        <div className="manager-actions">
          <select value={project?.id ?? ""} onChange={(event) => onProjectChange(event.target.value)} aria-label="项目">
            {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <button className="button" onClick={onCreateProject}><Plus size={16} />新建项目</button>
          <button className="manager-icon-button" title="重命名项目" disabled={!project} onClick={onRenameProject}><Pencil size={15} /></button>
          <button className="manager-icon-button danger" title="删除项目" disabled={!project} onClick={onDeleteProject}><Trash2 size={15} /></button>
          <button className="button" onClick={onOptimizer}><Gauge size={16} />模型优化</button>
          <button className="button" onClick={onImport}><FileUp size={16} />导入场景</button>
          <button className="button primary" onClick={openCreateDialog}><Plus size={17} />新建场景</button>
        </div>
      </header>

      <section className="manager-content">
        <div className="manager-hero">
          <div><span className="eyebrow">SCENE LIBRARY</span><h1>场景</h1><p>一个场景可以组合多个 BIM、CAD 与通用三维模型，并独立保存视图和图层状态。</p></div>
          <div className="manager-stats">
            <div><strong>{scenes.length}</strong><span>场景</span></div>
            <div><strong>{project?.models.length ?? 0}</strong><span>模型资产</span></div>
          </div>
        </div>

        {scenes.length > 0 ? (
          <div className="scene-card-grid">
            {sortedScenes.map((scene) => (
              <article className="scene-card" key={scene.id}>
                <button className="scene-card-preview" onClick={() => void onOpen(scene)}>
                  {scene.publishedAt && <span className="scene-published-badge"><Rocket size={11} />已发布</span>}
                  <span className="scene-card-orbit" />
                  <Layers3 size={34} />
                  <small>{scene.models.length + scene.primitives.length + scene.measurements.length + (scene.annotations?.length ?? 0)} 个对象</small>
                </button>
                <div className="scene-card-body">
                  <button className="scene-card-title" onClick={() => void onOpen(scene)}>{scene.name}</button>
                  <div className="scene-card-meta"><CalendarDays size={12} />更新于 {new Date(scene.updatedAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}</div>
                  {scene.publishedAt && <div className="scene-card-publish-time"><Rocket size={11} />发布于 {new Date(scene.publishedAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" })}</div>}
                  <div className="scene-card-footer">
                    <span>{scene.measurements.length} 条测量 · {scene.annotations?.length ?? 0} 个标签</span>
                    <div>
                      <button title="复制场景" onClick={() => void onCopy(scene)}><Copy size={14} /></button>
                      <button title="重命名场景" onClick={() => openRenameDialog(scene)}><Pencil size={14} /></button>
                      <button title="浏览当前保存版" onClick={() => onBrowse(scene)}><Eye size={14} /></button>
                      <button title={scene.publishedAt ? "重新发布当前版本" : "发布场景"} onClick={() => void onPublish(scene)}><Rocket size={14} /></button>
                      {scene.publishedAt && <button title="浏览已发布版本" onClick={() => onBrowsePublished(scene)}><ExternalLink size={14} /></button>}
                      {scene.publishedAt && <button title="撤回发布" className="danger" onClick={() => void onUnpublish(scene)}><Undo2 size={14} /></button>}
                      <SceneExportMenu compact onExportLoose={() => onExportLoose(scene)} onExportSingle={() => void onExportSingle(scene)} onExportGlb={() => void onExportGlb(scene)} />
                      <button title="删除场景" className="danger" onClick={() => void onDelete(scene)}><Trash2 size={15} /></button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="manager-empty">
            <Box size={42} />
            <h2>还没有场景</h2>
            <p>新建场景后，可以加载多个模型、调整图层并保存当前视图。</p>
            <button className="button primary" onClick={openCreateDialog}><Plus size={17} />新建第一个场景</button>
          </div>
        )}
      </section>

      <div className="app-copyright">Copyright © 张文鹏 Charlie</div>

      {dialogMode && (
        <div className="dialog-backdrop" onMouseDown={() => setDialogMode(undefined)}>
          <form className="dialog" onSubmit={(event) => { event.preventDefault(); void submitSceneDialog(); }} onMouseDown={(event) => event.stopPropagation()}>
            <span className="eyebrow">{dialogMode === "rename" ? "RENAME SCENE" : "NEW SCENE"}</span>
            <h2>{dialogMode === "rename" ? "重命名场景" : "新建场景"}</h2>
            <p>{dialogMode === "rename" ? "修改场景在管理中心和编辑器中显示的名称。" : "新场景从空画布开始，之后可以连续加载多个模型。"}</p>
            <label><span>场景名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：1 号楼施工总览" /></label>
            <div className="dialog-actions"><button type="button" className="button" onClick={() => setDialogMode(undefined)}>取消</button><button className="button primary" disabled={!name.trim() || busy}>{dialogMode === "rename" ? "保存名称" : "创建并进入"}</button></div>
          </form>
        </div>
      )}
    </main>
  );
}
