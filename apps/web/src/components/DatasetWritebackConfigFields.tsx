import { Plus, Trash2 } from "lucide-react";
import { assertDataWritebackConfig, type DataWritebackConfig, type DataWritebackField } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import "./DatasetWritebackConfigFields.css";

type FieldDraft = { key: string; type: DataWritebackField["type"]; required: boolean; min: string; max: string; maxLength: string; options: string };
export type WritebackConfigDraft = { enabled: boolean; recordPath: string; fields: FieldDraft[] };
const blankField = (): FieldDraft => ({ key: "", type: "string", required: false, min: "", max: "", maxLength: "", options: "" });
export function createWritebackConfigDraft(initial?: DataWritebackConfig): WritebackConfigDraft {
  return { enabled: Boolean(initial), recordPath: initial?.recordPath ?? "/records/{id}", fields: initial?.fields.map(field => ({ key: field.key, type: field.type, required: field.required ?? false, min: field.min?.toString() ?? "", max: field.max?.toString() ?? "", maxLength: field.maxLength?.toString() ?? "", options: field.options?.map(value => value === null ? "null" : String(value)).join("\n") ?? "" })) ?? [blankField()] };
}
export function writebackConfigChange(initial: DataWritebackConfig | undefined, draft: WritebackConfigDraft): { writeback?: DataWritebackConfig | null; error?: string } {
  if (JSON.stringify(draft) === JSON.stringify(createWritebackConfigDraft(initial))) return {};
  if (!draft.enabled) return initial ? { writeback: null } : {};
  try {
    const fields = draft.fields.map(field => {
      const previous = initial?.fields.find(item => item.key === field.key && item.type === field.type);
      const unchangedOptions = previous?.options?.map(value => value === null ? "null" : String(value)).join("\n") === field.options;
      const options = unchangedOptions ? previous?.options ?? [] : field.options.split("\n").map(value => value.trim()).filter(Boolean).map(value => {
        if (value === "null" && (field.type === "number" || field.type === "boolean")) return null;
        if (field.type === "number") return Number(value);
        if (field.type === "boolean") {
          if (value !== "true" && value !== "false") throw new Error("布尔选项只能是 true 或 false");
          return value === "true";
        }
        return value;
      });
      return { key: field.key.trim(), type: field.type, ...(field.required ? { required: true } : {}), ...(field.min.trim() ? { min: Number(field.min) } : {}), ...(field.max.trim() ? { max: Number(field.max) } : {}), ...(field.maxLength.trim() ? { maxLength: Number(field.maxLength) } : {}), ...(options.length ? { options } : {}) };
    });
    const config = { version: 1, recordPath: draft.recordPath.trim(), fields };
    assertDataWritebackConfig(config);
    return { writeback: config };
  } catch (error) { return { error: error instanceof Error ? error.message : "填报配置无效" }; }
}

export function DatasetWritebackConfigFields({ locale, draft, disabled = false, onChange }: { locale: AppLocale; draft: WritebackConfigDraft; disabled?: boolean; onChange(value: WritebackConfigDraft): void }) {
  const update = (index: number, patch: Partial<FieldDraft>) => onChange({ ...draft, fields: draft.fields.map((field, i) => i === index ? { ...field, ...patch } : field) });
  const title = tr(locale, "填报配置", "Writeback settings");
  return <section className="dataset-writeback-config" aria-label={title}>
    <label className="dataset-writeback-switch" title={tr(locale, "数据源须支持强 ETag 与 If-Match 条件更新", "The data source must support strong ETags and If-Match updates")}>
      <input type="checkbox" disabled={disabled} checked={draft.enabled} onChange={event => onChange({ ...draft, enabled: event.target.checked })} />
      <span>{tr(locale, "启用填报", "Enable writeback")}</span>
    </label>
    {draft.enabled && <fieldset disabled={disabled}>
      <label><span>{tr(locale, "记录路径", "Record path")}</span><input aria-label={tr(locale, "填报记录路径", "Writeback record path")} value={draft.recordPath} spellCheck={false} onChange={event => onChange({ ...draft, recordPath: event.target.value })} placeholder="/records/{id}" title={tr(locale, "使用当前连接域名，{id} 替换为记录标识", "Uses the current connection origin; {id} is replaced by the record ID")} /></label>
      {draft.fields.map((field, index) => <article key={index}>
        <div className="dataset-writeback-field-heading">
          <label><span>{tr(locale, "字段", "Field")}</span><input aria-label={`${tr(locale, "填报字段", "Writeback field")} ${index + 1}`} value={field.key} onChange={event => update(index, { key: event.target.value })} /></label>
          <label><span>{tr(locale, "类型", "Type")}</span><select aria-label={`${tr(locale, "字段类型", "Field type")} ${index + 1}`} value={field.type} onChange={event => update(index, { type: event.target.value as FieldDraft["type"], min: "", max: "", maxLength: "", options: "" })}>
            <option value="string">{tr(locale, "文本", "Text")}</option><option value="number">{tr(locale, "数值", "Number")}</option><option value="boolean">{tr(locale, "布尔", "Boolean")}</option><option value="date">{tr(locale, "日期", "Date")}</option>
          </select></label>
          <button type="button" title={tr(locale, "删除填报字段", "Remove writeback field")} aria-label={`${tr(locale, "删除填报字段", "Remove writeback field")} ${index + 1}`} onClick={() => onChange({ ...draft, fields: draft.fields.filter((_, i) => i !== index) })}><Trash2 size={14} /></button>
        </div>
        <details><summary>{tr(locale, "校验规则", "Validation")}</summary>
          <label className="dataset-writeback-switch"><input type="checkbox" checked={field.required} onChange={event => update(index, { required: event.target.checked })} /><span>{tr(locale, "必填", "Required")}</span></label>
          {field.type === "number" && <div className="dataset-writeback-bounds">{(["min", "max"] as const).map(key => <label key={key}><span>{key === "min" ? tr(locale, "最小值", "Minimum") : tr(locale, "最大值", "Maximum")}</span><input type="text" inputMode="decimal" aria-label={`${tr(locale, "字段", "Field")} ${index + 1} ${key === "min" ? tr(locale, "最小值", "Minimum") : tr(locale, "最大值", "Maximum")}`} value={field[key]} onChange={event => update(index, { [key]: event.target.value })} /></label>)}</div>}
          {field.type === "string" && <label><span>{tr(locale, "最大长度", "Maximum length")}</span><input type="text" inputMode="numeric" value={field.maxLength} onChange={event => update(index, { maxLength: event.target.value })} placeholder="4096" /></label>}
          <label><span>{tr(locale, "可选值", "Allowed values")}</span><textarea value={field.options} onChange={event => update(index, { options: event.target.value })} title={tr(locale, "每行一个值；留空不限制。布尔值使用 true / false", "One value per line; blank means unrestricted. Use true / false for booleans")} rows={2} /></label>
        </details>
      </article>)}
      <button type="button" className="dataset-writeback-add" disabled={draft.fields.length >= 32} title={tr(locale, "最多 32 个字段", "Up to 32 fields")} onClick={() => onChange({ ...draft, fields: [...draft.fields, blankField()] })}><Plus size={14} />{tr(locale, "添加字段", "Add field")}</button>
    </fieldset>}
  </section>;
}
