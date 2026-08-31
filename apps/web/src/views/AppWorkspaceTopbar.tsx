import { ArrowLeft, Bot, LayoutDashboard, Plus, Redo2, Rocket, Save, Undo2 } from "lucide-react";
import { SceneWorkspaceMoreMenu } from "../components/SceneWorkspaceMoreMenu";
import { WorkspaceModeSwitch } from "../components/WorkspaceModeSwitch";
import { translate as tr } from "../i18n";
import type { AppViewBindings } from "./appViewBindings";

/** 三维编辑/浏览的全局导航与发布操作；与场景画布和检查器职责分离。 */
export function AppWorkspaceTopbar({ bindings }: { bindings: AppViewBindings }) {
  const { state, scenePersistence, applicationRuntime, actions, sceneHistory } = bindings;
  const {
    branding,
    route,
    activeApplication,
    project,
    projects,
    locale,
    sceneName,
    setSceneName,
    activeScene,
    busy,
    rendererDiagnosticsOpen,
    setRendererDiagnosticsOpen,
    rendererSwitching,
    rendererBackend,
    aiAssistantOpen,
    setAiAssistantOpen,
    importRef,
    setSceneBehaviorOpen,
    setStudioPublishMode,
    setStudioPublishPerformance,
    setStudioPublishOpen,
    autoSaveEnabled,
    rendererDiagnostics,
  } = state;
  const { commitSceneName, exportSceneConfig, exportSingleFileScene, exportGlbScene, exportFbxScene, browseActiveScene, saveScene } = scenePersistence;
  const { returnFromSceneEditor, publishActiveApplication, changeAutoSave } = applicationRuntime;
  const { switchProjectById, openProjectDialog, changeRendererBackend, navigate } = actions;

  return (
    <header className="topbar">
      <div className="brand-mark">
        {/* 顶部窄位使用方形应用标识，完整字标由右侧 brand-copy 承载。 */}
        <img src={branding.iconUrl} alt={branding.systemName} />
      </div>
      <div className="brand-copy">
        <strong>{branding.systemName}</strong>
        <span>{route.view === "studio" ? tr(locale, "三维场景编辑", "3D scene editor") : tr(locale, "场景浏览", "Scene viewer")}</span>
      </div>
      <div className="topbar-divider" />
      {route.view === "studio" ? (
        <>
          {route.applicationId && activeApplication ? (
            <div className="workspace-breadcrumb">
              <LayoutDashboard size={15} />
              <strong>{activeApplication.metadata.name}</strong>
              <span>/</span>
              <em>{tr(locale, "三维场景", "3D scene")}</em>
            </div>
          ) : (
            <>
              <select
                className="project-select"
                value={project?.id ?? ""}
                onChange={(event) => switchProjectById(event.target.value)}
                aria-label={tr(locale, "当前项目", "Current project")}
              >
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button className="project-add-button" title={tr(locale, "新建项目", "New project")} onClick={() => openProjectDialog("create")}>
                <Plus size={15} />
              </button>
            </>
          )}
          <WorkspaceModeSwitch
            locale={locale}
            active="3d"
            contextLabel={`${tr(locale, "三维场景", "3D scene")} · ${sceneName}`}
            onSelect2D={() => void commitSceneName().then((committed) => committed && returnFromSceneEditor())}
            onSelectScripts={() => setSceneBehaviorOpen(true)}
          />
          <div className="scene-title-wrap">
            <span>{tr(locale, "场景", "Scene")}</span>
            <input
              value={sceneName}
              onChange={(event) => setSceneName(event.target.value)}
              onBlur={() => void commitSceneName()}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setSceneName(activeScene?.name ?? "未命名场景");
                  event.currentTarget.blur();
                }
              }}
              aria-label={tr(locale, "场景名称", "Scene name")}
            />
          </div>
          <div className="scene-history-controls" aria-label={tr(locale, "三维编辑历史", "3D edit history")}>
            <button
              disabled={!sceneHistory.canUndo || busy}
              title={sceneHistory.undoLabel ? `${tr(locale, "撤销", "Undo")}：${sceneHistory.undoLabel} · Ctrl+Z` : tr(locale, "暂无可撤销操作", "Nothing to undo")}
              onClick={() => void sceneHistory.undo()}
            >
              <Undo2 size={15} />
            </button>
            <button
              disabled={!sceneHistory.canRedo || busy}
              title={sceneHistory.redoLabel ? `${tr(locale, "重做", "Redo")}：${sceneHistory.redoLabel} · Ctrl+Y` : tr(locale, "暂无可重做操作", "Nothing to redo")}
              onClick={() => void sceneHistory.redo()}
            >
              <Redo2 size={15} />
            </button>
          </div>
          <div className="topbar-actions">
            <button
              className={`button ghost compact-action ${aiAssistantOpen ? "active" : ""}`}
              title={tr(locale, "AI 场景助手", "AI scene assistant")}
              onClick={() => setAiAssistantOpen((value) => !value)}
            >
              <Bot size={15} />
              <span className="action-label">{tr(locale, "AI 助手", "AI Assistant")}</span>
            </button>
            <button
              className="button ghost"
              title={route.dashboardReturn ? tr(locale, "返回二维设计", "Back to 2D design") : tr(locale, "场景管理", "Scenes")}
              onClick={() => void commitSceneName().then((committed) => committed && returnFromSceneEditor())}
            >
              <ArrowLeft size={15} />
              <span className="action-label">{route.dashboardReturn ? tr(locale, "返回二维", "Back to 2D") : tr(locale, "场景管理", "Scenes")}</span>
            </button>
            <SceneWorkspaceMoreMenu
              locale={locale}
              rendererBackend={rendererBackend}
              rendererSwitching={rendererSwitching}
              rendererDiagnosticsOpen={rendererDiagnosticsOpen}
              setRendererDiagnosticsOpen={(open) => setRendererDiagnosticsOpen(open)}
              rendererDiagnostics={rendererDiagnostics}
              changeRendererBackend={(backend) => {
                if (!busy) void changeRendererBackend(backend);
              }}
              onImport={() => importRef.current?.click()}
              onExportLoose={() => exportSceneConfig()}
              onExportSingle={() => void exportSingleFileScene()}
              onExportGlb={() => void exportGlbScene()}
              onExportFbx={() => void exportFbxScene()}
              onBrowse={() => void browseActiveScene()}
              browseDisabled={Boolean(activeApplication) || busy}
            />
            {activeApplication ? (
              <button
                className="button ghost"
                title={tr(locale, "保存并发布整个应用", "Save and publish the whole app")}
                onClick={() => void saveScene().then((saved) => saved && publishActiveApplication())}
                disabled={busy}
              >
                <Rocket size={15} />
                <span className="action-label">{tr(locale, "发布应用", "Publish app")}</span>
              </button>
            ) : (
              <button
                className="button ghost"
                title={activeScene?.publishedAt ? tr(locale, "重新发布场景", "Republish scene") : tr(locale, "发布场景", "Publish scene")}
                onClick={() => {
                  setStudioPublishMode(activeScene?.publicationMode ?? "webgl");
                  setStudioPublishPerformance(activeScene?.publicationPerformance ?? "standard");
                  setStudioPublishOpen(true);
                }}
                disabled={busy}
              >
                <Rocket size={15} />
                <span className="action-label">{activeScene?.publishedAt ? tr(locale, "重新发布", "Republish") : tr(locale, "发布", "Publish")}</span>
              </button>
            )}
            <label className="topbar-auto-save" title={tr(locale, "修改后自动保存整个项目", "Automatically save project changes")}>
              <input type="checkbox" checked={autoSaveEnabled} onChange={(event) => changeAutoSave(event.target.checked)} />
              {tr(locale, "自动保存", "Auto save")}
            </label>
            <button className="button primary" title={tr(locale, "保存项目", "Save project")} onClick={() => void saveScene()} disabled={busy}>
              <Save size={15} />
              <span className="action-label">{tr(locale, "保存项目", "Save project")}</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="viewer-scene-title">
            <span className="viewer-mode-badge">
              <Rocket size={13} />
              {route.view === "published" ? tr(locale, "已发布版本", "Published version") : tr(locale, "当前保存版本", "Saved version")}
            </span>
            <strong>{sceneName}</strong>
          </div>
          <div className="topbar-actions">
            <button className="button ghost" onClick={() => navigate({ view: "manager" })}>
              <ArrowLeft size={16} />
              {tr(locale, "返回场景管理", "Back to scenes")}
            </button>
          </div>
        </>
      )}
    </header>
  );
}
