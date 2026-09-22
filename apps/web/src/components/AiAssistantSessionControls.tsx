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
    {sessions.error && <div role="alert"><span>{sessions.error}</span>
      <button type="button" onClick={() => void sessions.retrySave()}>{t("重试保存", "Retry saving")}</button>
      <button type="button" disabled={disabled} onClick={() => void sessions.refresh()}>{t("重新读取", "Reload")}</button>
    </div>}
  </section>;
}
