import { useEffect, useState } from "react";
import { Archive, ChevronDown, RefreshCw, Unlink } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { ProvenanceChainList } from "../apiClients/provenanceApi";
import { AiProvenanceTracePanel } from "./AiProvenanceTraceView";
import "./AiHarnessCards.css";
import "./AiProvenanceCards.css";

type ProvenanceApi = {
  listProvenanceChains: (projectId: string, signal?: AbortSignal) => Promise<ProvenanceChainList>;
};

async function getProvenanceApi(): Promise<ProvenanceApi> {
  return (await import("../api")).api;
}

/**
 * H-C3 实验档案面板（工业 Agent 工作区入口，M0 族折叠行同构 AiMemoryPanel）：
 * 列出最近的三跳链摘要（假设/判定/运行数/完整性），点开任意链就地展开时间轴。
 * 只读面；空档案如实呈现"还没有落账记录"；账本断链在列表行上以警示徽标可见。
 */
export function AiProvenancePanel({ locale, projectId }: { locale: AppLocale; projectId: string }) {
  const [view, setView] = useState<ProvenanceChainList>();
  const [error, setError] = useState<string>();
  const [expanded, setExpanded] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    void getProvenanceApi().then((api) => api.listProvenanceChains(projectId, controller.signal))
      .then((next) => { if (!controller.signal.aborted) setView(next); })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [projectId]);

  const refresh = async () => {
    setError(undefined);
    try {
      setView(await (await getProvenanceApi()).listProvenanceChains(projectId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <AiProvenancePanelView
      locale={locale}
      projectId={projectId}
      {...(view ? { view } : {})}
      {...(error !== undefined ? { error } : {})}
      {...(expanded !== undefined ? { expanded } : {})}
      onToggle={(proposalFingerprint) => setExpanded((current) => (current === proposalFingerprint ? undefined : proposalFingerprint))}
      onRefresh={() => void refresh()}
    />
  );
}

export type AiProvenancePanelProps = {
  locale: AppLocale;
  projectId: string;
  view?: ProvenanceChainList;
  error?: string;
  expanded?: string;
  onToggle: (proposalFingerprint: string) => void;
  onRefresh: () => void;
};

/** 纯视图：数据与回调全部由外部注入（可静态渲染测试）。 */
export function AiProvenancePanelView({ locale, projectId, view, error, expanded, onToggle, onRefresh }: AiProvenancePanelProps) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const chains = view?.chains ?? [];
  const broken = view && !view.integrity.intact;
  const summary = error
    ? t("读取失败", "Unavailable")
    : view === undefined
      ? t("读取中…", "Loading…")
      : t(`已归档 ${chains.length} 条链${broken ? " · 存在断链" : ""}`, `${chains.length} chains${broken ? " · broken links present" : ""}`);
  return (
    <details className="ai-context-disclosure ai-provenance-panel" aria-label={t("实验档案", "Experiment archive")}>
      <summary>
        <span>
          <Archive size={13} aria-hidden="true" />
          <strong>{t("实验档案", "Experiment archive")}</strong>
        </span>
        <span className={error || broken ? "partial" : "ready"}>
          {summary}
          <ChevronDown size={12} />
        </span>
      </summary>
      <div className="ai-context-disclosure-body ai-provenance-body">
        <p className="ai-provenance-note">
          {t("每次假设验证在产生判定时自动落账：假设→运行→判定（→报告）按指纹成链，只存指纹与判定，不存提示词原文。", "Every hypothesis verification is archived when the verdict is produced: hypothesis→run→verdict(→report) chained by fingerprints; only fingerprints and verdicts are stored, never prompts.")}
        </p>
        {chains.length === 0 && !error && <small className="ai-provenance-empty">{t("还没有落账记录：运行一次假设验证后，链会出现在这里。", "No archived records yet: run a hypothesis verification and its chain will appear here.")}</small>}
        <ul className="ai-provenance-list">
          {chains.map((chain) => (
            <li key={chain.hypothesis.proposalFingerprint} className={`ai-provenance-item integrity-${chain.integrity}`}>
              <span className="ai-provenance-item-actions">
                {chain.integrity === "broken"
                  ? <span className="ai-provenance-link" title={t("该链上的判定被改动过", "A verdict on this chain was modified")}><Unlink size={11} />{t("断链", "Broken")}</span>
                  : <span className="ai-provenance-link"><Archive size={11} />{t("完整", "Intact")}</span>}
              </span>
              <span className="ai-provenance-item-main">
                <span className="ai-provenance-item-title">
                  <b title={chain.hypothesis.hypothesisId}>{chain.hypothesis.hypothesisId}</b>
                  {chain.latest && <VerdictMark locale={locale} verdict={chain.latest.verdict} />}
                  <small>{chain.hypothesis.metricLocator}</small>
                </span>
                <span className="ai-provenance-item-statement" title={chain.hypothesis.statementDigest}>{chain.hypothesis.statementDigest}</span>
                <small className="ai-provenance-item-title">
                  <span>{t(`${chain.runCount} 次运行`, `${chain.runCount} run(s)`)}{chain.reportCount ? ` · ${t(`${chain.reportCount} 份报告`, `${chain.reportCount} report(s)`)}` : ""}</span>
                  <span>{chain.lastActivityAt.slice(0, 16).replace("T", " ")}</span>
                  <code title={chain.hypothesis.proposalFingerprint}>{chain.hypothesis.proposalFingerprint.slice(0, 4)}…</code>
                </small>
              </span>
              <span className="ai-provenance-expand">
                <button
                  type="button"
                  aria-expanded={expanded === chain.hypothesis.proposalFingerprint}
                  onClick={() => onToggle(chain.hypothesis.proposalFingerprint)}
                >
                  {expanded === chain.hypothesis.proposalFingerprint ? t("收起链", "Hide chain") : t("查看三跳链", "View chain")}
                </button>
              </span>
              {expanded === chain.hypothesis.proposalFingerprint && (
                <span className="ai-provenance-expand">
                  <AiProvenanceTracePanel locale={locale} projectId={projectId} proposalFingerprint={chain.hypothesis.proposalFingerprint} />
                </span>
              )}
            </li>
          ))}
        </ul>
        {error && <small role="alert" className="ai-provenance-error">{error}</small>}
        <span className="ai-provenance-expand">
          <button type="button" onClick={onRefresh}><RefreshCw size={11} />{t("刷新档案", "Refresh")}</button>
        </span>
      </div>
    </details>
  );
}

function VerdictMark({ locale, verdict }: { locale: AppLocale; verdict: string }) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const marks: Record<string, { zh: string; en: string }> = {
    confirmed: { zh: "已证实", en: "Verified" },
    refuted: { zh: "已反驳", en: "Refuted" },
    inconclusive: { zh: "无法判定", en: "Inconclusive" },
  };
  const mark = marks[verdict];
  return <span className={`ai-provenance-verdict verdict-${verdict}`}>{mark ? t(mark.zh, mark.en) : verdict}</span>;
}
