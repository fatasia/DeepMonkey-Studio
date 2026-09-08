import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Bot, Send, Square, X } from "lucide-react";
import { translate as tr } from "../i18n";
import { useDialogEscape } from "../hooks/useGlobalDialogEscape";
import { useDashboardAiDraft } from "../ai/useDashboardAiDraft";
import { useDashboardWorkspace } from "./dashboardWorkspaceContext";
import { DashboardAiDraftDiff } from "./DashboardAiDraftDiff";
import "./DashboardAiDraft.css";

export function DashboardAiDraftEntry() {
  const { locale, application, page, writebackAccess } = useDashboardWorkspace();
  const [open, setOpen] = useState(false);
  if (!writebackAccess?.canWrite) return null;
  const key = `${writebackAccess.userId}:${application.metadata.projectId}:${application.metadata.id}:${page.id}`;
  return <>
    <button type="button" aria-label={tr(locale, "AI 看板", "AI dashboard")} title={tr(locale, "AI 看板", "AI dashboard")} aria-expanded={open} onClick={() => setOpen(value => !value)}><Bot size={15} /></button>
    {open && createPortal(<DashboardAiDraftPanel key={key} onClose={() => setOpen(false)} />, document.body)}
  </>;
}

function DashboardAiDraftPanel({ onClose }: { onClose(): void }) {
  const { application, page, locale, writebackAccess, onCommand } = useDashboardWorkspace();
  const session = useDashboardAiDraft({ application, page, locale, onCommand, canWrite: Boolean(writebackAccess?.canWrite) });
  const [question, setQuestion] = useState("");
  const focus = useRef<HTMLTextAreaElement>(null);
  const escape = useDialogEscape(onClose);
  useEffect(() => { const previous = document.activeElement; focus.current?.focus(); return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); }; }, []);
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return <div ref={escape} className="dialog-backdrop dashboard-ai-draft">
    <section role="dialog" aria-modal="false" aria-label={t("AI 看板", "AI dashboard")}>
      <header><strong title={page.name}>{t("AI 看板", "AI dashboard")} · {page.name}</strong><button type="button" aria-label={t("关闭 AI 看板", "Close AI dashboard")} onClick={onClose}><X size={16} /></button></header>
      <div className="dashboard-ai-draft-body">
        <form onSubmit={event => { event.preventDefault(); void session.generate(question); }}>
          <textarea ref={focus} aria-label={t("看板需求", "Dashboard request")} value={question} maxLength={3000} rows={3} placeholder={t("描述要新增或修改的组件", "Describe widgets to add or change")} onChange={event => setQuestion(event.target.value)} />
          <div className="dashboard-ai-draft-actions">
            {session.phase ? <button type="button" onClick={event => { event.preventDefault(); session.cancel(); }}><Square size={14} />{t("停止", "Stop")}</button>
              : <button type="submit" disabled={!question.trim() || !session.catalogReady}><Send size={14} />{t("生成草案", "Generate draft")}</button>}
          </div>
        </form>
        {session.phase && <p role="status">{session.phase === "catalog" ? t("正在读取数据目录…", "Loading data catalog…") : session.phase === "apply" ? t("正在验证并应用…", "Validating and applying…") : t("正在生成…", "Generating…")}</p>}
        {session.answer && <p className="dashboard-ai-draft-answer" aria-live="polite">{session.answer}</p>}
        {session.error && <p role="alert">{session.error}</p>}
        {!session.catalogReady && !session.phase && <button type="button" onClick={() => void session.loadCatalog()}>{t("重试读取目录", "Retry catalog")}</button>}
        {session.notice && <p role="status">{session.notice}</p>}
        {session.proposal?.diff.length ? <DashboardAiDraftDiff locale={locale} diff={session.proposal.diff} /> : null}
        {session.stale && <p role="alert">{t("页面已变化，请重新生成草案。", "Page changed. Generate a new draft.")}</p>}
      </div>
      {session.proposal?.command && <footer>
        <button type="button" disabled={Boolean(session.phase)} onClick={session.discard}>{t("取消草案", "Discard draft")}</button>
        <button type="button" className="primary" disabled={Boolean(session.phase) || session.stale} onClick={() => void session.apply()}>{t("确认应用", "Apply changes")}</button>
      </footer>}
    </section>
  </div>;
}
