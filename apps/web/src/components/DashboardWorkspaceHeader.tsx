import { ArrowLeft, Database, Eye, LayoutDashboard, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, Redo2, Rocket, Save, Undo2 } from "lucide-react";
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
    leftPanelOpen,
    locale,
    onAutoSaveChange,
    onBack,
    onOpen3D,
    onOpenData,
    onOpenScripts,
    scriptOpen,
    onCloseScripts,
    onPublish,
    onRedo,
    onSave,
    onUndo,
    page,
    selectedNodeIds,
    setRuntimePreview,
    setLeftPanelOpen,
    inspectorOpen,
    setInspectorOpen,
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
        active={scriptOpen ? "script" : "2d"}
        contextLabel={`${tr(locale, "二维页面", "2D page")} · ${page.name}`}
        sceneAvailable={Boolean(linkedSceneId)}
        {...(onCloseScripts ? { onSelect2D: onCloseScripts } : {})}
        onSelect3D={() => {
          if (linkedSceneId) onOpen3D?.(linkedSceneId, currentView());
        }}
        {...(onOpenScripts
          ? {
              onSelectScripts: () =>
                onOpenScripts(selectedNodeIds.map((id) => ({ kind: "widget" as const, id }))),
            }
          : {})}
      />
      <button className="dashboard-data-entry" onClick={onOpenData}>
        <Database size={14} />
        {tr(locale, "数据", "Data")}
      </button>
      <div className="dashboard-panel-toggles" role="group" aria-label={tr(locale, "工作区面板", "Workspace panels")}>
        <button
          type="button"
          aria-pressed={leftPanelOpen}
          aria-label={leftPanelOpen ? tr(locale, "收起资源面板", "Collapse resources panel") : tr(locale, "展开资源面板", "Expand resources panel")}
          title={leftPanelOpen ? tr(locale, "收起资源面板", "Collapse resources panel") : tr(locale, "展开资源面板", "Expand resources panel")}
          onClick={() => setLeftPanelOpen((value) => !value)}
        >
          {leftPanelOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
        </button>
        <button
          type="button"
          aria-pressed={inspectorOpen}
          aria-label={inspectorOpen ? tr(locale, "收起属性面板", "Collapse inspector") : tr(locale, "展开属性面板", "Expand inspector")}
          title={inspectorOpen ? tr(locale, "收起属性面板", "Collapse inspector") : tr(locale, "展开属性面板", "Expand inspector")}
          onClick={() => setInspectorOpen((value) => !value)}
        >
          {inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
        </button>
      </div>
      <div className="dashboard-workspace-actions">
        {onAutoSaveChange && (
          <label className="dashboard-auto-save" title={tr(locale, "修改后自动保存项目", "Automatically save project changes")}>
            <input type="checkbox" checked={autoSaveEnabled} onChange={(event) => onAutoSaveChange(event.target.checked)} />
            {tr(locale, "自动保存", "Auto save")}
          </label>
        )}
        <button disabled={!canUndo || busy} aria-label={tr(locale, "撤销", "Undo")} title={tr(locale, "撤销", "Undo")} onClick={onUndo}>
          <Undo2 size={15} />
        </button>
        <button disabled={!canRedo || busy} aria-label={tr(locale, "重做", "Redo")} title={tr(locale, "重做", "Redo")} onClick={onRedo}>
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
