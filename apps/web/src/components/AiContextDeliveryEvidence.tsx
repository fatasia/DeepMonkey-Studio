import type { AiContextDelivery } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export function AiContextDeliveryEvidence({ receipt, labels, locale }: {
  receipt: AiContextDelivery; labels: Record<string, string> | undefined; locale: AppLocale;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return <details className="ai-context-disclosure">
    <summary><strong>{t("实际发送来源", "Sources actually sent")}</strong><small>{receipt.sentChars} / {receipt.preparedChars} UTF-16</small></summary>
    <div className="ai-context-disclosure-body">
      <p>{t("字数以服务端整理后的快照为准；已发送不代表模型已验证。", "Counts refer to the prepared snapshot; sending does not imply verification.")}</p>
      <div className="ai-context-source-list">
        {receipt.sources.map((source) => <span key={source.id} className={source.status === "sent" ? "ready" : "partial"}>
          <strong title={source.path}>{labels?.[source.id] ?? (source.id === "capability-catalog" ? t("可调用能力目录", "Capability catalog") : source.id === "bim-evidence" ? t("BIM 证据", "BIM evidence") : source.path)}</strong>
          <small>{source.status === "sent" ? t("已发送", "Sent") : source.status === "omitted" ? t("未发送", "Not sent") : t("部分发送", "Partially sent")} · {source.sentChars}/{source.preparedChars}</small>
          {source.transformed && <small>{t("预处理已裁剪或隔离", "Trimmed or quarantined during preparation")}</small>}
        </span>)}
      </div>
    </div>
  </details>;
}
