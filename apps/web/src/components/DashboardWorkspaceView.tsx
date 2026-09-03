import { DashboardRuntimePreview } from "./DashboardRuntimePreview";
import type { DashboardWorkspaceController } from "./DashboardWorkspace";
import { DashboardWorkspaceCanvas } from "./DashboardWorkspaceCanvas";
import { DashboardWorkspaceContextMenu } from "./DashboardWorkspaceContextMenu";
import { DashboardWorkspaceHeader } from "./DashboardWorkspaceHeader";
import { DashboardWorkspaceInspector } from "./DashboardWorkspaceInspector";
import { DashboardWorkspaceLeftPanel } from "./DashboardWorkspaceLeftPanel";
import { DashboardWorkspacePageBar } from "./DashboardWorkspacePageBar";
import { DashboardWorkspaceTemplateLibrary } from "./DashboardWorkspaceTemplateLibrary";
import { DashboardWorkspaceProvider } from "./dashboardWorkspaceContext";

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
    setRuntimePreview,
    variables,
  } = controller;

  if (runtimePreview) {
    return (
      <DashboardRuntimePreview
        locale={locale}
        application={application}
        project={project}
        page={page}
        rendererBackend={rendererBackend}
        metrics={runtimeMetrics}
        variables={variables}
        filters={filters}
        connected={connected}
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
      <main className={`dashboard-workspace${leftPanelOpen ? "" : " left-panel-collapsed"}${inspectorOpen ? "" : " inspector-collapsed"}`}>
        <h1 className="sr-only">{page.name} · {locale === "zh-CN" ? "二维页面编辑" : "2D page editor"}</h1>
        <DashboardWorkspaceHeader />
        <DashboardWorkspaceLeftPanel />
        <DashboardWorkspaceCanvas />
        <DashboardWorkspaceInspector />
        <DashboardWorkspacePageBar />
        <DashboardWorkspaceTemplateLibrary />
        <DashboardWorkspaceContextMenu />
      </main>
    </DashboardWorkspaceProvider>
  );
}
