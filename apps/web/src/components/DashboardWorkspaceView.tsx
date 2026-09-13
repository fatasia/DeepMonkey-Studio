import { DashboardPlayback } from "./DashboardPlayback";
import { DashboardDataBindingProvider } from "./DashboardDataBindingProvider";
import { DashboardDataPanel } from "./DashboardDataPanel";
import type { DashboardWorkspaceController } from "./DashboardWorkspace";
import { DashboardWorkspaceCanvas } from "./DashboardWorkspaceCanvas";
import { DashboardWorkspaceContextMenu } from "./DashboardWorkspaceContextMenu";
import { DashboardWorkspaceHeader } from "./DashboardWorkspaceHeader";
import { DashboardWorkspaceInspector } from "./DashboardWorkspaceInspector";
import { DashboardWorkspaceLeftPanel } from "./DashboardWorkspaceLeftPanel";
import { DashboardWorkspacePageBar } from "./DashboardWorkspacePageBar";
import { DashboardWorkspaceTemplateLibrary } from "./DashboardWorkspaceTemplateLibrary";
import { DashboardWorkspaceProvider } from "./dashboardWorkspaceContext";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { translate as tr } from "../i18n";
import { useEffect, useRef } from "react";

export function DashboardWorkspaceView({ controller }: { controller: DashboardWorkspaceController }) {
  const {
    application,
    connected,
    currentView,
    filters,
    leftPanelOpen,
    locale,
    onFilterChange,
    onNodeInteraction,
    onObjectInteraction,
    onPublish,
    onSelectPage,
    onSelectionChange,
    onVariableChange,
    page,
    project,
    rendererBackend,
    runtimeMetrics,
    runtimePreview,
    inspectorOpen,
    setInspectorOpen,
    setLeftPanelOpen,
    setRuntimePreview,
    variables,
  } = controller;

  const panelsBeforeScript = useRef<{ left: boolean; right: boolean } | undefined>(undefined);
  useEffect(() => {
    if (controller.scriptOpen) {
      if (panelsBeforeScript.current) return;
      panelsBeforeScript.current = { left: leftPanelOpen, right: inspectorOpen };
      setLeftPanelOpen(false);
      setInspectorOpen(false);
    } else if (panelsBeforeScript.current) {
      const previous = panelsBeforeScript.current;
      panelsBeforeScript.current = undefined;
      setLeftPanelOpen(previous.left);
      setInspectorOpen(previous.right);
    }
  }, [controller.scriptOpen, leftPanelOpen, inspectorOpen, setLeftPanelOpen, setInspectorOpen]);

  if (runtimePreview) {
    return (
      <DashboardPlayback
        key={application.metadata.id}
        locale={locale}
        application={application}
        project={project}
        page={page}
        rendererBackend={rendererBackend}
        metrics={runtimeMetrics}
        variables={variables}
        filters={filters}
        connected={connected}
        {...(controller.writebackAccess ? { writebackAccess: { ...controller.writebackAccess, datasets: controller.datasets, onSaved: controller.refreshDataset } } : {})}
        onFilterChange={onFilterChange}
        onVariableChange={onVariableChange}
        onSelectPage={(pageId) => onSelectPage(pageId, currentView())}
        onClose={() => setRuntimePreview(false)}
        onPublish={onPublish}
        onSelectionChange={onSelectionChange}
        onObjectInteraction={onObjectInteraction}
        onNodeInteraction={onNodeInteraction}
      />
    );
  }

  return (
    <DashboardWorkspaceProvider controller={controller}>
      <DashboardDataBindingProvider key={project.id}>
      <main className={`dashboard-workspace${leftPanelOpen ? "" : " left-panel-collapsed"}${inspectorOpen ? "" : " inspector-collapsed"}`}>
        <h1 className="sr-only">{page.name} · {locale === "zh-CN" ? "二维页面编辑" : "2D page editor"}</h1>
        <DashboardWorkspaceHeader />
        <div className="workspace-panel-controls dashboard-panel-controls" aria-label={tr(locale, "工作区面板", "Workspace panels")}>
          <button
            className="panel-toggle-left"
            type="button"
            aria-pressed={leftPanelOpen}
            aria-label={leftPanelOpen ? tr(locale, "收起左侧面板", "Collapse left panel") : tr(locale, "展开左侧面板", "Expand left panel")}
            title={leftPanelOpen ? tr(locale, "收起左侧面板", "Collapse left panel") : tr(locale, "展开左侧面板", "Expand left panel")}
            onClick={() => { if (controller.scriptOpen && !leftPanelOpen) setInspectorOpen(false); setLeftPanelOpen(!leftPanelOpen); }}
          >
            {leftPanelOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          </button>
          <button
            className="panel-toggle-right"
            type="button"
            aria-pressed={inspectorOpen}
            aria-label={inspectorOpen ? tr(locale, "收起右侧面板", "Collapse right panel") : tr(locale, "展开右侧面板", "Expand right panel")}
            title={inspectorOpen ? tr(locale, "收起右侧面板", "Collapse right panel") : tr(locale, "展开右侧面板", "Expand right panel")}
            onClick={() => { if (controller.scriptOpen && !inspectorOpen) setLeftPanelOpen(false); setInspectorOpen(!inspectorOpen); }}
          >
            {inspectorOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        </div>
        <DashboardWorkspaceLeftPanel />
        <DashboardWorkspaceCanvas />
        <DashboardDataPanel />
        <DashboardWorkspaceInspector />
        <DashboardWorkspacePageBar />
        <DashboardWorkspaceTemplateLibrary />
        <DashboardWorkspaceContextMenu />
      </main>
      </DashboardDataBindingProvider>
    </DashboardWorkspaceProvider>
  );
}
