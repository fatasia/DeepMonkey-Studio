import { CircleCheck, CircleDot, LayoutDashboard, Plus, TriangleAlert } from "lucide-react";
import { translate as tr } from "../i18n";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

/** 页面标签与运行状态常驻画布底部，图层仍在左侧统一管理。 */
export function DashboardWorkspacePageBar() {
  const {
    addDashboardPage,
    application,
    connected,
    currentView,
    dashboardDiagnostics,
    locale,
    onSelectPage,
    page,
    zoom,
  } = useDashboardWorkspace();
  const errorCount = dashboardDiagnostics.filter((item) => item.severity === "error").length;

  return (
    <footer className="dashboard-page-bar">
      <div className="dashboard-page-tabs" role="tablist" aria-label={tr(locale, "页面标签", "Page tabs")}>
        {application.pages.map((candidate) => (
          <button
            key={candidate.id}
            role="tab"
            aria-selected={candidate.id === page.id}
            className={candidate.id === page.id ? "active" : ""}
            title={candidate.name}
            onClick={() => onSelectPage(candidate.id, currentView())}
          >
            <LayoutDashboard size={12} />
            <span>{candidate.name}</span>
          </button>
        ))}
        <button className="add" title={tr(locale, "新增空白页面", "Add blank page")} aria-label={tr(locale, "新增空白页面", "Add blank page")} onClick={addDashboardPage}>
          <Plus size={13} />
        </button>
      </div>
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
