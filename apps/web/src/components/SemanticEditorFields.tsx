import type { DataDatasetField } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { semanticFormulaEvidence } from "./semanticModelEditorLogic";

export function SemanticFieldSelect({
  label,
  value,
  fields,
  onChange,
  locale,
}: {
  label: string;
  value: string;
  fields: readonly DataDatasetField[];
  onChange: (value: string) => void;
  locale: AppLocale;
}) {
  const missing = Boolean(
    value && !fields.some((field) => field.key === value),
  );
  return (
    <label>
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        aria-invalid={missing}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{tr(locale, "选择字段", "Choose a field")}</option>
        {missing && (
          <option value={value}>
            {value} · {tr(locale, "已失效", "Unavailable")}
          </option>
        )}
        {fields.map((field) => (
          <option key={field.key} value={field.key}>
            {field.label} · {field.key}
          </option>
        ))}
      </select>
      {missing && (
        <small role="alert">
          {tr(
            locale,
            "原字段不在当前来源中，请重新选择。",
            "The original field is absent from this source. Choose again.",
          )}
        </small>
      )}
    </label>
  );
}

export function SemanticExpressionEditor({
  value,
  fields,
  onChange,
  locale,
}: {
  value: string;
  fields: readonly DataDatasetField[];
  onChange: (value: string) => void;
  locale: AppLocale;
}) {
  const evidence = value.trim()
    ? semanticFormulaEvidence(value, fields)
    : { error: "", dependencies: [] };
  return (
    <div className="semantic-expression">
      <label>
        <span>{tr(locale, "指标表达式", "Metric expression")}</span>
        <textarea
          aria-label={tr(locale, "指标表达式", "Metric expression")}
          spellCheck={false}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="ROUND(amount * price, 2)"
          aria-invalid={Boolean(evidence.error)}
        />
      </label>
      {evidence.error ? (
        <small role="alert">{evidence.error}</small>
      ) : (
        <small>
          {tr(locale, "依赖字段：", "Dependencies: ")}
          {evidence.dependencies.join(", ") || "—"}
        </small>
      )}
      <div
        className="semantic-field-chips"
        aria-label={tr(locale, "插入表达式字段", "Insert expression field")}
      >
        {fields.map((field) => (
          <button
            type="button"
            key={field.key}
            title={`${field.key} · ${field.type}`}
            onClick={() =>
              onChange(
                value + (value && !/\s$/.test(value) ? " " : "") + field.key,
              )
            }
          >
            {field.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function SemanticIdentityFields({
  value,
  onChange,
  locale,
}: {
  value: { key: string; label: string };
  onChange: (patch: { key?: string; label?: string }) => void;
  locale: AppLocale;
}) {
  return (
    <div className="semantic-form-grid">
      <label>
        <span>{tr(locale, "标识", "Key")}</span>
        <input
          aria-label={tr(locale, "标识", "Key")}
          value={value.key}
          onChange={(event) => onChange({ key: event.target.value })}
          placeholder="production_total"
        />
      </label>
      <label>
        <span>{tr(locale, "名称", "Name")}</span>
        <input
          aria-label={tr(locale, "名称", "Name")}
          value={value.label}
          onChange={(event) => onChange({ label: event.target.value })}
        />
      </label>
    </div>
  );
}
