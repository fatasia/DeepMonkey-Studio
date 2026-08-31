import { Box, CircleCheck, Copy, Eye, EyeOff, Group, Layers3, LayoutDashboard, Lock, Pencil, Plus, Trash2, TriangleAlert, Unlock } from "lucide-react";
import { createUpdateDashboardNodeStateCommand } from "@bim-studio/studio-core";
import { translate as tr } from "../i18n";
import { DashboardComponentLibrary } from "./DashboardComponentLibrary";
import { DashboardPageViewportEditor } from "./DashboardPageViewportEditor";
import { dashboardNodeLabel as nodeLabel } from "./dashboardWorkspaceModel";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardWorkspaceLeftPanel() {
  const {
    addDashboardPage,
    addDataWidget,
    addSceneViewport,
    application,
    commitPageViewport,
    componentSearchRef,
    connected,
    currentView,
    dashboardDiagnostics,
    dashboardGroups,
    deleteDashboardPage,
    deleteLayerNode,
    draggedLayerId,
    duplicateDashboardPage,
    layerDropTargetId,
    leftPanelTab,
    locale,
    onCommand,
    onSelectPage,
    onSelectionChange,
    page,
    renameDashboardGroup,
    reorderLayerByDrop,
    selectNode,
    selectedNodeIds,
    setDraggedLayerId,
    setInspectorTab,
    setLayerDropTargetId,
    setLeftPanelTab,
    setSelectedNodeIds,
    setTemplateLibraryOpen,
    toggleLayerLock,
    updateDashboardGroup,
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
          {tr(locale, "页面", "Pages")}
        </button>
        <button className={leftPanelTab === "components" ? "active" : ""} onClick={() => setLeftPanelTab("components")}>
          <Box size={13} />
          {tr(locale, "组件", "Components")}
        </button>
        <button className={leftPanelTab === "layers" ? "active" : ""} onClick={() => setLeftPanelTab("layers")}>
          <Layers3 size={13} />
          {tr(locale, "图层", "Layers")}
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
        </section>
      )}
      {leftPanelTab === "components" && (
        <section className="dashboard-component-library">
          <div className="dashboard-linkage-section">
            <details
              className={`dashboard-linkage-diagnostics ${dashboardDiagnostics.some((item) => item.severity === "error") ? "error" : dashboardDiagnostics.length > 0 ? "warning" : "healthy"}`}
              open={dashboardDiagnostics.some((item) => item.severity === "error") || undefined}
            >
              <summary>
                {dashboardDiagnostics.length > 0 ? <TriangleAlert size={13} /> : <CircleCheck size={13} />}
                <span>{tr(locale, "联动诊断", "Linkage diagnostics")}</span>
                <small>{dashboardDiagnostics.length || tr(locale, "正常", "Healthy")}</small>
              </summary>
              {dashboardDiagnostics.length > 0 ? (
                <div>
                  {dashboardDiagnostics.map((diagnostic, index) => (
                    <button
                      className={diagnostic.severity}
                      key={`${diagnostic.nodeId}:${diagnostic.code}:${index}`}
                      onClick={() => {
                        const target = page.nodes.find((node) => node.id === diagnostic.nodeId);
                        if (target) {
                          selectNode(target, false, true);
                          window.requestAnimationFrame(() =>
                            setInspectorTab(
                              diagnostic.code.includes("filter") || diagnostic.code.includes("linkage") || diagnostic.code.includes("drill") ? "data" : "interaction",
                            ),
                          );
                        }
                      }}
                    >
                      <i />
                      <span>{locale === "zh-CN" ? diagnostic.zh : diagnostic.en}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <p>{tr(locale, "参数、级联、点击联动与钻取配置未发现冲突。", "No conflicts found in parameters, cascades, click linkage, or drill configuration.")}</p>
              )}
            </details>
          </div>
          <DashboardComponentLibrary
            locale={locale}
            connected={connected}
            sceneAvailable={application.scenes.length > 0}
            searchInputRef={componentSearchRef}
            onOpenTemplates={() => setTemplateLibraryOpen(true)}
            onAddSceneViewport={addSceneViewport}
            onAddWidget={addDataWidget}
          />
        </section>
      )}
      {leftPanelTab === "layers" && (
        <section>
          <div className="dashboard-panel-label">
            <span>{tr(locale, "图层", "Layers")}</span>
            <small>{page.nodes.length}</small>
          </div>
          {dashboardGroups.length > 0 && (
            <div className="dashboard-group-list" aria-label={tr(locale, "二维编组", "2D groups")}>
              {dashboardGroups.map((group) => {
                const allHidden = group.nodes.every((node) => node.visible === false);
                const allLocked = group.nodes.every((node) => node.locked === true);
                return (
                  <div className="dashboard-group-row" key={group.id}>
                    <button
                      className="dashboard-group-select"
                      title={tr(locale, "选择并统一控制组内组件", "Select and control all group components")}
                      onClick={() => {
                        const ids = group.nodes.filter((node) => node.locked !== true).map((node) => node.id);
                        setSelectedNodeIds(ids);
                        onSelectionChange(ids.map((id) => ({ kind: "widget", id })));
                      }}
                    >
                      <Group size={13} />
                      <span>{group.label}</span>
                      <small>{group.nodes.length}</small>
                    </button>
                    <button className="dashboard-layer-action" title={tr(locale, "重命名编组", "Rename group")} onClick={() => renameDashboardGroup(group)}>
                      <Pencil size={12} />
                    </button>
                    <button
                      className="dashboard-layer-action"
                      title={allHidden ? tr(locale, "显示编组", "Show group") : tr(locale, "隐藏编组", "Hide group")}
                      onClick={() => updateDashboardGroup(group, { visible: allHidden })}
                    >
                      {allHidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <button
                      className={`dashboard-layer-action ${allLocked ? "active" : ""}`}
                      title={allLocked ? tr(locale, "解锁编组", "Unlock group") : tr(locale, "锁定编组", "Lock group")}
                      onClick={() => updateDashboardGroup(group, { locked: !allLocked })}
                    >
                      {allLocked ? <Lock size={13} /> : <Unlock size={13} />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {[...page.nodes]
            .sort((left, right) => right.zIndex - left.zIndex)
            .map((node) => (
              <div
                draggable={!node.locked}
                className={`dashboard-layer-row ${selectedNodeIds.includes(node.id) ? "active" : ""} ${node.visible === false ? "hidden" : ""} ${node.locked ? "locked" : ""} ${draggedLayerId === node.id ? "dragging" : ""} ${layerDropTargetId === node.id ? "drop-target" : ""}`}
                key={node.id}
                onDragStart={(event) => {
                  setDraggedLayerId(node.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", node.id);
                }}
                onDragOver={(event) => {
                  if (!draggedLayerId || draggedLayerId === node.id) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setLayerDropTargetId(node.id);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceId = draggedLayerId ?? event.dataTransfer.getData("text/plain");
                  if (sourceId) reorderLayerByDrop(sourceId, node.id);
                  setDraggedLayerId(undefined);
                  setLayerDropTargetId(undefined);
                }}
                onDragEnd={() => {
                  setDraggedLayerId(undefined);
                  setLayerDropTargetId(undefined);
                }}
              >
                <button
                  className="dashboard-layer-select"
                  style={{ paddingLeft: node.groupId ? 22 : undefined }}
                  disabled={node.locked}
                  title={node.locked ? tr(locale, "图层已锁定，解锁后可选取", "Layer is locked; unlock it to select") : nodeLabel(node)}
                  onClick={(event) => selectNode(node, event.ctrlKey || event.metaKey, true)}
                >
                  {node.kind === "scene-viewport" ? <Box size={14} /> : <Layers3 size={14} />}
                  <span>{nodeLabel(node)}</span>
                </button>
                <button
                  className="dashboard-layer-action"
                  title={node.visible === false ? tr(locale, "显示图层", "Show layer") : tr(locale, "隐藏图层", "Hide layer")}
                  onClick={() => onCommand(createUpdateDashboardNodeStateCommand(page.id, node.id, { visible: node.visible === false }))}
                >
                  {node.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
                <button
                  className={`dashboard-layer-action ${node.locked ? "active" : ""}`}
                  title={node.locked ? tr(locale, "解锁图层", "Unlock layer") : tr(locale, "锁定图层（同时禁止选取）", "Lock layer and prevent selection")}
                  onClick={() => toggleLayerLock(node)}
                >
                  {node.locked ? <Lock size={13} /> : <Unlock size={13} />}
                </button>
                <button
                  className="dashboard-layer-action danger"
                  disabled={node.locked}
                  title={node.locked ? tr(locale, "请先解锁再删除", "Unlock before deleting") : tr(locale, "删除组件", "Delete component")}
                  onClick={() => deleteLayerNode(node)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
        </section>
      )}
    </aside>
  );
}
