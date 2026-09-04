import { CircleCheck, CircleDot, Plus, TriangleAlert } from "lucide-react";
import { translate as tr } from "../i18n";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";

/** 底栏提供页面页签切换（用户要求恢复底部页签），右侧保留运行状态。 */
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
      <div className="dashboard-page-tabs" role="tablist" aria-label={tr(locale, "页面", "Pages")}>
        {application.pages.map((candidate) => (
          <button
            key={candidate.id}
            role="tab"
            aria-selected={candidate.id === page.id}
            className={`dashboard-page-tab ${candidate.id === page.id ? "active" : ""}`}
            title={candidate.name}
            onClick={() => onSelectPage(candidate.id, currentView())}
          >
            {candidate.name}
            <small>{candidate.nodes.length}</small>
          </button>
        ))}
        <button className="dashboard-page-tab-add" title={tr(locale, "新增空白页面", "Add blank page")} aria-label={tr(locale, "新增空白页面", "Add blank page")} onClick={addDashboardPage}>
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
