import { LoaderCircle } from "lucide-react";
import type { AssistantMode } from "../api";
import type { AssistantReliabilitySummary } from "../ai/assistantReliability";
import { translate as tr, type AppLocale } from "../i18n";
import { AiResponseEvidence } from "./AiResponseEvidence";
import { AiMessageCopyAction } from "./AiMessageCopyAction";
import { AiExecutionDetails } from "./AiExecutionDetails";
import { AiHarnessDenialCard } from "./AiHarnessDenialCard";
import { AiHypothesisVerdictCard } from "./AiHypothesisVerdictCard";
import { AiRequestProgress } from "./AiRequestProgress";
import { AiClarificationCard, type AiClarificationRequest } from "./AiClarificationCard";

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
  /** K18:失败原因随条目持久化——刷新后失败条目仍可见原因,不再只存瞬时 error 态。 */
  error?: string;
  /** H-C1：M4 结构化结论卡片（VerificationEnvelope）；当前数据源为 agent 侧回灌，chat 流按缺省不渲染。 */
  verdict?: import("@bim-studio/contracts").AiVerificationEnvelope;
  /** H-C2：M6 拒绝气泡（理由码透传）；chat 流数据源待 H-C3 档案接入，字段缺省不渲染。 */
  denial?: import("./AiHarnessDenialCard").AgentGuardDenialPayload;
  /**
   * T1（审计 §二 2.1）：M4 澄清卡载体——服务端返回结构化 clarification 字段时渲染选项卡。
   * 当前 chat 流尚无该数据源（需 assistantService 透传，域外依赖），字段缺省不渲染。
   */
  clarification?: AiClarificationRequest;
}

export function AiAssistantMessages({ locale, conversation, busy, error, stopped, lastPrompt, lastScope, answer, execution, onRetry, projectId, busyHint, requestStartedAt, onAnswerClarification }: {
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
  /** K3：dashboard 等结构化输出在流式可见文本出现前的占位说明，避免 busy 期零输出观感。 */
  busyHint?: string;
  /** T6：本次请求开始时刻（ms）；缺省不显示进度行。 */
  requestStartedAt?: number;
  /** T1：就地作答回调；缺省时澄清卡选项不可点（仍可复制问题自行补答）。 */
  onAnswerClarification?: (answer: string) => void;
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
        {/* P1-3 修复:恢复态整批被 init 转 interrupted(客户端崩溃/刷新,非服务端故障)——
            中性"未完成"标注,不再误示"服务中断";证据栏 L70 已有恢复态中性说明。 */}
        {item.status && item.status !== "completed" && <small role="status">{({ streaming: t("保存的生成中片段", "Saved in-progress text"), stopped: t("已停止", "Stopped"), failed: t("未完成", "Incomplete"), interrupted: t("未完成", "Incomplete") })[item.status]}{item.status === "failed" && item.error ? ` · ${item.error}` : ""}</small>}
        {item.verdict && <AiHypothesisVerdictCard locale={locale} envelope={item.verdict} {...(projectId ? { projectId } : {}) } />}
        {item.denial && <AiHarnessDenialCard locale={locale} denial={item.denial} />}
        {item.clarification && <AiClarificationCard locale={locale} clarification={item.clarification}
          {...(onAnswerClarification ? { onAnswer: onAnswerClarification } : {})} {...(busy ? { busy: true } : {})} />}
        {item.reliability ? <AiResponseEvidence locale={locale} reliability={item.reliability} /> : <small>{t("恢复的历史回答，未保存验证证据", "Restored answer; verification evidence was not saved")}</small>}
        <AiMessageCopyAction locale={locale} text={item.answer} />
      </article>
    </section>)}
    {(busy || error || stopped) && lastPrompt && <section className="ai-conversation-turn" aria-label={t("当前请求", "Current request")}>
      <div className="ai-user-message">{lastPrompt}</div>
      {lastScope && <small className="ai-message-scope" title={lastScope}>{lastScope}</small>}
      {stopped && <article role="status">{t("已停止", "Stopped")} <button type="button" onClick={onRetry}>{t("重试原问题", "Retry original prompt")}</button></article>}
      {busy && !answer && <article role="status"><LoaderCircle className="spin" size={14} /> {busyHint ?? t("正在处理，请稍候…", "Working on your request…")}
        <AiRequestProgress locale={locale} phase="connecting" {...(requestStartedAt !== undefined ? { startedAt: requestStartedAt } : {})} />
      </article>}
      {/* T7（审计 §二 2.3）：dashboard 结构化布局在完成前不可见——骨架占位如实表达"布局生成中"，
          不伪造内容；可见文本（JSON envelope 的 text 字段）仍正常流式透出。 */}
      {busy && !answer && busyHint && <div className="ai-dashboard-skeleton" aria-hidden="true">
        <span className="ai-dashboard-skeleton-line" />
        <span className="ai-dashboard-skeleton-grid">
          <i /><i /><i /><i />
        </span>
      </div>}
    </section>}
    {answer && (conversation.at(-1)?.answer !== answer || busy) && <article className="ai-streaming-answer">
      <small>{busy ? t("正在基于项目证据分析", "Analyzing project evidence") : t("模型回答", "Model response")}</small>
      {execution && <AiExecutionDetails locale={locale} execution={execution} />}
      <p>{answer}</p>
      {busy && <AiRequestProgress locale={locale} phase="streaming" {...(requestStartedAt !== undefined ? { startedAt: requestStartedAt } : {})} />}
      {!busy && <AiMessageCopyAction locale={locale} text={answer} />}
    </article>}
  </>;
}
