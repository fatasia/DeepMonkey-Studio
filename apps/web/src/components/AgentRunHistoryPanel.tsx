import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, Clock, History, RefreshCw } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import {
  browserRunHistoryStore,
  isStaleAgentRunEntry,
  type AgentRunHistoryEntry,
} from "../ai/agentRunHistory";
import type { AgentMemoryView, AgentRunArchiveView } from "../apiClients/industrialAgentApi";
import { agentStatusLabel } from "../ai/industrialAgentViewModel";

type AgentMemoryApi = {
  listAgentMemory: (projectId: string, signal?: AbortSignal) => Promise<AgentMemoryView>;
};

async function getMemoryApi(): Promise<AgentMemoryApi> {
  return (await import("../api")).api;
}

/**
 * H-C5-K13 历史运行面板：工作台内第三个折叠行（与记忆/档案同构），列出本地记住的
 * 最近运行并提供恢复入口；服务端归档（agentMemory runs 段）补充终态语义。
 * 数据以本地列表为权威（含未终态运行），归档只做增强，读取失败不遮挡本地历史。
 */
export function AgentRunHistoryPanel({ locale, projectId, onOpen }: {
  locale: AppLocale;
  projectId: string;
  onOpen: (runId: string) => void;
}) {
  const [entries, setEntries] = useState<AgentRunHistoryEntry[]>([]);
  const [archives, setArchives] = useState<Record<string, AgentRunArchiveView>>();
  const [archiveError, setArchiveError] = useState<string>();

  useEffect(() => {
    // 本地历史同步可读；旧单槽键在 store 内迁移兜底，存储不可用时降级为空列表。
    setEntries(browserRunHistoryStore().list(projectId));
    const controller = new AbortController();
    void getMemoryApi().then((api) => api.listAgentMemory(projectId, controller.signal))
      .then((view) => {
        if (controller.signal.aborted) return;
        setArchives(Object.fromEntries((view.runArchives ?? []).map((item) => [item.runId, item])));
        setArchiveError(undefined);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setArchiveError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => controller.abort();
  }, [projectId]);

  const rows = useMemo(() => mergeArchiveIntoEntries(entries, archives), [entries, archives]);
  const refreshLocal = () => setEntries(browserRunHistoryStore().list(projectId));
  return (
    <AgentRunHistoryPanelView
      locale={locale}
      runs={rows}
      {...(archiveError ? { archiveError } : {})}
      onOpen={(runId) => { refreshLocal(); onOpen(runId); }}
      onToggle={refreshLocal}
    />
  );
}

export interface AgentRunHistoryRow extends AgentRunHistoryEntry {
  /** 服务端归档确认的终态状态码；未归档（可能仍在推进或服务端不可达）时为空。 */
  archivedStatus?: AgentRunArchiveView["status"];
}

/** 同 runId 以服务端终态归档为准补充语义；本地 objective 为空时用归档目标回填。 */
export function mergeArchiveIntoEntries(
  entries: readonly AgentRunHistoryEntry[],
  archives?: Record<string, AgentRunArchiveView>,
): AgentRunHistoryRow[] {
  return entries.map((entry) => {
    const archive = archives?.[entry.runId];
    if (!archive) return { ...entry };
    return {
      ...entry,
      objective: entry.objective || archive.objective,
      ...(typeof archive.status === "string" ? { archivedStatus: archive.status } : {}),
    };
  });
}

/** 纯视图：静态渲染可测。陈旧/终态/运行中三态用 图标+语义色+文字 三重编码。 */
export function AgentRunHistoryPanelView({ locale, runs, archiveError, now = new Date(), onOpen, onToggle }: {
  locale: AppLocale;
  runs: readonly AgentRunHistoryRow[];
  archiveError?: string;
  now?: Date;
  onOpen: (runId: string) => void;
  /** 展开面板时重读本地记录（其他组件 remember 后打开即最新）。 */
  onToggle?: () => void;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return (
    <details className="ai-context-disclosure industrial-agent-run-history" aria-label={t("历史运行", "Run history")} {...(onToggle ? { onToggle } : {})}>
      <summary>
        <span><History size={13} aria-hidden="true" /><strong>{t("历史运行", "Run history")}</strong></span>
        <span className={archiveError ? "partial" : "ready"}>
          {runs.length > 0 ? t(`${runs.length} 条本地记录`, `${runs.length} remembered`) : t("暂无", "None")}
          <ChevronDown size={12} />
        </span>
      </summary>
      <div className="ai-context-disclosure-body industrial-agent-run-history-body">
        {runs.length === 0 && <small>{t("还没有可恢复的运行记录；启动任务后会自动记住最近 10 条。", "No remembered runs yet; the last 10 runs are kept automatically.")}</small>}
        <ul className="industrial-agent-run-history-list">
          {runs.map((run) => {
            const stale = isStaleAgentRunEntry(run, now);
            return (
              <li key={run.runId} className={stale ? "industrial-agent-run-history-item stale" : "industrial-agent-run-history-item"}>
                {run.archivedStatus
                  ? <span className={`industrial-agent-run-history-state tone-${statusTone(run.archivedStatus)}`}><Clock size={12} aria-hidden="true" />{agentStatusLabel(run.archivedStatus, locale)}</span>
                  : <span className="industrial-agent-run-history-state tone-muted"><Clock size={12} aria-hidden="true" />{t("状态未知", "Status unknown")}</span>}
                <span className="industrial-agent-run-history-objective" title={run.objective || run.runId}>{run.objective || t("（未记录目标）", "(objective not recorded)")}</span>
                <code title={run.runId}>{shortId(run.runId)}</code>
                {stale && <em className="industrial-agent-run-history-stale" title={t("本地记录已超过 48 小时，实际状态以打开后的服务端返回为准。", "This local entry is older than 48h; the real state is whatever the server returns when opened.")}>{t("陈旧", "Stale")}</em>}
                <button type="button" onClick={() => onOpen(run.runId)}>{t("打开", "Open")}</button>
              </li>
            );
          })}
        </ul>
        {archiveError && <small role="alert" className="industrial-agent-run-history-archive-error">{t("服务端归档读取失败，以上为本地记录：", "Server archive unavailable; the list above is local:")}{archiveError}</small>}
      </div>
    </details>
  );
}

function statusTone(status: AgentRunArchiveView["status"]): "success" | "danger" | "warning" | "muted" {
  if (status === "completed") return "success";
  if (status === "failed") return "danger";
  if (status === "blocked" || status === "budget-exhausted") return "warning";
  return "muted";
}

/**
 * H-C5-K11：恢复失败显式可操作——显示 runId、失败原因与"重试恢复"入口，
 * 不再只给一句泛化提示。404（运行已不存在）与网络/服务错误分开表述。
 */
export function AgentRecoveryFailureNotice({ locale, runId, notFound, message, busy, onRetry, onDismiss, onClear }: {
  locale: AppLocale;
  runId: string;
  notFound: boolean;
  message?: string;
  busy: boolean;
  onRetry: () => void;
  onDismiss: () => void;
  /** 404 时提供就地清除本地记录的出路（文案提到的动作必须有对应按钮）。 */
  onClear?: () => void;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return (
    <div className="industrial-agent-recovery-failure" role="alert">
      <AlertTriangle size={14} />
      <span>
        <strong>{t(`上次运行（${shortId(runId)}）恢复失败`, `Failed to restore the previous run (${shortId(runId)})`)}</strong>
        <small>{notFound ? t("该运行已不存在：可能已被服务端清理，或属于其他会话。可清除该记录或直接开始新任务。", "This run no longer exists: it may have been cleaned up or belongs to another session. Clear the entry or start a new task.") : message}</small>
      </span>
      <span className="industrial-agent-recovery-actions">
        {!notFound && <button type="button" disabled={busy} onClick={onRetry}><RefreshCw size={12} />{t("重试恢复", "Retry restore")}</button>}
        {notFound && onClear && <button type="button" onClick={onClear}>{t("清除记录", "Clear entry")}</button>}
        <button type="button" onClick={onDismiss}>{t("不再提示", "Dismiss")}</button>
      </span>
    </div>
  );
}

/** H-C5-K11：跨项目运行显式标注——收到其他项目的 checkpoint 时说明并保留本地视图，不静默丢弃。 */
export function AgentCrossProjectNotice({ locale, runId, projectId, onDismiss }: {
  locale: AppLocale;
  runId: string;
  projectId: string;
  onDismiss: () => void;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return (
    <div className="industrial-agent-cross-project" role="status">
      <AlertTriangle size={14} />
      <span>
        <strong>{t(`运行 ${shortId(runId)} 属于其他项目（${projectId}）`, `Run ${shortId(runId)} belongs to another project (${projectId})`)}</strong>
        <small>{t("已忽略其更新；如需查看请切换到该项目后打开历史记录。", "Its updates were ignored; switch to that project and open the run history to inspect it.")}</small>
      </span>
      <button type="button" onClick={onDismiss}>{t("知道了", "Got it")}</button>
    </div>
  );
}

function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}
