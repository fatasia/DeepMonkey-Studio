import { AlertTriangle, RotateCcw, ShieldAlert, Sparkles } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { AgentGuardDenial } from "../ai/industrialAgentViewModel";
import "./AiHarnessCards.css";

export type { AgentGuardDenial as AgentGuardDenialPayload } from "../ai/industrialAgentViewModel";

/**
 * H-C2 拒绝理由气泡（交互统一设计 M6 错误/拒绝变体）：
 * 标题行 + 理由码 code 徽标 + 正文 + 保证句 + 一个恢复动作，缺一不可；
 * 熔断（variant-circuit-open）额外呈现计数与人工介入语义，恢复动作是"开始新任务"。
 */
export function AiHarnessDenialCard({ locale, denial, circuitDenials, onRecover }: {
  locale: AppLocale;
  denial: AgentGuardDenial;
  circuitDenials?: number;
  onRecover?: () => void;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const circuit = denial.code === "variant-circuit-open";
  return (
    <section className={`ai-card ai-card-denial${circuit ? " denial-circuit" : ""}`} role="alert" aria-label={t("工具调用被拒绝", "Tool call denied")}>
      <header className="ai-card-header">
        <span className="ai-card-title">
          <AlertTriangle size={15} aria-hidden="true" />
          <strong>{circuit ? t("变体熔断：本轮已终止", "Variant circuit open: run halted") : t("工具调用被拒绝", "Tool call denied")}</strong>
        </span>
        <code className="ai-card-reason-code" title={denial.code}>{denial.code}</code>
      </header>
      <div className="ai-card-body">
        <p className="ai-card-denial-line">
          <small>{t("步骤", "Step")} {denial.step} · {denial.toolId}</small>
          {circuit && circuitDenials !== undefined && <small> · {t(`同变体连续被拒 ${circuitDenials} 次`, `same variant denied ${circuitDenials} times`)}</small>}
        </p>
        <p>{denial.message}</p>
        <p className="ai-card-note">
          {circuit
            ? t("熔断后本轮为终态：不会自动继续；请修正方案后开始新任务（计数按新任务重新开始）。", "The halted run is terminal and will not auto-continue; fix the proposal and start a new run (the counter restarts per run).")
            : t("该调用未执行，未写入任何变更；请按理由码修正假设后重试。", "The call was not executed and nothing was written; revise the hypothesis per the reason code and retry.")}
        </p>
      </div>
      <footer className="ai-card-footer">
        <span className="ai-card-evidence-line">
          <ShieldAlert size={12} aria-hidden="true" />
          {t("拒绝已落审计（denied 事件 + 理由码）", "Denial audited (denied event + reason code)")}
        </span>
        {onRecover && (
          <button type="button" className="ai-card-action" onClick={onRecover}>
            {circuit ? <Sparkles size={12} aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
            {circuit ? t("开始新任务", "New task") : t("刷新进度", "Refresh progress")}
          </button>
        )}
      </footer>
    </section>
  );
}
