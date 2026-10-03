import { useState } from "react";
import { AlertTriangle, Check, CheckCircle2, ChevronDown, Copy, FileClock, ShieldCheck } from "lucide-react";
import type { AssistantReliabilitySummary } from "../ai/assistantReliability";
import { translate as tr, type AppLocale } from "../i18n";
import { copyDocumentationCode } from "./DocsCenterClipboard";
import { AiContextDeliveryEvidence } from "./AiContextDeliveryEvidence";

interface AiResponseEvidenceProps {
  locale: AppLocale;
  reliability: AssistantReliabilitySummary;
}

const GRADE_ICON = {
  "capability-verified": CheckCircle2,
  "context-supported": FileClock,
  limited: AlertTriangle,
  unverified: AlertTriangle,
};

/** 模型文本与确定性能力结果共用同一种证据说明，避免用户误判可靠等级。 */
export function AiResponseEvidence({ locale, reliability }: AiResponseEvidenceProps) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const Icon = GRADE_ICON[reliability.grade];
  const gradeText = {
    "capability-verified": t("Capability 已执行", "Capability executed"),
    "context-supported": t("仅上下文支持", "Context supported only"),
    limited: t("证据有限", "Limited evidence"),
    unverified: t("尚未验证", "Not verified"),
  }[reliability.grade];
  const trustText = {
    "client-snapshot": t("客户端项目快照", "Client project snapshot"),
    "server-evidence": t("服务端证据", "Server evidence"),
    "capability-result": t("Capability 结果", "Capability result"),
  }[reliability.contextTrust];

  return (
    <details className={`ai-response-evidence grade-${reliability.grade}`}>
      <summary>
        <span>
          <Icon size={13} />
          <strong>{gradeText}</strong>
          <small>{trustText}</small>
        </span>
        <ChevronDown size={12} />
      </summary>
      <div>
        <dl>
          <div>
            <dt>{t("执行证据", "Execution evidence")}</dt>
            <dd>{reliability.evidenceCount > 0 ? t(`${reliability.evidenceCount} 条`, `${reliability.evidenceCount} records`) : t("无", "None")}</dd>
          </div>
          <div>
            <dt>{t("写入策略", "Write policy")}</dt>
            <dd>{reliability.writePolicy === "confirm-required" ? t("确认后写入", "Confirm before write") : t("只读", "Read only")}</dd>
          </div>
          <div>
            <dt>{t("输入风险", "Input risk")}</dt>
            <dd>{riskLabel(reliability.inputRisk, locale)}</dd>
          </div>
          {reliability.traceId && (
            <div>
              <dt>Trace</dt>
              <EvidenceCopyValue locale={locale} value={reliability.traceId} labelZh="Trace ID" labelEn="Trace ID" />
            </div>
          )}
          {reliability.contextFingerprint && (
            <div>
              <dt>{t("证据指纹", "Evidence fingerprint")}</dt>
              <EvidenceCopyValue locale={locale} value={reliability.contextFingerprint} labelZh="证据指纹" labelEn="evidence fingerprint" />
            </div>
          )}
        </dl>
        {reliability.citations && reliability.citations.length > 0 && (
          <>
            <p className="citations-title">{t("逐条引用（回答数值 ↔ 已发送证据）", "Per-item citations (answer values ↔ sent evidence)")}</p>
            <dl className="ai-response-citations">
              {reliability.citations.map((citation) => (
                <div key={citation.token} className="citation-row">
                  <dt><code>{citation.token}</code></dt>
                  <dd className="citation-anchors">
                    {citation.anchors.map((anchor) => {
                      const label = citationSourceLabel(anchor.sourceId, anchor.sourcePath, reliability.contextSourceLabels, t);
                      return (
                        <span key={`${anchor.sourceId}:${anchor.offset}`} className="citation-anchor"
                          title={`${label} · ${anchor.sourcePath} @${anchor.offset} · ${anchor.fingerprint}`}>
                          <strong>{label}</strong>
                          <small>@{anchor.offset}</small>
                          <EvidenceCopyButton locale={locale} value={anchor.fingerprint}
                            labelZh={`来源指纹（${label}）`} labelEn={`source fingerprint (${label})`} />
                        </span>
                      );
                    })}
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
        {reliability.contextDelivery && <AiContextDeliveryEvidence receipt={reliability.contextDelivery} labels={reliability.contextSourceLabels} locale={locale} />}
        {!reliability.contextDelivery && reliability.sourceLabels.length > 0 && (
          <p>
            <ShieldCheck size={12} />
            {t("本次涉及：", "Sources in scope: ")}
            {reliability.sourceLabels.join("、")}
          </p>
        )}
        {reliability.warnings.map((warning) => (
          <p className="warning" key={warning}>
            <AlertTriangle size={12} />
            {warning}
          </p>
        ))}
        {reliability.fallbackReason === "no-capability-evidence" && (
          <p className="warning">
            <AlertTriangle size={12} />
            {t(
              "本次回答未返回 Capability 执行证据，模型文本不能替代现场校验。",
              "This response contains no Capability execution evidence; model text does not replace site verification.",
            )}
          </p>
        )}
      </div>
    </details>
  );
}

function riskLabel(risk: AssistantReliabilitySummary["inputRisk"], locale: AppLocale): string {
  if (risk === "high") return tr(locale, "高", "High");
  if (risk === "medium") return tr(locale, "中", "Medium");
  return tr(locale, "低", "Low");
}

/**
 * T5（审计 20260929 §二 T5）：逐条引用——回答中的具体数值/编号对应到具体已发送证据。
 * 每行 = 回答 token（dt 等宽码）+ 服务端锚（来源标签 + 源内偏移 + 可复制来源指纹）。
 * 锚全部来自服务端 citations（K2 校验器同源、发送窗口内真实定位），前端不自造、不猜来源；
 * title 悬浮给出来源路径与指纹全文，可见行保持信息密度纪律。来源标签回退与
 * AiContextDeliveryEvidence 同族（目录/BIM 证据/路径）。
 */
function citationSourceLabel(sourceId: string, sourcePath: string, labels: Record<string, string> | undefined, t: (zh: string, en: string) => string): string {
  return labels?.[sourceId] ?? (sourceId === "capability-catalog" ? t("可调用能力目录", "Capability catalog") : sourceId === "bim-evidence" ? t("BIM 证据", "BIM evidence") : sourcePath);
}

/**
 * T4（审计 §二）：traceId / 证据指纹从"title 全文纯文本"升级为可点复制的结构化行——
 * 三跳可溯链的第一跳入口（复制后可在实验档案/审计侧核对），title 仍保留全文。
 * 复制失败静默保留纯文本可选手动复制（不弹错打断阅读）。
 */
function EvidenceCopyValue({ locale, value, labelZh, labelEn }: { locale: AppLocale; value: string; labelZh: string; labelEn: string }) {
  return (
    <dd>
      <EvidenceCopyButton locale={locale} value={value} labelZh={labelZh} labelEn={labelEn} />
    </dd>
  );
}

/** T5：裸复制钮（无 dd 包装）——主证据行与逐条引用锚共用同一复制行为，不建第二套逻辑。 */
function EvidenceCopyButton({ locale, value, labelZh, labelEn }: { locale: AppLocale; value: string; labelZh: string; labelEn: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyDocumentationCode(value)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_600);
      })
      .catch(() => { /* 复制失败不打断阅读；文本仍可手动选择复制。 */ });
  };
  return (
    <button type="button" className="ai-evidence-copy" title={value} onClick={copy}
      aria-label={tr(locale, `复制${labelZh}`, `Copy ${labelEn}`)}>
      <code>{value}</code>
      {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
      <span className={copied ? undefined : "sr-only"} role="status">{copied ? tr(locale, "已复制", "Copied") : ""}</span>
    </button>
  );
}
