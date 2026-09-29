import { useEffect, useState } from "react";
import { CircleCheck, Ban, FileClock, FileText, FlaskConical, Link2, LoaderCircle, Unlink, Cpu } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { AiProvenanceChain, AiProvenanceTrace } from "@bim-studio/contracts";
import type { ProvenanceTraceQuery } from "../apiClients/provenanceApi";
import "./AiHarnessCards.css";
import "./AiProvenanceCards.css";

type ProvenanceApi = {
  traceProvenance: (projectId: string, query?: ProvenanceTraceQuery, signal?: AbortSignal) => Promise<AiProvenanceTrace>;
};

async function getProvenanceApi(): Promise<ProvenanceApi> {
  return (await import("../api")).api;
}

/**
 * H-C3 档案视图容器：按结果/提案指纹拉取三跳链并渲染时间轴。
 * 未命中如实呈现"档案无记录"（不伪造）；账本断链如实警示（不静默）。
 */
export function AiProvenanceTracePanel({ locale, projectId, resultFingerprint, proposalFingerprint }: {
  locale: AppLocale;
  projectId: string;
  resultFingerprint?: string;
  proposalFingerprint?: string;
}) {
  const [trace, setTrace] = useState<AiProvenanceTrace>();
  const [error, setError] = useState<string>();
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const queryKey = resultFingerprint ?? proposalFingerprint ?? "";

  useEffect(() => {
    const controller = new AbortController();
    setTrace(undefined);
    setError(undefined);
    void getProvenanceApi().then((api) => api.traceProvenance(projectId, {
      ...(resultFingerprint ? { resultFingerprint } : {}),
      ...(proposalFingerprint ? { proposalFingerprint } : {}),
      limit: 5,
    }, controller.signal))
      .then((next) => { if (!controller.signal.aborted) setTrace(next); })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [projectId, queryKey]);

  if (error) return <div className="ai-provenance" role="alert"><small className="ai-provenance-error">{t("档案查询失败：", "Archive lookup failed: ")}{error}</small></div>;
  if (!trace) return <div className="ai-provenance" role="status"><small className="ai-provenance-empty"><LoaderCircle className="spin" size={12} /> {t("正在读取实验档案…", "Loading experiment archive…")}</small></div>;
  if (!trace.matched) {
    return (
      <div className="ai-provenance">
        <small className="ai-provenance-empty">{t("实验档案中暂无该结论的落账记录（该结论可能产生于档案启用之前）。", "No archived record for this conclusion yet (it may predate the archive).")}</small>
      </div>
    );
  }
  return (
    <div className="ai-provenance">
      {trace.chains.map((chain) => <AiProvenanceChainView key={chain.hypothesis.proposalFingerprint} locale={locale} chain={chain} />)}
      {!trace.integrity.intact && (
        <small className="ai-provenance-error" role="alert">
          {t(`完整性核查：${trace.integrity.brokenNodes.length} 个判定节点被改动过，相关链已如实断开。`, `Integrity check: ${trace.integrity.brokenNodes.length} verdict nodes were modified; affected chains are reported broken.`)}
        </small>
      )}
    </div>
  );
}

/** 三跳链时间轴（纯视图）：假设→运行→判定[→报告]，节点三重编码（色+图标+文字）。 */
export function AiProvenanceChainView({ locale, chain }: { locale: AppLocale; chain: AiProvenanceChain }) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const verdict = chain.verdicts[0];
  return (
    <ol className="ai-provenance-steps" aria-label={t("实验档案三跳链", "Experiment provenance chain")}>
      <li className="ai-provenance-step">
        <span className="ai-provenance-dot dot-hypothesis"><FlaskConical size={11} aria-hidden="true" /></span>
        <div className="ai-provenance-node">
          <b>{t("假设", "Hypothesis")}</b>
          <code title={chain.hypothesis.proposalFingerprint}>{short(chain.hypothesis.proposalFingerprint)}</code>
          <small title={chain.hypothesis.statementDigest}>{chain.hypothesis.statementDigest}</small>
          <small>{chain.hypothesis.metricLocator} · {t("登记", "registered")} {shortTime(chain.hypothesis.registeredAt, locale)}</small>
        </div>
      </li>
      {chain.runs.map((run, index) => (
        <li className="ai-provenance-step" key={run.nodeId}>
          <span className="ai-provenance-dot dot-run"><Cpu size={11} aria-hidden="true" /></span>
          <div className="ai-provenance-node">
            <b>{t("内核运行", "Kernel run")}{chain.runs.length > 1 ? ` #${index + 1}` : ""}</b>
            <span className="ai-provenance-fp-line">
              <code title={run.inputFingerprint}>{t("入", "in")} {short(run.inputFingerprint)}</code>
              <code title={run.resultFingerprint}>{t("果", "out")} {short(run.resultFingerprint)}</code>
            </span>
            <small>
              {run.seed !== undefined ? `seed ${run.seed}` : t("种子未记录", "seed unrecorded")}
              {run.replications !== undefined ? ` · ×${run.replications}` : ""}
              {run.goldenHash ? ` · golden ${short(run.goldenHash)}${run.goldenMatch === false ? t("（漂移）", " (drifted)") : ""}` : ""}
              {" · "}{shortTime(run.executedAt, locale)}
            </small>
          </div>
        </li>
      ))}
      {chain.runs.length === 0 && (
        <li className="ai-provenance-step">
          <span className="ai-provenance-dot dot-missing"><Unlink size={11} aria-hidden="true" /></span>
          <div className="ai-provenance-node">
            <b>{t("内核运行", "Kernel run")}</b>
            <small>{t("该假设只登记过、从未执行验证；档案如实保留空运行段。", "Registered but never verified; the archive keeps the empty run segment honestly.")}</small>
          </div>
        </li>
      )}
      {chain.verdicts.map((node) => {
        const badge = VERDICT_MARKS[node.verdict];
        return (
          <li className="ai-provenance-step" key={node.nodeId}>
            <span className={`ai-provenance-dot dot-verdict verdict-${node.verdict}`}><badge.icon size={11} aria-hidden="true" /></span>
            <div className="ai-provenance-node">
              <b>{t("判定", "Verdict")} <span className={`ai-provenance-verdict verdict-${node.verdict}`}>{t(badge.zh, badge.en)}</span></b>
              <small>{node.reasonCode} · {t("容差", "tolerance")} {node.tolerance.absolute} · {shortTime(node.judgedAt, locale)}</small>
              <small title={node.rationaleDigest}>{node.rationaleDigest}</small>
            </div>
          </li>
        );
      })}
      {chain.reports.map((report) => (
        <li className="ai-provenance-step" key={report.nodeId}>
          <span className="ai-provenance-dot dot-report"><FileText size={11} aria-hidden="true" /></span>
          <div className="ai-provenance-node">
            <b>{t("报告", "Report")}</b>
            <code title={report.evidenceFingerprint}>{t("证据", "evidence")} {short(report.evidenceFingerprint)}</code>
            <small>{report.label} · {shortTime(report.reportedAt, locale)}</small>
          </div>
        </li>
      ))}
      {chain.breaks.length > 0 && (
        <li className="ai-provenance-step">
          <span className="ai-provenance-dot dot-broken"><Unlink size={11} aria-hidden="true" /></span>
          <div className="ai-provenance-node">
            <b className="ai-provenance-error">{t("链断裂", "Chain broken")}</b>
            {chain.breaks.map((brk) => <small key={`${brk.nodeId}:${brk.code}`} className="ai-provenance-error">{brk.code}: {brk.detail}</small>)}
          </div>
        </li>
      )}
    </ol>
  );
}

/** 档案入口小徽标（工作区列表与卡片动作共用语义：只标注，不加第二套开关）。 */
export function AiProvenanceLinkBadge({ locale }: { locale: AppLocale }) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return <span className="ai-provenance-link"><Link2 size={11} aria-hidden="true" />{t("档案", "Archive")}</span>;
}

const VERDICT_MARKS: Record<AiProvenanceChain["verdicts"][number]["verdict"], { icon: typeof CircleCheck; zh: string; en: string }> = {
  confirmed: { icon: CircleCheck, zh: "已证实", en: "Verified" },
  refuted: { icon: Ban, zh: "已反驳", en: "Refuted" },
  inconclusive: { icon: FileClock, zh: "无法判定", en: "Inconclusive" },
};

function short(fingerprint: string): string {
  return `${fingerprint.slice(0, 4)}…`;
}

/**
 * T12 统一时间口径（AI助手交互统一设计 §4-4"时间/单位唯一口径"）：
 * 全系统 AI 时间一律本地时区 `MM-DD HH:mm`，不随语言切换 UTC/本地两套口径；
 * 解析失败原样返回（不伪造时间）。此函数是共享工具，档案列表/时间轴/运行历史同源消费。
 */
export function formatAiTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

function shortTime(iso: string, locale: AppLocale): string {
  void locale;
  return formatAiTimestamp(iso);
}
