import { useState } from "react";
import { Archive, Ban, CircleCheck, FileClock, FlaskConical, ShieldCheck } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { AiVerificationEnvelope } from "@bim-studio/contracts";
import { AiProvenanceTracePanel } from "./AiProvenanceTraceView";
import "./AiHarnessCards.css";

/**
 * H-C1 结论卡片（交互统一设计 M4 结构化卡片的首个实现）。
 *
 * 状态徽章严格三重编码（交互统一设计 §2.2，色+图标+文字缺一不可）：
 * confirmed → var(--success) + CircleCheck + 已证实；refuted → var(--danger) + Ban + 已反驳；
 * inconclusive → var(--text-muted) + FileClock + 无法判定。
 * 取色只允许 base.css 令牌 × color-mix 公式；字号只落在 10/11/12/13 四档；
 * 三指纹默认露前 4 位 + 省略号，title 放全文；证据与参数走二级折叠。
 * H-C3 增量（动作位）：传入 projectId 时 footer 出现"查看档案"动作，
 * 就地展开三跳链时间轴（AiProvenanceTracePanel）；未传时不渲染动作位，行为与 H-C1 完全一致。
 */
export function AiHypothesisVerdictCard({ locale, envelope, toolLabel, projectId }: {
  locale: AppLocale;
  envelope: AiVerificationEnvelope;
  toolLabel?: string;
  projectId?: string;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const badge = VERDICT_BADGES[envelope.verdict];
  const reason = VERDICT_REASONS[envelope.reasonCode];
  const [archiveOpen, setArchiveOpen] = useState(false);
  return (
    <section className={`ai-card ai-card-verdict verdict-${envelope.verdict}`} aria-label={t("假设验证结论", "Hypothesis verdict")}>
      <header className="ai-card-header">
        <span className="ai-card-title">
          <FlaskConical size={15} aria-hidden="true" />
          <strong>{t("假设验证", "Hypothesis verification")}</strong>
        </span>
        <span className={`ai-card-badge badge-${envelope.verdict}`}>
          <badge.icon size={13} aria-hidden="true" />
          {t(badge.zh, badge.en)}
        </span>
      </header>
      <div className="ai-card-body">
        <p className="ai-card-verdict-line">
          {t("判定", "Verdict")} <code>{envelope.verdict}</code>
          {" · "}{t("理由", "Reason")} {t(reason.zh, reason.en)}
          {envelope.observed && <>
            {" · "}{t("实测", "Observed")} <code>{envelope.observed.metric}{envelope.observed.resourceId ? `:${envelope.observed.resourceId}` : ""} = {formatObserved(envelope.observed.value)}</code>
          </>}
        </p>
        {envelope.verdict === "refuted" && <p className="ai-card-note">{t("实测值越过容差带且与预测方向相反：该假设被确定性内核反驳，请基于实测值修正假设或方案。", "The observation crossed the tolerance band against the predicted direction: the hypothesis is refuted by the deterministic kernel. Revise the hypothesis with the observed value.")}</p>}
        {envelope.verdict === "inconclusive" && <p className="ai-card-note">{t("证据不足以双向裁决（容差带内、基准漂移或指标缺失）；不要把该结论当作支持或反驳的证据。", "Evidence cannot decide either direction (tolerance band, baseline drift, or missing metric); do not treat this as supporting or refuting evidence.")}</p>}
        <p className="ai-card-fingerprints">
          <span title={envelope.proposalFingerprint}>{t("提案", "Proposal")} {shortFingerprint(envelope.proposalFingerprint)}</span>
          <span title={envelope.inputFingerprint}>{t("输入", "Input")} {shortFingerprint(envelope.inputFingerprint)}</span>
          <span title={envelope.resultFingerprint}>{t("结果", "Result")} {shortFingerprint(envelope.resultFingerprint)}</span>
          {envelope.goldenHash && <span title={envelope.goldenHash}>{t("golden", "golden")} {shortFingerprint(envelope.goldenHash)}{envelope.goldenMatch === false ? ` · ${t("漂移", "drifted")}` : ""}</span>}
        </p>
        <details className="ai-card-details">
          <summary>
            <span>{t("证据与容差", "Evidence and tolerance")}</span>
            <span>{envelope.evidence.length}</span>
          </summary>
          <ul>
            {envelope.evidence.map((item) => (
              <li key={item.id}>
                <b>{item.label}</b>
                <small>{item.source}</small>
                {item.fingerprint && <code title={item.fingerprint}>{shortFingerprint(item.fingerprint)}</code>}
              </li>
            ))}
          </ul>
          <p className="ai-card-tolerance">{t("绝对容差", "Absolute tolerance")} <code>{envelope.tolerance.absolute}</code> · {t("容差带内判 inconclusive，不强行归边", "inside the band is inconclusive; never forced to a side")}</p>
        </details>
      </div>
      <footer className="ai-card-footer">
        <span className="ai-card-evidence-line">
          <ShieldCheck size={12} aria-hidden="true" />
          {t(`${envelope.evidence.length} 条指纹化证据`, `${envelope.evidence.length} fingerprinted evidence`)}
          {toolLabel ? ` · ${toolLabel}` : ""}
          {envelope.engineId ? ` · ${envelope.engineId}` : ""}
        </span>
        {projectId && (
          <button
            type="button"
            className="ai-card-action"
            aria-expanded={archiveOpen}
            onClick={() => setArchiveOpen((current) => !current)}
          >
            <Archive size={12} aria-hidden="true" />
            {t("查看档案", "View archive")}
          </button>
        )}
      </footer>
      {archiveOpen && projectId && (
        <AiProvenanceTracePanel locale={locale} projectId={projectId} resultFingerprint={envelope.resultFingerprint} />
      )}
    </section>
  );
}

const VERDICT_BADGES: Record<AiVerificationEnvelope["verdict"], { icon: typeof CircleCheck; zh: string; en: string }> = {
  confirmed: { icon: CircleCheck, zh: "已证实", en: "Verified" },
  refuted: { icon: Ban, zh: "已反驳", en: "Refuted" },
  inconclusive: { icon: FileClock, zh: "无法判定", en: "Inconclusive" },
};

const VERDICT_REASONS: Record<AiVerificationEnvelope["reasonCode"], { zh: string; en: string }> = {
  "prediction-within-tolerance": { zh: "越过容差带且方向成立", en: "crossed the band in the predicted direction" },
  "prediction-outside-tolerance": { zh: "越过容差带且方向相反", en: "crossed the band against the prediction" },
  "prediction-in-tolerance-band": { zh: "落在容差带内", en: "inside the tolerance band" },
  "golden-baseline-mismatch": { zh: "golden 基准漂移", en: "golden baseline drifted" },
  "metric-unavailable": { zh: "指标不可观测", en: "metric unavailable" },
};

function shortFingerprint(fingerprint: string): string {
  return `${fingerprint.slice(0, 4)}…`;
}

function formatObserved(value: number): string {
  return String(Number(value.toFixed(6)));
}
