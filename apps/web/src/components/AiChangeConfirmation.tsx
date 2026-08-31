import { AlertTriangle, Check, LayoutDashboard, LoaderCircle, ShieldCheck, X } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";

interface AiChangeConfirmationProps {
  locale: AppLocale;
  widgetCount: number;
  widgetLabels?: string[];
  evidenceLabels?: string[];
  busy?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * AI 写入只保留一次就地确认，不引入审批人、审批队列或独立审批中心。
 * 普通问答不会渲染此组件，避免只读操作也打断用户。
 */
export function AiChangeConfirmation({
  locale,
  widgetCount,
  widgetLabels = [],
  evidenceLabels = [],
  busy = false,
  error,
  onCancel,
  onConfirm,
}: AiChangeConfirmationProps) {
  const t = (zh: string, en: string) => tr(locale, zh, en);

  return (
    <section className="ai-change-confirmation" aria-label={t("确认 AI 变更", "Confirm AI change")}>
      <header>
        <span className="ai-change-icon"><LayoutDashboard size={15} /></span>
        <span>
          <strong>{t("写入当前二维看板", "Apply to the current dashboard")}</strong>
          <small>{t("这是 AI 生成的草稿；确认后仍需人工检查字段、布局和告警阈值", "This is an AI-generated draft; review fields, layout, and alarm thresholds after applying")}</small>
        </span>
      </header>
      <dl>
        <div><dt>{t("变更内容", "Change")}</dt><dd>{t(`生成 ${widgetCount} 个看板组件`, `Generate ${widgetCount} dashboard widgets`)}</dd></div>
        <div><dt>{t("影响范围", "Scope")}</dt><dd>{t("当前场景的二维看板草稿", "2D dashboard draft in the current scene")}</dd></div>
        <div><dt>{t("风险等级", "Risk")}</dt><dd>{t("低 · 不会自动保存或发布", "Low · does not save or publish automatically")}</dd></div>
        <div><dt>{t("不会修改", "Unchanged")}</dt><dd>{t("三维对象、脚本与数据源", "3D objects, scripts, and data sources")}</dd></div>
      </dl>
      {widgetLabels.length > 0 && (
        <div className="ai-change-items" aria-label={t("拟新增组件", "Proposed widgets")}>
          {widgetLabels.slice(0, 6).map((label) => <span key={label}>{label}</span>)}
          {widgetLabels.length > 6 && <span>+{widgetLabels.length - 6}</span>}
        </div>
      )}
      <p className="ai-change-evidence">
        <ShieldCheck size={12} />
        {evidenceLabels.length > 0
          ? t(`参考快照：${evidenceLabels.join("、")}`, `Snapshot inputs: ${evidenceLabels.join(", ")}`)
          : t("未返回可核验的 Capability 证据，仅按当前上下文生成", "No verifiable Capability evidence was returned; generated from the current context only")}
      </p>
      {error && (
        <p className="ai-change-error" role="alert">
          <AlertTriangle size={12} />
          {error} {t("草稿尚未写入，可直接重试或取消。", "The draft was not applied; retry or cancel.")}
        </p>
      )}
      <footer>
        <button type="button" disabled={busy} onClick={onCancel}><X size={13} />{t("取消", "Cancel")}</button>
        <button type="button" className="primary" disabled={busy} onClick={onConfirm}>
          {busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
          {busy ? t("正在写入", "Applying") : error ? t("重试应用", "Retry apply") : t("应用到草稿", "Apply to draft")}
        </button>
      </footer>
    </section>
  );
}
