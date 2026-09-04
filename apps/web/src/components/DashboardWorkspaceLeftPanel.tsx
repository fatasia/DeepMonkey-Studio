import { Box, Copy, Eye, EyeOff, Group, Layers3, LayoutDashboard, Lock, Pencil, Plus, Trash2, Unlock } from "lucide-react";
import { createUpdateDashboardNodeStateCommand } from "@bim-studio/studio-core";
import { translate as tr } from "../i18n";
import { DashboardComponentLibrary } from "./DashboardComponentLibrary";
import { DashboardPageViewportEditor } from "./DashboardPageViewportEditor";
import { dashboardNodeLabel as nodeLabel } from "./dashboardWorkspaceModel";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

function DashboardLayerList() {
  const {
    dashboardGroups, deleteLayerNode, draggedLayerId, layerDropTargetId, locale, onCommand, onSelectionChange,
    page,
    reorderLayerByDrop, selectNode, selectedNodeIds, setDraggedLayerId, setLayerDropTargetId,
    setSelectedNodeIds, renameDashboardGroup, toggleLayerLock, updateDashboardGroup,
  } = useDashboardWorkspace();
  const groupedNodeIds = new Set(dashboardGroups.flatMap((group) => group.nodes.map((node) => node.id)));
  const renderLayer = (node: (typeof page.nodes)[number], nested = false) => <div draggable={!node.locked} className={`dashboard-layer-row ${nested ? "nested" : ""} ${selectedNodeIds.includes(node.id) ? "active" : ""} ${node.visible === false ? "hidden" : ""} ${node.locked ? "locked" : ""} ${draggedLayerId === node.id ? "dragging" : ""} ${layerDropTargetId === node.id ? "drop-target" : ""}`} key={node.id}
    role="treeitem" aria-level={nested ? 2 : 1} aria-selected={selectedNodeIds.includes(node.id)}
    onDragStart={(event) => { setDraggedLayerId(node.id); event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", node.id); }}
    onDragOver={(event) => { if (!draggedLayerId || draggedLayerId === node.id) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setLayerDropTargetId(node.id); }}
    onDrop={(event) => { event.preventDefault(); const sourceId = draggedLayerId ?? event.dataTransfer.getData("text/plain"); if (sourceId) reorderLayerByDrop(sourceId, node.id); setDraggedLayerId(undefined); setLayerDropTargetId(undefined); }}
    onDragEnd={() => { setDraggedLayerId(undefined); setLayerDropTargetId(undefined); }}>
    <button className="dashboard-layer-select" disabled={node.locked} title={node.locked ? tr(locale, "图层已锁定，解锁后可选取", "Layer is locked; unlock it to select") : nodeLabel(node)} onClick={(event) => selectNode(node, event.ctrlKey || event.metaKey || event.shiftKey, true)}>
      {node.kind === "scene-viewport" ? <Box size={14} /> : <Layers3 size={14} />}<span>{nodeLabel(node)}</span>
    </button>
    <button className="dashboard-layer-action" aria-label={node.visible === false ? tr(locale, "显示图层", "Show layer") : tr(locale, "隐藏图层", "Hide layer")} title={node.visible === false ? tr(locale, "显示图层", "Show layer") : tr(locale, "隐藏图层", "Hide layer")} onClick={() => onCommand(createUpdateDashboardNodeStateCommand(page.id, node.id, { visible: node.visible === false }))}>{node.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}</button>
    <button className={`dashboard-layer-action ${node.locked ? "active" : ""}`} aria-label={node.locked ? tr(locale, "解锁图层", "Unlock layer") : tr(locale, "锁定图层", "Lock layer")} title={node.locked ? tr(locale, "解锁图层", "Unlock layer") : tr(locale, "锁定图层（同时禁止选取）", "Lock layer and prevent selection")} onClick={() => toggleLayerLock(node)}>{node.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
    <button className="dashboard-layer-action danger" disabled={node.locked} aria-label={tr(locale, "删除组件", "Delete component")} title={node.locked ? tr(locale, "请先解锁再删除", "Unlock before deleting") : tr(locale, "删除组件", "Delete component")} onClick={() => deleteLayerNode(node)}><Trash2 size={13} /></button>
  </div>;
  return (
    <section className="dashboard-layer-section">
      <div className="dashboard-panel-label dashboard-layer-heading"><span>{tr(locale, "图层", "Layers")}</span><small>{page.nodes.length}</small></div>
      <div className="dashboard-layer-tree" role="tree" aria-label={tr(locale, "二维图层树", "2D layer tree")}>
        {dashboardGroups.map((group) => {
          const allHidden = group.nodes.every((node) => node.visible === false);
          const allLocked = group.nodes.every((node) => node.locked === true);
          return <section className="dashboard-layer-group" role="treeitem" aria-level={1} aria-expanded="true" key={group.id}><div className="dashboard-group-row">
            <button className="dashboard-group-select" title={tr(locale, "选择并统一控制组内组件", "Select and control all group components")} onClick={() => { const ids = group.nodes.filter((node) => node.locked !== true).map((node) => node.id); setSelectedNodeIds(ids); onSelectionChange(ids.map((id) => ({ kind: "widget", id }))); }}>
              <Group size={13} /><span>{group.label}</span><small>{group.nodes.length}</small>
            </button>
            <button className="dashboard-layer-action" aria-label={tr(locale, "重命名编组", "Rename group")} title={tr(locale, "重命名编组", "Rename group")} onClick={() => renameDashboardGroup(group)}><Pencil size={12} /></button>
            <button className="dashboard-layer-action" aria-label={allHidden ? tr(locale, "显示编组", "Show group") : tr(locale, "隐藏编组", "Hide group")} title={allHidden ? tr(locale, "显示编组", "Show group") : tr(locale, "隐藏编组", "Hide group")} onClick={() => updateDashboardGroup(group, { visible: allHidden })}>{allHidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
            <button className={`dashboard-layer-action ${allLocked ? "active" : ""}`} aria-label={allLocked ? tr(locale, "解锁编组", "Unlock group") : tr(locale, "锁定编组", "Lock group")} title={allLocked ? tr(locale, "解锁编组", "Unlock group") : tr(locale, "锁定编组", "Lock group")} onClick={() => updateDashboardGroup(group, { locked: !allLocked })}>{allLocked ? <Lock size={13} /> : <Unlock size={13} />}</button>
          </div><div className="dashboard-layer-children" role="group">{[...group.nodes].sort((left, right) => right.zIndex - left.zIndex).map((node) => renderLayer(node, true))}</div></section>;
        })}
        {[...page.nodes].filter((node) => !groupedNodeIds.has(node.id)).sort((left, right) => right.zIndex - left.zIndex).map((node) => renderLayer(node))}
      </div>
    </section>
  );
}

export function DashboardWorkspaceLeftPanel() {
  const {
    addDashboardPage,
    addDataWidget,
    addSceneViewport,
    application,
    commitPageViewport,
    componentSearchRef,
    currentView,
    deleteDashboardPage,
    duplicateDashboardPage,
    leftPanelTab,
    locale,
    onSelectPage,
    page,
    setLeftPanelTab,
    setTemplateLibraryOpen,
  } = useDashboardWorkspace();
  return (
    <aside className="dashboard-pages-panel">
      <header>
        <span className="eyebrow">{tr(locale, "设计资源", "DESIGN RESOURCES")}</span>
        <strong>{tr(locale, "二维工作区", "2D workspace")}</strong>
      </header>
      <nav className="dashboard-left-tabs" aria-label={tr(locale, "二维工作区", "2D workspace")}>
        <button className={leftPanelTab === "pages" ? "active" : ""} onClick={() => setLeftPanelTab("pages")}>
          <LayoutDashboard size={13} />
          {tr(locale, "页面与图层", "Pages & layers")}
        </button>
        <button className={leftPanelTab === "components" ? "active" : ""} onClick={() => setLeftPanelTab("components")}>
          <Box size={13} />
          {tr(locale, "资源", "Resources")}
        </button>
      </nav>
      {leftPanelTab === "pages" && (
        <section>
          <div className="dashboard-panel-label">
            <span>
              {tr(locale, "页面", "Pages")}
              <small>{application.pages.length}</small>
            </span>
            <span className="dashboard-page-actions">
              <button title={tr(locale, "复制当前页面", "Duplicate current page")} onClick={duplicateDashboardPage}>
                <Copy size={12} />
              </button>
              <button title={tr(locale, "新增空白页面", "Add blank page")} onClick={addDashboardPage}>
                <Plus size={12} />
              </button>
            </span>
          </div>
          {application.pages.map((candidate) => (
            <div className={`dashboard-page-row ${candidate.id === page.id ? "active" : ""}`} key={candidate.id}>
              <button className="dashboard-page-select" onClick={() => onSelectPage(candidate.id, currentView())}>
                <LayoutDashboard size={14} />
                <span>{candidate.name}</span>
                <small>{candidate.nodes.length}</small>
              </button>
              <button
                className="dashboard-page-delete"
                disabled={application.pages.length <= 1}
                title={tr(locale, "删除页面", "Delete page")}
                onClick={() => deleteDashboardPage(candidate.id)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <details className="dashboard-compact-page-settings">
            <summary>
              {tr(locale, "画布尺寸与适配", "Canvas size & fit")}
              <small>
                {page.width} × {page.height}
              </small>
            </summary>
            <DashboardPageViewportEditor locale={locale} page={page} onChange={commitPageViewport} compact />
          </details>
          <DashboardLayerList />
        </section>
      )}
      {leftPanelTab === "components" && (
        <section className="dashboard-component-library">
          <DashboardComponentLibrary
            locale={locale}
            projectId={application.metadata.projectId}
            sceneAvailable={application.scenes.length > 0}
            searchInputRef={componentSearchRef}
            onOpenTemplates={() => setTemplateLibraryOpen(true)}
            onAddSceneViewport={addSceneViewport}
            onAddWidget={(type, widget, frame, nameHint) => addDataWidget(type, widget, frame, undefined, nameHint)}
          />
        </section>
      )}
    </aside>
  );
}
