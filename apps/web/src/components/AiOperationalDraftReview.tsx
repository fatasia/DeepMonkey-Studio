import { useEffect, useRef, useState } from "react";
import { Check, Download, FilePenLine, LoaderCircle, Undo2, X } from "lucide-react";
import type { OperationalCaseRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { suggestionCaseInput, type OperationalSuggestionDraft } from "../ai/operationalSuggestionDraft";
import { translate as tr, type AppLocale } from "../i18n";
import "./AiOperationalDraftReview.css";

/** 复用已有处置记录：审阅后保存为待核对，撤销保留审计记录，不创建独立工单系统。 */
export function AiOperationalDraftReview({ draft, locale = "zh-CN" }: { draft: OperationalSuggestionDraft; locale?: AppLocale }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(draft.title);
  const [actions, setActions] = useState(draft.actions.join("\n"));
  const [saved, setSaved] = useState<OperationalCaseRecord>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef(0);
  const saving = useRef(false);
  const edited = useRef(false);
  const t = (zh: string, en: string) => tr(locale, zh, en);

  useEffect(() => {
    const current = ++request.current;
    saving.current = false;
    edited.current = false;
    setOpen(false); setTitle(draft.title); setActions(draft.actions.join("\n"));
    setSaved(undefined); setBusy(false); setError(""); setNotice("");
    // 恢复同一证据的已审阅结果；失败不伪装为空，保存接口仍提供幂等防重。
    void api.getOperations(draft.projectId).then(snapshot => {
      if (request.current !== current) return;
      const existing = snapshot.cases.find(item => item.externalRef === draft.reference);
      if (!existing) return;
      setSaved(existing);
      if (!edited.current) { setTitle(existing.title); setActions(existing.suggestedActions.join("\n")); }
    }).catch(() => { if (request.current === current) setError(t("处置记录暂未读取；保存时会检查重复记录。", "Could not load saved suggestions; saving checks for duplicates.")); });
    return () => { request.current += 1; };
  }, [draft.projectId, draft.reference]);

  async function save(undo = false) {
    if (saving.current) return;
    const current = ++request.current;
    saving.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const input = undo && saved
        ? { id: saved.id, externalRef: draft.reference, status: "dismissed" as const }
        : { ...suggestionCaseInput(draft, title, actions), ...(saved ? { id: saved.id } : {}) };
      const result = await api.saveOperationalCase(draft.projectId, input);
      if (request.current !== current) return;
      if (result.projectId !== draft.projectId || result.externalRef !== draft.reference) throw new Error(t("返回的处置记录与当前项目不一致，请重新打开核对。", "The saved suggestion does not match this project. Reopen to check."));
      setSaved(result);
      setNotice(undo ? t("已撤销，历史证据保留。", "Withdrawn; evidence is retained.") : t("已保存为待核对处置草稿。", "Saved as a suggestion awaiting review."));
    } catch (reason) {
      if (request.current === current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (request.current === current) { saving.current = false; setBusy(false); }
    }
  }

  function download() {
    const blob = new Blob([JSON.stringify({ schemaVersion: 1, ...draft, title, actions: actions.split(/\r?\n/).filter(Boolean), record: saved }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = "reviewed-ai-suggestion.json"; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }

  return <section className="ai-operational-draft" aria-label={t("处置建议草稿", "Suggested action draft")}>
    <header><button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}><FilePenLine size={14} />{t("审阅处置建议", "Review suggested actions")}</button>
      {saved && <small>{saved.status === "dismissed" ? t("已撤销", "Withdrawn") : t("已保存 · 待核对", "Saved · awaiting review")}</small>}
    </header>
    {open && <div className="ai-operational-draft-body">
      <p>{draft.source === "local-sample" ? t("来源为本地样例；保存后仍是验证用建议。", "Based on a local sample; saved suggestions remain for validation.") : t("依据本次输入与模型结果生成，保存为待核对建议。", "Based on this input and model result; saved for review.")}</p>
      <label><span>{t("处置标题", "Title")}</span><input value={title} maxLength={160} disabled={busy} onChange={event => { edited.current = true; setTitle(event.target.value); }} /></label>
      <details><summary>{t("查看依据", "Evidence")}</summary><ul>{draft.evidence.map((line, index) => <li key={index}>{line}</li>)}</ul></details>
      <label><span>{t("拟执行建议 · 每行一条", "Suggested actions · one per line")}</span><textarea value={actions} rows={4} disabled={busy} onChange={event => { edited.current = true; setActions(event.target.value); }} /></label>
      <footer>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}><X size={13} />{t("收起", "Close")}</button>
        <button type="button" onClick={download}><Download size={13} />{t("导出草稿", "Export draft")}</button>
        {saved && saved.status !== "dismissed" && <button type="button" disabled={busy} onClick={() => void save(true)}><Undo2 size={13} />{t("撤销保存", "Withdraw")}</button>}
        <button type="button" className="primary" disabled={busy || !title.trim() || !actions.trim()} onClick={() => void save()}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}{error ? t("重试保存", "Retry save") : t("保存处置草稿", "Save suggestion")}</button>
      </footer>
    </div>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
