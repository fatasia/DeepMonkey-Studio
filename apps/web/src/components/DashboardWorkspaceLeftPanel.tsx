import { Box, ChevronDown, ChevronRight, Eye, EyeOff, Group, Layers3, Lock, Pencil, Trash2, Unlock } from "lucide-react";
import { useRef, useState } from "react";
import { selectLayerIds } from "./layerSelection";
import { handleLayerTreeKeyDown } from "./layerKeyboard";
import { useLayerRenameFocus } from "./useLayerRenameFocus";
import { useDashboardLayerDrag } from "./useDashboardLayerDrag";
import { createUpdateDashboardNodeStateCommand } from "@bim-studio/studio-core";
import { dashboardLayerNodes, dashboardRootLayerOrder } from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import { DashboardComponentLibrary } from "./DashboardComponentLibrary";
import { dashboardNodeLabel as nodeLabel } from "./dashboardWorkspaceModel";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import "./SceneLayerInteractions.css";
import "../styles/workspacePanelAnchors.css";
import "./dashboardLayerDrop.css";

export function DashboardLayerList() {
  const {
    dashboardGroups, deleteLayerNode, locale, onCommand, onSelectionChange, onNodeInteraction,
    openNodeContextMenu,
    page,
    reorderLayerByDrop, selectedNodeIds,
    setSelectedNodeIds, renameDashboardGroup, toggleLayerLock, updateDashboardGroup,
    setInspectorOpen, setInspectorTab,
  } = useDashboardWorkspace();
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const drag = useDashboardLayerDrag({ page, selectedNodeIds, reorderLayerByDrop });
  const { draggedLayerId } = drag;
  const focusRename = useLayerRenameFocus("dashboard");
  const reason = drag.reason ?? drag.feedback?.reason;
  const dropMessage = reason === "locked-order-gap" ? tr(locale, "锁定图层之间没有排序空间，请先解锁。", "Unlock the surrounding layers to reorder here.")
      : reason === "locked-group" ? tr(locale, "目标图层或编组包含锁定项，请先解锁。", "Unlock the target layer or group first.")
      : reason === "locked-source" ? tr(locale, "所选图层包含锁定项，请先解锁再整体移动。", "The selection contains locked layers. Unlock them before moving the selection.")
      : reason === "missing-node" ? tr(locale, "图层已变化，请重新拖动。", "Layers changed. Start dragging again.")
      : reason === "group-edge" ? tr(locale, "编组只能放在根图层前后，不能嵌套入组。", "Groups can be reordered at the root, but cannot be nested.")
      : reason === "self-target" ? tr(locale, "目标在本次选择中，请拖到选择范围之外。", "The target is selected. Drop outside the current selection.")
      : reason === "unchanged" ? tr(locale, "图层位置没有变化。", "Layer order is unchanged.") : "";
  const anchor = useRef<string | undefined>(undefined);
  const sorted = (nodes: typeof page.nodes) => [...nodes].sort((a, b) => b.zIndex - a.zIndex);
  const visibleIds = dashboardLayerNodes(page.nodes, page.rootLayerOrder, collapsed).map(node => node.id);
  const renderLayer = (node: (typeof page.nodes)[number], nested = false) => <div data-layer-keyboard-row draggable={!node.locked} className={`dashboard-layer-row ${nested ? "nested" : ""} ${selectedNodeIds.includes(node.id) ? "active" : ""} ${node.visible === false ? "hidden" : ""} ${node.locked ? "locked" : ""} ${draggedLayerId === node.id ? "dragging" : ""}`} key={node.id}
    role="treeitem" data-node-id={node.id} aria-level={nested ? 2 : 1} aria-selected={selectedNodeIds.includes(node.id)}
    data-layer-drop={drag.indicator(node.id)}
    onDragStart={event => drag.start(event, node.id)}
    onDragOver={event => drag.over(event, node.id)}
    onDrop={event => drag.drop(event, node.id)}
    onDragEnd={drag.cancel}
    onContextMenu={(event) => openNodeContextMenu(event, node)}>
    <button className="dashboard-layer-select" title={nodeLabel(node)} onClick={(event) => {
      if (event.detail > 1) return;
      const available = new Set(page.nodes.map(item => item.id));
      const ids = selectLayerIds(visibleIds, selectedNodeIds.filter(id => available.has(id)), node.id, { additive: event.ctrlKey || event.metaKey, range: event.shiftKey }, anchor.current);
      if (!event.shiftKey) anchor.current = node.id;
      setSelectedNodeIds(ids); onSelectionChange(ids.map(id => ({ kind: "widget", id })));
      onNodeInteraction(node.id);
    }}>
      {node.kind === "scene-viewport" ? <Box size={14} /> : <Layers3 size={14} />}<span>{nodeLabel(node)}</span>
    </button>
    <button className="dashboard-layer-action" aria-label={node.visible === false ? tr(locale, "显示图层", "Show layer") : tr(locale, "隐藏图层", "Hide layer")} title={node.visible === false ? tr(locale, "显示图层", "Show layer") : tr(locale, "隐藏图层", "Hide layer")} onClick={() => onCommand(createUpdateDashboardNodeStateCommand(page.id, node.id, { visible: node.visible === false }))}>{node.visible === false ? <EyeOff size={13} /> : <Eye size={13} />}</button>
    <button className={`dashboard-layer-action ${node.locked ? "active" : ""}`} aria-label={node.locked ? tr(locale, "解锁图层", "Unlock layer") : tr(locale, "锁定图层", "Lock layer")} title={node.locked ? tr(locale, "解锁图层", "Unlock layer") : tr(locale, "锁定图层，仍可在目录查看属性", "Lock layer; properties remain available in the tree")} onClick={() => toggleLayerLock(node)}>{node.locked ? <Lock size={13} /> : <Unlock size={13} />}</button>
    <button data-layer-action="delete" className="dashboard-layer-action danger" disabled={node.locked} aria-label={tr(locale, "删除组件", "Delete component")} title={node.locked ? tr(locale, "请先解锁再删除", "Unlock before deleting") : tr(locale, "删除组件", "Delete component")} onClick={() => deleteLayerNode(node)}><Trash2 size={13} /></button>
  </div>;
  return (
    <section className="dashboard-layer-section">
      <div className="dashboard-panel-label dashboard-layer-heading"><span>{tr(locale, "图层", "Layers")}</span><small>{page.nodes.length}</small></div>
      <div className="dashboard-layer-tree" role="tree" onKeyDown={event => handleLayerTreeKeyDown(event, true, { rename: row => {
        const node = page.nodes.find(item => item.id === row.dataset.nodeId);
        if (!node) return "unsupported";
        if (node.locked) return "blocked";
        focusRename(node.id, () => {
          setSelectedNodeIds([node.id]); onSelectionChange([{ kind: "widget", id: node.id }]);
          setInspectorOpen(true); setInspectorTab("content");
        });
        return "handled";
      } })} aria-label={tr(locale, "二维图层树", "2D layer tree")}>
        {dashboardRootLayerOrder(page.nodes, page.rootLayerOrder).map(ref => {
          if (ref.kind === "node") return renderLayer(page.nodes.find(node => node.id === ref.id)!);
          const group = dashboardGroups.find(candidate => candidate.id === ref.id);
          if (!group) return null;
          const allHidden = group.nodes.every((node) => node.visible === false);
          const allLocked = group.nodes.every((node) => node.locked === true);
          return <section data-layer-keyboard-group className="dashboard-layer-group" role="treeitem" aria-level={1} aria-expanded={!collapsed.has(group.id)} key={`group:${group.id}`}><div data-layer-keyboard-row data-layer-drop={drag.indicator(group.id, "group")} className="dashboard-group-row"
            draggable={!group.nodes.some(node => node.locked)} onDragStart={event => drag.start(event, group.id, "group")} onDragEnd={drag.cancel}
            onContextMenu={event => { if (group.nodes[0]) openNodeContextMenu(event, group.nodes[0]); }}
            onDragOver={event => drag.over(event, group.id, "group")}
            onDrop={event => drag.drop(event, group.id, "group")}>
            <button data-layer-expander className="dashboard-layer-action" aria-label={collapsed.has(group.id) ? tr(locale, `展开编组“${group.label}”`, `Expand group “${group.label}”`) : tr(locale, `收起编组“${group.label}”`, `Collapse group “${group.label}”`)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })}>{collapsed.has(group.id) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
            <button data-layer-primary className="dashboard-group-select" title={tr(locale, "选择并统一控制组内组件", "Select and control all group components")} onClick={() => { const ids = group.nodes.map((node) => node.id); anchor.current = ids.at(-1); setSelectedNodeIds(ids); onSelectionChange(ids.map((id) => ({ kind: "widget", id }))); }}>
              <Group size={13} /><span title={group.label}>{group.label}</span><small>{group.nodes.length}</small>
            </button>
            <button data-layer-action="rename" className="dashboard-layer-action" aria-label={tr(locale, "重命名编组", "Rename group")} title={tr(locale, "重命名编组", "Rename group")} onClick={() => renameDashboardGroup(group)}><Pencil size={12} /></button>
            <button className="dashboard-layer-action" aria-label={allHidden ? tr(locale, "显示编组", "Show group") : tr(locale, "隐藏编组", "Hide group")} title={allHidden ? tr(locale, "显示编组", "Show group") : tr(locale, "隐藏编组", "Hide group")} onClick={() => updateDashboardGroup(group, { visible: allHidden })}>{allHidden ? <EyeOff size={13} /> : <Eye size={13} />}</button>
            <button className={`dashboard-layer-action ${allLocked ? "active" : ""}`} aria-label={allLocked ? tr(locale, "解锁编组", "Unlock group") : tr(locale, "锁定编组", "Lock group")} title={allLocked ? tr(locale, "解锁编组", "Unlock group") : tr(locale, "锁定编组", "Lock group")} onClick={() => updateDashboardGroup(group, { locked: !allLocked })}>{allLocked ? <Lock size={13} /> : <Unlock size={13} />}</button>
          </div>{!collapsed.has(group.id) && <div className="dashboard-layer-children" role="group">{sorted(group.nodes).map((node) => renderLayer(node, true))}</div>}</section>;
        })}
        {dashboardGroups.length > 0 && <div className="scene-layer-root-drop" data-layer-drop={drag.indicator()} onDragOver={event => drag.over(event)} onDrop={event => drag.drop(event)}>{tr(locale, "拖到此处移出编组", "Drop here to move out of groups")}</div>}
      </div>
      {dropMessage && <p role="status" style={{ color: "var(--text-muted)", fontSize: 12, margin: "8px 12px" }}>{dropMessage}</p>}
    </section>
  );
}

export function DashboardWorkspaceLeftPanel() {
  const {
    addDataWidget,
    addSceneViewport,
    application,
    componentSearchRef,
    leftPanelTab,
    locale,
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
          <Layers3 size={13} />
          {tr(locale, "图层", "Layers")}
        </button>
        <button className={leftPanelTab === "components" ? "active" : ""} onClick={() => setLeftPanelTab("components")}>
          <Box size={13} />
          {tr(locale, "资源", "Resources")}
        </button>
      </nav>
      {leftPanelTab === "pages" && (
        <DashboardLayerList />
      )}
      {leftPanelTab === "components" && (
        <section className="dashboard-component-library">
          <DashboardComponentLibrary
            locale={locale}
            projectId={application.metadata.projectId}
            sceneAvailable={application.scenes.length > 0}
            topologies={application.topologies}
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
