import { Plus, Trash2 } from "lucide-react";
import type { DashboardConditionalRule } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export interface DashboardConditionalRulesEditorProps {
  locale: AppLocale;
  value: readonly DashboardConditionalRule[];
  onChange: (rules: DashboardConditionalRule[]) => void;
}

const OPERATOR_LABELS: Array<{ value: DashboardConditionalRule["operator"]; zh: string; en: string }> = [
  { value: "eq", zh: "等于", en: "Equals" },
  { value: "ne", zh: "不等于", en: "Not equal" },
  { value: "gt", zh: "大于", en: "Greater than" },
  { value: "gte", zh: "大于等于", en: "At least" },
  { value: "lt", zh: "小于", en: "Less than" },
  { value: "lte", zh: "小于等于", en: "At most" },
  { value: "contains", zh: "包含", en: "Contains" },
  { value: "between", zh: "介于", en: "Between" },
];

export function createDashboardConditionalRule(rules: readonly DashboardConditionalRule[]): DashboardConditionalRule {
  const ids = new Set(rules.map((rule) => rule.id));
  let index = rules.length + 1;
  while (ids.has(`rule-${index}`)) index += 1;
  return { id: `rule-${index}`, field: "", operator: "gte", value: 0, color: "#ff6b6b" };
}

export function parseDashboardConditionalValue(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  const numeric = Number(trimmed);
  return trimmed !== "" && Number.isFinite(numeric) ? numeric : value;
}

export function updateDashboardConditionalRule(rules: readonly DashboardConditionalRule[], id: string, patch: Partial<DashboardConditionalRule>): DashboardConditionalRule[] {
  return rules.map((rule) => (rule.id === id ? { ...rule, ...patch, id: rule.id } : rule));
}

export function DashboardConditionalRulesEditor({ locale, value, onChange }: DashboardConditionalRulesEditorProps) {
  function update(id: string, patch: Partial<DashboardConditionalRule>) {
    onChange(updateDashboardConditionalRule(value, id, patch));
  }

  return (
    <section className="dashboard-conditional-editor" aria-label={tr(locale, "条件格式", "Conditional formatting")}>
      <header>
        <span>
          <strong>{tr(locale, "条件格式", "Conditional formatting")}</strong>
          <small>{tr(locale, "从上到下匹配，首条命中规则生效", "Rules are evaluated top to bottom; the first match wins")}</small>
        </span>
        <button type="button" onClick={() => onChange([...value, createDashboardConditionalRule(value)])}>
          <Plus size={12} />
          {tr(locale, "添加规则", "Add rule")}
        </button>
      </header>
      {value.length === 0 && (
        <div className="dashboard-conditional-empty">
          {tr(
            locale,
            "尚未设置规则。可按当前值或数据字段控制颜色、字重、显隐与脉冲提醒。",
            "No rules yet. Style the current value or a data field with color, weight, visibility, and pulse alerts.",
          )}
        </div>
      )}
      {value.map((rule, index) => (
        <article className="dashboard-conditional-rule" key={rule.id}>
          <header>
            <strong>{tr(locale, `规则 ${index + 1}`, `Rule ${index + 1}`)}</strong>
            <button
              type="button"
              aria-label={tr(locale, `删除规则 ${index + 1}`, `Delete rule ${index + 1}`)}
              title={tr(locale, "删除规则", "Delete rule")}
              onClick={() => onChange(value.filter((item) => item.id !== rule.id))}
            >
              <Trash2 size={12} />
            </button>
          </header>
          <div className="dashboard-conditional-condition-grid">
            <label>
              <span>{tr(locale, "字段", "Field")}</span>
              <input
                value={rule.field ?? ""}
                placeholder={tr(locale, "留空 = 当前值", "Blank = current value")}
                onChange={(event) => update(rule.id, { field: event.target.value })}
              />
            </label>
            <label>
              <span>{tr(locale, "关系", "Operator")}</span>
              <select value={rule.operator} onChange={(event) => update(rule.id, { operator: event.target.value as DashboardConditionalRule["operator"] })}>
                {OPERATOR_LABELS.map((operator) => (
                  <option key={operator.value} value={operator.value}>
                    {tr(locale, operator.zh, operator.en)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{tr(locale, "比较值", "Value")}</span>
              <input
                value={String(rule.value)}
                onChange={(event) => update(rule.id, { value: event.target.value })}
                onBlur={(event) => update(rule.id, { value: parseDashboardConditionalValue(event.currentTarget.value) })}
              />
            </label>
            {rule.operator === "between" && (
              <label>
                <span>{tr(locale, "上限", "Upper bound")}</span>
                <input type="number" value={rule.valueTo ?? (Number(rule.value) || 0)} onChange={(event) => update(rule.id, { valueTo: Number(event.target.value) })} />
              </label>
            )}
          </div>
          <div className="dashboard-conditional-effects">
            <label>
              <input type="checkbox" checked={Boolean(rule.color)} onChange={(event) => update(rule.id, { color: event.target.checked ? "#ff6b6b" : "" })} />
              {tr(locale, "文字", "Text")}
              <input
                aria-label={tr(locale, "文字颜色", "Text color")}
                type="color"
                disabled={!rule.color}
                value={rule.color || "#ff6b6b"}
                onChange={(event) => update(rule.id, { color: event.target.value })}
              />
            </label>
            <label>
              <input type="checkbox" checked={Boolean(rule.backgroundColor)} onChange={(event) => update(rule.id, { backgroundColor: event.target.checked ? "#5b2028" : "" })} />
              {tr(locale, "背景", "Background")}
              <input
                aria-label={tr(locale, "背景颜色", "Background color")}
                type="color"
                disabled={!rule.backgroundColor}
                value={rule.backgroundColor || "#5b2028"}
                onChange={(event) => update(rule.id, { backgroundColor: event.target.value })}
              />
            </label>
            <label>
              <input type="checkbox" checked={(rule.fontWeight ?? 400) >= 700} onChange={(event) => update(rule.id, { fontWeight: event.target.checked ? 700 : 400 })} />
              {tr(locale, "粗体", "Bold")}
            </label>
            <label>
              <input type="checkbox" checked={rule.visible === false} onChange={(event) => update(rule.id, { visible: event.target.checked ? false : true })} />
              {tr(locale, "隐藏", "Hide")}
            </label>
            <label>
              <input type="checkbox" checked={rule.animation === "pulse"} onChange={(event) => update(rule.id, { animation: event.target.checked ? "pulse" : "none" })} />
              {tr(locale, "脉冲", "Pulse")}
            </label>
          </div>
        </article>
      ))}
    </section>
  );
}
