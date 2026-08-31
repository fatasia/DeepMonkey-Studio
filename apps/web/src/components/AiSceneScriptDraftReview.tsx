import { Check, Code2, FileDiff, ShieldCheck, TriangleAlert, X } from "lucide-react";
import type { AiSceneScriptDraftResult, AiSceneScriptRisk } from "../ai/sceneScriptDraft";
import { translate as tr, type AppLocale } from "../i18n";
import "./AiSceneScriptDraftReview.css";

interface AiSceneScriptDraftReviewProps {
  locale: AppLocale;
  draft: AiSceneScriptDraftResult;
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onInsertIntoEditor: (draft: AiSceneScriptDraftResult) => void;
}

/**
 * 该组件只确认把草稿交给代码编辑器，不保存、不启用也不运行脚本。
 * 真正执行仍由现有脚本工作台的保存、运行和 SceneCommand 策略负责。
 */
export function AiSceneScriptDraftReview({
  locale,
  draft,
  busy = false,
  error,
  onCancel,
  onInsertIntoEditor,
}: AiSceneScriptDraftReviewProps) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const ready = draft.status === "ready" && Boolean(draft.draftScript);
  const analysisErrors = draft.analysis?.issues.filter((issue) => issue.severity === "error") ?? [];
  const analysisWarnings = draft.analysis?.issues.filter((issue) => issue.severity === "warning") ?? [];

  return (
    <section className={`ai-script-draft-review status-${draft.status}`} aria-label={t("审查 AI 脚本草稿", "Review AI script draft")}>
      <header>
        <span className="ai-script-draft-icon"><Code2 size={16} /></span>
        <span>
          <strong>{t("场景与脚本共创草稿", "Scene and script co-authoring draft")}</strong>
          <small>{draft.target.name} · {draft.target.id}</small>
        </span>
        <span className={`ai-script-risk risk-${draft.risk}`}>{riskLabel(draft.risk, locale)}</span>
      </header>

      <div className="ai-script-draft-policy">
        <ShieldCheck size={13} />
        <span>
          <strong>{ready ? t("静态门禁已通过", "Static gates passed") : t("尚不能插入", "Not ready to insert")}</strong>
          <small>{t("确认只会插入编辑器，不会保存、启用或运行", "Confirmation only inserts into the editor; it does not save, enable, or run")}</small>
        </span>
      </div>

      {draft.actionLabels.length > 0 && (
        <div className="ai-script-draft-actions" aria-label={t("受限动作", "Restricted actions")}>
          {draft.actionLabels.map((label) => <span key={label}>{label}</span>)}
        </div>
      )}

      <dl className="ai-script-draft-summary">
        <div><dt>{t("生命周期", "Lifecycle")}</dt><dd>{draft.lifecycle}</dd></div>
        <div><dt>{t("命令白名单", "Command allowlist")}</dt><dd>{draft.commandTypes.length ? draft.commandTypes.join(" · ") : t("未通过", "Not validated")}</dd></div>
        <div><dt>{t("静态检查", "Static checks")}</dt><dd>{t(`${analysisErrors.length} 错误 · ${analysisWarnings.length} 警告`, `${analysisErrors.length} errors · ${analysisWarnings.length} warnings`)}</dd></div>
      </dl>

      <details className="ai-script-draft-diff" open>
        <summary><FileDiff size={13} /> {t("变更摘要", "Change summary")}</summary>
        <p>{draft.diff.summary}</p>
        {draft.diff.declarationsAdded.length > 0 && (
          <div>{draft.diff.declarationsAdded.map((item) => <span key={item}>{item}</span>)}</div>
        )}
        {draft.diff.preview.length > 0 && <pre>{draft.diff.preview.map((line) => `+ ${line}`).join("\n")}</pre>}
      </details>

      {(draft.issues.length > 0 || analysisErrors.length > 0 || analysisWarnings.length > 0) && (
        <div className="ai-script-draft-issues" role={ready ? "status" : "alert"}>
          {[...draft.issues, ...analysisErrors, ...analysisWarnings].map((issue, index) => (
            <p key={`${issue.code}:${index}`}>
              <TriangleAlert size={12} />
              {issue.message}
            </p>
          ))}
        </div>
      )}

      {error && <p className="ai-script-draft-error" role="alert">{error}</p>}
      <footer>
        <button type="button" disabled={busy} onClick={onCancel}><X size={13} />{t("取消", "Cancel")}</button>
        <button type="button" className="primary" disabled={!ready || busy} onClick={() => onInsertIntoEditor(draft)}>
          <Check size={13} />
          {busy ? t("正在插入", "Inserting") : t("确认并插入编辑器", "Confirm and insert into editor")}
        </button>
      </footer>
    </section>
  );
}

function riskLabel(risk: AiSceneScriptRisk, locale: AppLocale): string {
  if (risk === "high") return tr(locale, "高风险", "High risk");
  if (risk === "medium") return tr(locale, "中风险", "Medium risk");
  return tr(locale, "低风险", "Low risk");
}
