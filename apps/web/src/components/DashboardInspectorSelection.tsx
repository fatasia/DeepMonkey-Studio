import { Box, Layers3, Minus } from "lucide-react";
import { translate as tr } from "../i18n";
import { InteractionFlowInspector } from "./InteractionFlowInspector";
import { DashboardInspectorAnimation } from "./DashboardInspectorAnimation";
import { DashboardInspectorBulkData } from "./DashboardInspectorBulkData";
import { DashboardSampleGroupEditor } from "./DashboardSampleGroupEditor";
import { DashboardInspectorContent } from "./DashboardInspectorContent";
import { DashboardInspectorData } from "./DashboardInspectorData";
import { DashboardInspectorStyle } from "./DashboardInspectorStyle";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import { dashboardNodeLabel as nodeLabel, dataWidgetTypeLabel, type InspectorTab } from "./dashboardWorkspaceModel";

const INSPECTOR_TABS: ReadonlyArray<[InspectorTab, string, string]> = [
  ["content", "内容", "Content"],
  ["data", "数据", "Data"],
  ["style", "样式", "Style"],
  ["animation", "动画", "Animation"],
  ["interaction", "交互", "Interaction"],
];

/** 只负责编排各类属性页；具体业务编辑逻辑由对应子面板维护。 */
export function DashboardInspectorSelection() {
  const { application, deleteSelectedNodes, inspectorTab, locale, onCommand, onNodeInteraction, page, selectedNode, selectedNodeIds, setInspectorTab, toggleLayerLock } = useDashboardWorkspace();

  if (!selectedNode) {
    return (
      <div className="dashboard-no-selection">
        <Layers3 size={24} />
        <span>{tr(locale, "选择页面中的组件以编辑属性", "Select a component on the page to edit its properties")}</span>
      </div>
    );
  }

  const isSceneViewport = selectedNode.kind === "scene-viewport";
  const hasUnlockedSelection = page.nodes.some((node) => selectedNodeIds.includes(node.id) && node.locked !== true);

  return (
    <>
      <div className="dashboard-selection-heading dashboard-selection-summary">
        <span>{isSceneViewport ? <Box size={15} /> : <Layers3 size={15} />}</span>
        <div>
          <strong>{nodeLabel(selectedNode)}</strong>
          <small title={selectedNode.id}>
            {isSceneViewport ? tr(locale, "三维视口", "3D viewport") : dataWidgetTypeLabel(locale, selectedNode.widget.type)} · {selectedNode.id.slice(-8)}
          </small>
        </div>
      </div>

      <nav className="dashboard-inspector-tabs" aria-label={tr(locale, "属性分类", "Property categories")}>
        {INSPECTOR_TABS.map(([tab, zhLabel, enLabel]) => (
          <button key={tab} className={inspectorTab === tab ? "active" : ""} onClick={() => setInspectorTab(tab)}>
            {tr(locale, zhLabel, enLabel)}
          </button>
        ))}
      </nav>

      {selectedNode.locked && <div className="dashboard-inspector-lock-notice">
        <span>{tr(locale, "图层已锁定 · 只读", "Layer locked · Read only")}</span>
        <button type="button" onClick={() => toggleLayerLock(selectedNode)}>{tr(locale, "解锁图层", "Unlock layer")}</button>
      </div>}
      <fieldset className="dashboard-inspector-fields" disabled={selectedNode.locked === true} aria-label={tr(locale, "组件属性", "Component properties")}>
      <DashboardInspectorContent />
      <DashboardInspectorBulkData />
      <DashboardSampleGroupEditor />
      <DashboardInspectorData />
      <DashboardInspectorStyle />
      {inspectorTab === "data" && selectedNodeIds.length === 1 && selectedNode.kind === "data-widget" && ["text", "shape", "decoration"].includes(selectedNode.widget.type) && (
        <div className="dashboard-inspector-empty">{tr(locale, "静态组件不需要数据绑定。", "Static components do not require data binding.")}</div>
      )}
      <DashboardInspectorAnimation />
      {(inspectorTab === "data" || inspectorTab === "style" || inspectorTab === "animation") && isSceneViewport && (
        <div className="dashboard-inspector-empty">{tr(locale, "三维组件的该类属性请进入三维编辑器配置。", "Configure this property category in the 3D editor.")}</div>
      )}
      {inspectorTab === "interaction" && (
        <InteractionFlowInspector
          locale={locale}
          application={application}
          source={{ kind: "widget", id: selectedNode.id }}
          onCommand={onCommand}
          onTest={(trigger) => onNodeInteraction(selectedNode.id, trigger)}
        />
      )}
      </fieldset>
      <section className="dashboard-inspector-section">
        <button className="dashboard-delete-node" disabled={!hasUnlockedSelection} onClick={deleteSelectedNodes}>
          <Minus size={13} />
          {selectedNodeIds.length > 1
            ? tr(locale, "删除未锁定的所选组件", "Delete unlocked selection")
            : selectedNode.locked
              ? tr(locale, "图层已锁定", "Layer locked")
              : tr(locale, "删除组件", "Delete component")}
        </button>
      </section>
    </>
  );
}
