import { canRetryAgentDecision, MAX_AGENT_DECISION_RECOVERIES, type AgentCheckpoint } from "@bim-studio/industrial-agent-orchestrator";
import { Database, Play, RefreshCw } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";

/** 选择和重试只继续当前检查点，不伪装成工具审批或新任务。 */
export function IndustrialAgentContinuation(props: {
  locale: AppLocale;
  checkpoint: AgentCheckpoint;
  busy: boolean;
  onResume: () => void;
  onSelect?: (id: string) => void;
}) {
  const { checkpoint, locale } = props;
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const selection = checkpoint.status === "awaiting-input" ? checkpoint.pendingSelection : undefined;
  const last = checkpoint.selections?.at(-1);
  return <>
    {last && <p className="industrial-agent-notice"><Database size={12} />{t("已选择：", "Selected: ")}{last.option.label}</p>}
    {selection && <section className="industrial-agent-approval industrial-agent-selection" aria-label={t("选择数据源", "Select data source")}>
      <header><Database size={15} /><span><strong>{selection.question}</strong><small>{t("仅确认数据源，写入与控制仍需单独确认。", "Choose one to continue; this does not authorize writes or controls.")}</small></span></header>
      <div className="industrial-agent-choice-list">{selection.options.map(option => <button type="button" key={option.id} disabled={props.busy || !props.onSelect} onClick={() => props.onSelect?.(option.id)}>
        <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}<code>{option.id}</code></span><Play size={13} />
      </button>)}</div>
    </section>}
    {canRetryAgentDecision(checkpoint) && <section className="industrial-agent-approval" aria-label={t("恢复失败决策", "Recover failed decision")}>
      <header><RefreshCw size={15} /><span><strong>{t("上游暂时不可用，可以继续", "The provider was unavailable; you can resume")}</strong><small>{t(`仅重试下一步决策，保留已完成操作；本次追加 30 秒恢复保留时间。还可恢复 ${MAX_AGENT_DECISION_RECOVERIES - (checkpoint.decisionRecoveries?.length ?? 0)} 次。`, `Retry only the next decision, keeping completed operations; this adds a 30-second recovery reserve. ${MAX_AGENT_DECISION_RECOVERIES - (checkpoint.decisionRecoveries?.length ?? 0)} recovery attempts remain.`)}</small></span></header>
      <button type="button" className="primary" disabled={props.busy} onClick={props.onResume}><RefreshCw size={13} />{t("重试决策并继续", "Retry decision and continue")}</button>
    </section>}
  </>;
}
