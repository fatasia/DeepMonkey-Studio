import { translate as tr } from "../i18n";
import { DashboardInspectorPageSettings } from "./DashboardInspectorPageSettings";
import { DashboardInspectorSelection } from "./DashboardInspectorSelection";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

export function DashboardWorkspaceInspector() {
  const { locale } = useDashboardWorkspace();

  return (
    <aside className="dashboard-inspector-panel">
      <header>
        <span className="eyebrow">{tr(locale, "组件检查器", "INSPECTOR")}</span>
        <strong>{tr(locale, "属性", "Properties")}</strong>
      </header>
      <DashboardInspectorPageSettings />
      <DashboardInspectorSelection />
    </aside>
  );
}
