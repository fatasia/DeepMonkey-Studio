import type { DashboardDraftDiff } from "../ai/dashboardDraft";
import { translate as tr, type AppLocale } from "../i18n";

export function DashboardAiDraftDiff({ locale, diff }: { locale: AppLocale; diff: readonly DashboardDraftDiff[] }) {
  return <div className="dashboard-ai-draft-diff" aria-label={tr(locale, "草案差异", "Draft changes")}>
    {diff.map(change => <article key={change.id}>
      <strong>{change.op === "add" ? tr(locale, "新增", "Add") : change.op === "delete" ? tr(locale, "删除", "Delete") : tr(locale, "修改", "Update")} · {change.title}</strong>
      {change.op === "delete" ? <p>{tr(locale, "移除此组件，其他内容不变。", "Remove this widget; other content is unchanged.")}</p>
        : <dl>{changedFields(change, locale).map(field => <div key={field.key}><dt>{field.key}</dt><dd>{field.before === undefined ? "" : `${field.before} → `}{field.after}</dd></div>)}</dl>}
    </article>)}
  </div>;
}

function changedFields(change: DashboardDraftDiff, locale: AppLocale) {
  const before = change.before ? { name: change.before.name, frame: change.before.frame, ...change.before.widget } : {};
  const after = change.after ? { name: change.after.name, frame: change.after.frame, ...change.after.widget } : {};
  const labels: Record<string, string> = { title: "标题", frame: "布局", type: "类型", key: "数据键", unit: "单位", field: "字段", datasetId: "数据集", fontSize: "字号", analysis: "分析", chart: "图表", name: "名称", min: "下限", max: "上限" };
  return Object.entries(after).filter(([key, value]) => value !== undefined && JSON.stringify(value) !== JSON.stringify(before[key as keyof typeof before]))
    .map(([key, value]) => ({ key: locale === "zh-CN" ? labels[key] ?? key : key, before: before[key as keyof typeof before] === undefined ? undefined : display(before[key as keyof typeof before]), after: display(value) }));
}
function display(value: unknown) { return typeof value === "object" ? JSON.stringify(value) : String(value); }
