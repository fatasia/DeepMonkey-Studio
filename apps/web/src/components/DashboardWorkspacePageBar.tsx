import { CircleCheck, CircleDot, TriangleAlert } from "lucide-react";
import { translate as tr } from "../i18n";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

/** 底栏只显示运行状态；页面与图层统一在左侧管理。 */
export function DashboardWorkspacePageBar() {
  const {
    connected,
    dashboardDiagnostics,
    locale,
    page,
    zoom,
  } = useDashboardWorkspace();
  const errorCount = dashboardDiagnostics.filter((item) => item.severity === "error").length;

  return (
    <footer className="dashboard-page-bar">
      <span className="dashboard-page-context" title={page.name}>{page.name}</span>
      <div className="dashboard-runtime-status" aria-label={tr(locale, "编辑器状态", "Editor status")}>
        <span className={connected ? "healthy" : "warning"}><CircleDot size={10} />{connected ? tr(locale, "数据在线", "Data online") : tr(locale, "数据离线", "Data offline")}</span>
        <span>{page.nodes.length} {tr(locale, "个组件", "components")}</span>
        <span className={errorCount ? "error" : dashboardDiagnostics.length ? "warning" : "healthy"}>
          {dashboardDiagnostics.length ? <TriangleAlert size={10} /> : <CircleCheck size={10} />}
          {dashboardDiagnostics.length ? tr(locale, `${dashboardDiagnostics.length} 项诊断`, `${dashboardDiagnostics.length} diagnostics`) : tr(locale, "联动正常", "Linkage healthy")}
        </span>
        <output>{Math.round(zoom * 100)}%</output>
      </div>
    </footer>
  );
}
