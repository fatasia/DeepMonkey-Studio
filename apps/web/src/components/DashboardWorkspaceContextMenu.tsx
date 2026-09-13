import { Box, Copy, Eye, EyeOff, Group, Layers3, Lock, Plus, Trash2, Ungroup } from "lucide-react";
import { translate as tr } from "../i18n";
import { dashboardNodeLabel as nodeLabel, dataWidgetTypeLabel } from "./dashboardWorkspaceModel";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardWorkspaceContextMenu() {
  const {
    contextMenu,
    contextNodeIds,
    copyContextNodes,
    currentView,
    deleteContextNodes,
    groupSelectedNodes,
    locale,
    onEnterScene,
    page,
    reorderNodeIds,
    setContextMenu,
    ungroupSelectedNodes,
    updateContextNodes,
  } = useDashboardWorkspace();
  return (
    contextMenu &&
    (() => {
      const target = page.nodes.find((node) => node.id === contextMenu.nodeId);
      if (!target) return null;
      const ids = contextNodeIds();
      const targets = page.nodes.filter((node) => ids.includes(node.id));
      const allHidden = targets.every((node) => node.visible === false);
      const grouped = targets.some((node) => node.groupId);
      return (
        <div className="dashboard-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <header>
            <span>{nodeLabel(target)}</span>
            <small>
              {targets.length > 1
                ? tr(locale, `${targets.length} 个组件`, `${targets.length} components`)
                : target.kind === "scene-viewport"
                  ? "3D"
                  : dataWidgetTypeLabel(locale, target.widget.type)}
            </small>
          </header>
          <button onClick={() => copyContextNodes()}>
            <Copy size={13} />
            {tr(locale, "复制", "Copy")}
            <kbd>Ctrl C</kbd>
          </button>
          <button onClick={() => copyContextNodes(true)}>
            <Plus size={13} />
            {tr(locale, "创建副本", "Duplicate")}
            <kbd>Ctrl D</kbd>
          </button>
          <div />
          <button
            onClick={() => {
              reorderNodeIds(ids, "front");
              setContextMenu(undefined);
            }}
          >
            <Layers3 size={13} />
            {tr(locale, "置于顶层", "Bring to front")}
            <kbd>⇧ ]</kbd>
          </button>
          <button
            onClick={() => {
              reorderNodeIds(ids, "forward");
              setContextMenu(undefined);
            }}
          >
            <Layers3 size={13} />
            {tr(locale, "上移一层", "Move forward")}
            <kbd>]</kbd>
          </button>
          <button
            onClick={() => {
              reorderNodeIds(ids, "backward");
              setContextMenu(undefined);
            }}
          >
            <Layers3 size={13} />
            {tr(locale, "下移一层", "Move backward")}
            <kbd>[</kbd>
          </button>
          <button
            onClick={() => {
              reorderNodeIds(ids, "back");
              setContextMenu(undefined);
            }}
          >
            <Layers3 size={13} />
            {tr(locale, "置于底层", "Send to back")}
            <kbd>⇧ [</kbd>
          </button>
          <div />
          <button onClick={() => updateContextNodes({ visible: allHidden }, allHidden ? "显示二维组件" : "隐藏二维组件")}>
            {allHidden ? <Eye size={13} /> : <EyeOff size={13} />}
            {allHidden ? tr(locale, "显示", "Show") : tr(locale, "隐藏", "Hide")}
          </button>
          <button onClick={() => updateContextNodes({ locked: true, selectable: false }, "锁定二维组件")}>
            <Lock size={13} />
            {tr(locale, "锁定并取消选取", "Lock and deselect")}
          </button>
          {targets.length > 1 && <button onClick={() => { groupSelectedNodes(ids); setContextMenu(undefined); }}><Group size={13} />{tr(locale, "编组", "Group")}<kbd>Ctrl G</kbd></button>}
          {grouped && (
            <button
              onClick={() => {
                ungroupSelectedNodes(ids);
                setContextMenu(undefined);
              }}
            >
              <Ungroup size={13} />
              {tr(locale, "取消编组", "Ungroup")}
            </button>
          )}
          {target.kind === "scene-viewport" && (
            <button
              onClick={() => {
                setContextMenu(undefined);
                onEnterScene(target.sceneId, currentView());
              }}
            >
              <Box size={13} />
              {tr(locale, "进入三维编辑", "Open 3D editor")}
            </button>
          )}
          <div />
          <button className="danger" onClick={deleteContextNodes}>
            <Trash2 size={13} />
            {tr(locale, "删除", "Delete")}
            <kbd>Del</kbd>
          </button>
        </div>
      );
    })()
  );
}
