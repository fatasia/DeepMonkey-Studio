import { ArrowLeft, Database, Eye, LayoutDashboard, Redo2, Rocket, Save, Undo2 } from "lucide-react";
import { translate as tr } from "../i18n";
import { WorkspaceModeSwitch } from "./WorkspaceModeSwitch";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardWorkspaceHeader() {
  const {
    application,
    autoSaveEnabled,
    busy,
    canRedo,
    canUndo,
    currentView,
    dirty,
    linkedSceneId,
    locale,
    onAutoSaveChange,
    onBack,
    onOpen3D,
    onOpenData,
    onOpenScripts,
    onPublish,
    onRedo,
    onSave,
    onUndo,
    page,
    setRuntimePreview,
  } = useDashboardWorkspace();
  return (
    <header className="dashboard-workspace-topbar">
      <button className="dashboard-back" onClick={onBack}>
        <ArrowLeft size={16} />
        {tr(locale, "项目", "Project")}
      </button>
      <div className="dashboard-workspace-title">
        <LayoutDashboard size={17} />
        <div>
          <strong>{application.metadata.name}</strong>
          <span>{dirty ? tr(locale, "有未保存修改", "Unsaved changes") : tr(locale, "所有修改已保存", "All changes saved")}</span>
        </div>
      </div>
      <WorkspaceModeSwitch
        locale={locale}
        active="2d"
        contextLabel={`${tr(locale, "二维页面", "2D page")} · ${page.name}`}
        sceneAvailable={Boolean(linkedSceneId)}
        onSelect3D={() => {
          if (linkedSceneId) onOpen3D?.(linkedSceneId, currentView());
        }}
        {...(onOpenScripts ? { onSelectScripts: onOpenScripts } : {})}
      />
      <button className="dashboard-data-entry" onClick={onOpenData}>
        <Database size={14} />
        {tr(locale, "数据", "Data")}
      </button>
      <div className="dashboard-workspace-actions">
        {onAutoSaveChange && (
          <label className="dashboard-auto-save" title={tr(locale, "修改后自动保存项目", "Automatically save project changes")}>
            <input type="checkbox" checked={autoSaveEnabled} onChange={(event) => onAutoSaveChange(event.target.checked)} />
            {tr(locale, "自动保存", "Auto save")}
          </label>
        )}
        <button disabled={!canUndo || busy} title={tr(locale, "撤销", "Undo")} onClick={onUndo}>
          <Undo2 size={15} />
        </button>
        <button disabled={!canRedo || busy} title={tr(locale, "重做", "Redo")} onClick={onRedo}>
          <Redo2 size={15} />
        </button>
        <button disabled={!dirty || busy} onClick={onSave}>
          <Save size={15} />
          {tr(locale, "保存", "Save")}
        </button>
        <button onClick={() => setRuntimePreview(true)}>
          <Eye size={15} />
          {tr(locale, "浏览", "Browse")}
        </button>
        <button className="primary" disabled={busy} onClick={onPublish}>
          <Rocket size={15} />
          {tr(locale, "发布", "Publish")}
        </button>
      </div>
    </header>
  );
}
