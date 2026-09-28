import { LoaderCircle } from "lucide-react";
import type { AssistantMode } from "../api";
import type { AssistantReliabilitySummary } from "../ai/assistantReliability";
import { translate as tr, type AppLocale } from "../i18n";
import { AiResponseEvidence } from "./AiResponseEvidence";
import { AiMessageCopyAction } from "./AiMessageCopyAction";
import { AiExecutionDetails } from "./AiExecutionDetails";
import { AiHarnessDenialCard } from "./AiHarnessDenialCard";
import { AiHypothesisVerdictCard } from "./AiHypothesisVerdictCard";

export interface AssistantConversationItem {
  id: string;
  mode: AssistantMode;
  question: string;
  answer: string;
  model?: string;
  execution?: import("@bim-studio/contracts").AiAssistantResponse["execution"];
  scope?: string;
  reliability?: AssistantReliabilitySummary;
  status?: import("@bim-studio/contracts").AiSessionMessageStatus;
  /** H-C1：M4 结构化结论卡片（VerificationEnvelope）；当前数据源为 agent 侧回灌，chat 流按缺省不渲染。 */
  verdict?: import("@bim-studio/contracts").AiVerificationEnvelope;
  /** H-C2：M6 拒绝气泡（理由码透传）；chat 流数据源待 H-C3 档案接入，字段缺省不渲染。 */
  denial?: import("./AiHarnessDenialCard").AgentGuardDenialPayload;
}

export function AiAssistantMessages({ locale, conversation, busy, error, stopped, lastPrompt, lastScope, answer, execution, onRetry, projectId }: {
  locale: AppLocale;
  conversation: AssistantConversationItem[];
  busy: boolean;
  error: string | undefined;
  stopped: boolean;
  lastPrompt: string;
  lastScope: string;
  answer: string;
  execution?: AssistantConversationItem["execution"];
  onRetry: () => void;
  /** H-C3：档案动作位需要项目作用域；缺省时结论卡片不渲染"查看档案"。 */
  projectId?: string;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return <>
    {conversation.map((item) => <section className="ai-conversation-turn" key={item.id}>
      <div className="ai-user-message">{item.question}</div>
      <article>
        <small>{item.model ?? t("模型回答", "Model response")}</small>
        {item.execution && <AiExecutionDetails locale={locale} execution={item.execution} />}
        {item.scope && <small className="ai-message-scope" title={item.scope}>{item.scope}</small>}
        <p>{item.answer}</p>
        {item.status && item.status !== "completed" && <small role="status">{({ streaming: t("保存的生成中片段", "Saved in-progress text"), stopped: t("已停止", "Stopped"), failed: t("未完成", "Failed"), interrupted: t("服务中断", "Interrupted") })[item.status]}</small>}
        {item.verdict && <AiHypothesisVerdictCard locale={locale} envelope={item.verdict} {...(projectId ? { projectId } : {})} />}
        {item.denial && <AiHarnessDenialCard locale={locale} denial={item.denial} />}
        {item.reliability ? <AiResponseEvidence locale={locale} reliability={item.reliability} /> : <small>{t("恢复的历史回答，未保存验证证据", "Restored answer; verification evidence was not saved")}</small>}
        <AiMessageCopyAction locale={locale} text={item.answer} />
      </article>
    </section>)}
    {(busy || error || stopped) && lastPrompt && <section className="ai-conversation-turn" aria-label={t("当前请求", "Current request")}>
      <div className="ai-user-message">{lastPrompt}</div>
      {lastScope && <small className="ai-message-scope" title={lastScope}>{lastScope}</small>}
      {stopped && <article role="status">{t("已停止", "Stopped")} <button type="button" onClick={onRetry}>{t("重试原问题", "Retry original prompt")}</button></article>}
      {busy && !answer && <article role="status"><LoaderCircle className="spin" size={14} /> {t("正在处理，请稍候…", "Working on your request…")}</article>}
    </section>}
    {answer && (conversation.at(-1)?.answer !== answer || busy) && <article className="ai-streaming-answer">
      <small>{busy ? t("正在基于项目证据分析", "Analyzing project evidence") : t("模型回答", "Model response")}</small>
      {execution && <AiExecutionDetails locale={locale} execution={execution} />}
      <p>{answer}</p>
      {!busy && <AiMessageCopyAction locale={locale} text={answer} />}
    </article>}
  </>;
}
