import { AlertTriangle, FolderOpen, RefreshCw } from "lucide-react";
import type { ManagerDirectoryController } from "../hooks/useManagerDirectoryController";
import type { DirectoryLoadState } from "../hooks/managerDirectoryRequest";
import { translate as tr, type AppLocale } from "../i18n";
import "../styles/managerDirectoryStatus.css";

type DirectoryKind = "projects" | "scenes" | "applications";
export interface ManagerDirectoryIssue { kind: DirectoryKind; state: DirectoryLoadState }

export function managerDirectoryIssue(directory: ManagerDirectoryController | undefined, hasProject: boolean): ManagerDirectoryIssue | undefined {
  if (!directory) return undefined;
  const kinds: DirectoryKind[] = hasProject ? ["projects", "scenes", "applications"] : ["projects"];
  const kind = kinds.find(candidate => directory[candidate].phase !== "ready");
  return kind ? { kind, state: directory[kind] } : undefined;
}

export function ManagerDirectoryStatus({ issue, locale, onRetry }: {
  issue: ManagerDirectoryIssue; locale: AppLocale; onRetry: () => void;
}) {
  const failed = issue.state.phase === "error";
  const label = issue.kind === "projects" ? tr(locale, "项目目录", "project directory")
    : issue.kind === "scenes" ? tr(locale, "场景目录", "scene directory") : tr(locale, "应用目录", "application directory");
  return <section className={`manager-directory-state ${failed ? "is-error" : "is-loading"}`}
    role={failed ? "alert" : "status"} aria-busy={!failed} aria-live="polite">
    <div className="manager-directory-message">
      <span className="manager-directory-icon" aria-hidden="true">{failed ? <AlertTriangle size={24} /> : <FolderOpen size={24} />}</span>
      <div>
        <h2>{failed ? tr(locale, `${label}暂时无法读取`, `Unable to load the ${label}`) : tr(locale, `正在读取${label}`, `Loading the ${label}`)}</h2>
        <p>{failed ? tr(locale, "读取失败不代表内容为空。请检查服务或网络连接后重试。", "A failed read does not mean the directory is empty. Check the service or connection, then retry.")
          : tr(locale, "正在确认项目内容，请稍候。", "Checking project content. Please wait.")}</p>
        {failed && <small>{issue.state.httpStatus ? `HTTP ${issue.state.httpStatus}` : tr(locale, "请求未完成", "Request incomplete")}
          {issue.state.hasData && tr(locale, " · 上次读取的内容已保留，可能不是最新版本", " · Previously loaded content is retained and may be out of date")}</small>}
      </div>
      {failed && <button type="button" className="button primary" onClick={onRetry}><RefreshCw size={15} />{tr(locale, "重新读取", "Retry loading")}</button>}
    </div>
    {!failed && <div className="manager-directory-skeleton" aria-hidden="true">{[0, 1, 2].map(key => <div key={key}><i /><span /><span /></div>)}</div>}
  </section>;
}
