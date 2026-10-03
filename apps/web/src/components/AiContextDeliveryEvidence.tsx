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
      {receipt.budget && <ContextBudgetNote budget={receipt.budget} labels={labels} locale={locale} />}
    </div>
  </details>;
}

const BUDGET_LABELS: Record<string, [string, string]> = {
  "capability-catalog": ["可调用能力目录", "Capability catalog"], "capability-schemas": ["能力参数 schema", "Capability schemas"], "agent-memory-context": ["项目记忆", "Project memory"],
  operations: ["运营模型与评估", "Operations"], "ppr-bop": ["工艺计划", "Process plans"], battery: ["电池模型", "Battery"],
  "platform.vision": ["视觉数据", "Vision data"], "platform.data": ["数据连接与数据集", "Data connections and datasets"], recentConversation: ["最近对话", "Recent conversation"],
};

/** 「本次上下文」预算说明：用了多少、哪些来源被压缩/缩减/省略，一行一条。 */
function ContextBudgetNote({ budget, labels, locale }: { budget: NonNullable<AiContextDelivery["budget"]>; labels: Record<string, string> | undefined; locale: AppLocale }) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  if (!budget.trimmed.length) return <p className="ai-context-budget">{t("上下文预算", "Context budget")} {budget.usedChars}/{budget.budgetChars} · {t("未裁剪", "no trimming")}</p>;
  const action = { compacted: t("压缩为索引", "indexed"), shrunk: t("已缩减", "reduced"), omitted: t("已省略", "omitted") };
  return <div className="ai-context-budget">
    <p>{t("上下文预算", "Context budget")} {budget.usedChars}/{budget.budgetChars} · {t(`原始 ${budget.originalChars}`, `${budget.originalChars} before trimming`)}</p>
    <ul>{budget.trimmed.map(item => <li key={`${item.id}:${item.reason}`}>
      {labels?.[item.id] ?? (BUDGET_LABELS[item.id] ? t(...BUDGET_LABELS[item.id]!) : item.id)} · {action[item.action]} {item.fromChars}→{item.toChars}
    </li>)}</ul>
  </div>;
}
