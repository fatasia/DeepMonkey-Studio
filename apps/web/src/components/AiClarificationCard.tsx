import { MessageCircleQuestion, ShieldCheck } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import "./AiHarnessCards.css";

export interface AiClarificationOption {
  id: string;
  label: string;
}

/**
 * T1（审计 §二 2.1 / 统一设计 §2.1 M4）：chat 结构化澄清通道的选项卡片载体。
 * sql 提示词要求"歧义时停止并要求澄清"，此前只能以散文出现——本卡给出
 * 可就地作答的选项位（选项点选即以该答案重新发起提问）。
 * 数据源：需要服务端在回答中返回结构化 clarification 字段（域外依赖，见审计 P1-9）；
 * 字段缺省时本卡不渲染，不伪造澄清。
 */
export function AiClarificationCard({ locale, clarification, onAnswer, busy }: {
  locale: AppLocale;
  clarification: AiClarificationRequest;
  onAnswer?: (answer: string) => void;
  busy?: boolean;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const options = clarification.options ?? [];
  return (
    <section className="ai-card ai-card-clarification" aria-label={t("需要澄清", "Clarification needed")}>
      <header className="ai-card-header">
        <span className="ai-card-title">
          <MessageCircleQuestion size={15} aria-hidden="true" />
          {t("需要澄清", "Clarification needed")}
        </span>
        {options.length > 0 && <span className="ai-card-badge badge-inconclusive">{t(`${options.length} 个选项`, `${options.length} options`)}</span>}
      </header>
      <div className="ai-card-body">
        <p>{clarification.question}</p>
        {options.length > 0 && (
          <div className="ai-clarification-options">
            {options.map((option) => (
              <button key={option.id} type="button" disabled={busy || !onAnswer}
                onClick={() => onAnswer?.(option.label)}>
                {option.label}
              </button>
            ))}
          </div>
        )}
        {!options.length && <p className="ai-card-note">{t("请在输入框补充说明后重新发送。", "Add details in the composer and send again.")}</p>}
      </div>
      <footer className="ai-card-footer">
        <span className="ai-card-evidence-line">
          <ShieldCheck size={12} aria-hidden="true" />
          {t("回答前先确认问题边界，避免基于猜测作答", "Confirm the question scope before answering; avoid guessing")}
        </span>
      </footer>
    </section>
  );
}

export interface AiClarificationRequest {
  question: string;
  options?: AiClarificationOption[];
}
