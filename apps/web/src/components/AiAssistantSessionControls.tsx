import type { useAssistantSessions } from "../ai/useAssistantSessions";
import { translate as tr, type AppLocale } from "../i18n";
import "./AiAssistantSessionControls.css";

export function AiAssistantSessionControls({ sessions, locale, disabled, onSwitch }: {
  sessions: ReturnType<typeof useAssistantSessions>; locale: AppLocale; disabled: boolean; onSwitch: () => void;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return <section className="ai-session-controls" aria-label={t("会话历史", "Conversation history")}>
    <label>{t("会话", "Conversation")} <select aria-label={t("选择会话", "Choose conversation")} disabled={disabled || sessions.loading}
      value={sessions.sessionId} onChange={event => { onSwitch(); if (event.target.value) void sessions.select(event.target.value); else sessions.newSession(); }}>
      <option value="">{t("新会话", "New conversation")}</option>
      {sessions.sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
    </select></label>
    <button type="button" disabled={disabled || sessions.loading} onClick={() => { onSwitch(); sessions.newSession(); }}>{t("新会话", "New conversation")}</button>
    {sessions.cursor && <button type="button" disabled={disabled} onClick={() => void sessions.refresh(true)}>{t("更多会话", "More conversations")}</button>}
    {sessions.loading && <small role="status">{t("正在恢复会话…", "Restoring conversation…")}</small>}
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
