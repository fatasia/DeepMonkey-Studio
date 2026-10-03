import { SquarePen } from "lucide-react";
import type { useAssistantSessions } from "../ai/useAssistantSessions";
import { translate as tr, type AppLocale } from "../i18n";
import "./AiAssistantSessionControls.css";

type AssistantSessions = ReturnType<typeof useAssistantSessions>;
const LOAD_MORE_SESSIONS = "__more__";

/** 头部会话切换：标题下方的轻量下拉 + 新会话按钮；分页以"更多会话…"选项承载，不再占独立按钮。 */
export function AiAssistantSessionPicker({ sessions, locale, disabled, onSwitch }: {
  sessions: AssistantSessions; locale: AppLocale; disabled: boolean; onSwitch: () => void;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const locked = disabled || sessions.loading;
  return <div className="ai-session-picker">
    <select aria-label={t("选择会话", "Choose conversation")} disabled={locked}
      title={sessions.loading ? t("正在恢复会话…", "Restoring conversation…") : t("切换历史会话", "Switch conversation")}
      value={sessions.sessionId} onChange={event => {
        const next = event.target.value;
        if (next === LOAD_MORE_SESSIONS) { void sessions.refresh(true); return; }
        onSwitch();
        if (next) void sessions.select(next); else sessions.newSession();
      }}>
      <option value="">{sessions.loading ? t("正在恢复会话…", "Restoring…") : t("新会话", "New conversation")}</option>
      {sessions.sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
      {sessions.cursor && <option value={LOAD_MORE_SESSIONS}>{t("更多会话…", "More conversations…")}</option>}
    </select>
    <button type="button" className="ai-session-new" disabled={locked || !sessions.sessionId}
      aria-label={t("新会话", "New conversation")} title={t("新会话", "New conversation")}
      onClick={() => { onSwitch(); sessions.newSession(); }}>
      <SquarePen size={14} />
    </button>
  </div>;
}

/** 会话同步/保存的异常提示：正常状态不渲染任何内容，只有需要用户处理时才出现。 */
export function AiAssistantSessionControls({ sessions, locale, disabled, onSwitch }: {
  sessions: AssistantSessions; locale: AppLocale; disabled: boolean; onSwitch: () => void;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  if (!sessions.externalSessionId && !sessions.conflict && !sessions.error) return null;
  return <section className="ai-session-controls" aria-label={t("会话同步", "Conversation sync")}>
    {/* K12 多标签页同步：其他窗口保存了此会话时提示，由用户决定何时载入（不打断本页流式）。 */}
    {sessions.externalSessionId && <div role="status" className="ai-session-external"><span>
      {t("另一个窗口更新了此会话，可载入最新内容。", "This conversation was updated in another window; you can load the latest content.")}
    </span>
      <button type="button" disabled={disabled || sessions.loading} onClick={() => { onSwitch(); void sessions.refresh(); }}>{t("载入最新", "Load latest")}</button>
    </div>}
    {/* K12 语义化 409：保存遇到另一标签页写入时给出明确归因与一键刷新，不再当作普通失败行。 */}
    {sessions.conflict && <div role="alert" className="ai-session-conflict"><span>
      {t("另一个标签页已更新了此会话，本页的保存已暂停；请刷新获取最新状态后再继续。", "Another tab has updated this conversation; saving here is paused. Refresh to get the latest state before continuing.")}
    </span>
      <button type="button" onClick={() => void sessions.refresh()}>{t("刷新获取最新状态", "Refresh for latest")}</button>
    </div>}
    {sessions.error && <div role="alert"><span>{sessions.error}</span>
      <button type="button" onClick={() => void sessions.retrySave()}>{t("重试保存", "Retry saving")}</button>
      <button type="button" disabled={disabled} onClick={() => void sessions.refresh()}>{t("重新读取", "Reload")}</button>
    </div>}
  </section>;
}
