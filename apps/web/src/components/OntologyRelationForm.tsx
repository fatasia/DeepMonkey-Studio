import { Plus, Trash2 } from "lucide-react";
import type { OntologyPackage, OntologyRelationType } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import "./OntologyWorkspace.css";
export function RelationForm({
  value, pkg, locale, onChange,
}: {
  value: OntologyRelationType;
  pkg: OntologyPackage;
  locale: AppLocale;
  onChange: (next: OntologyRelationType) => void;
}) {
  const sourceObject = pkg.objects.find((item) => item.key === value.sourceObject);
  const targetObject = pkg.objects.find((item) => item.key === value.targetObject);
  return (
    <div className="ontology-form">
      <div className="ontology-form-grid">
        <label><span>{tr(locale, "标识 (key)", "Key")}</span><input value={value.key} onChange={(event) => onChange({ ...value, key: event.target.value })} /></label>
        <label><span>{tr(locale, "名称", "Label")}</span><input value={value.label} onChange={(event) => onChange({ ...value, label: event.target.value })} /></label>
        <label><span>{tr(locale, "来源对象", "Source object")}</span>
          <select value={value.sourceObject} onChange={(event) => onChange({ ...value, sourceObject: event.target.value })}>
            {pkg.objects.map((item) => <option key={item.key} value={item.key}>{item.label || item.key}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "目标对象", "Target object")}</span>
          <select value={value.targetObject} onChange={(event) => onChange({ ...value, targetObject: event.target.value })}>
            {pkg.objects.map((item) => <option key={item.key} value={item.key}>{item.label || item.key}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "基数", "Cardinality")}</span>
          <select value={value.cardinality} onChange={(event) => onChange({ ...value, cardinality: event.target.value as OntologyRelationType["cardinality"] })}>
            {["one-to-one", "one-to-many", "many-to-one", "many-to-many"].map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "方向", "Direction")}</span>
          <select value={value.direction} onChange={(event) => onChange({ ...value, direction: event.target.value as OntologyRelationType["direction"] })}>
            <option value="directed">directed</option>
            <option value="undirected">undirected</option>
          </select>
        </label>
        <label><span>{tr(locale, "键映射源字段", "Key mapping source field")}</span>
          <select value={value.keyMapping.sourceField} onChange={(event) => onChange({ ...value, keyMapping: { ...value.keyMapping, sourceField: event.target.value } })}>
            <option value="">{tr(locale, "(选择)", "(select)")}</option>
            {sourceObject?.properties.map((property) => <option key={property.key} value={property.key}>{property.key}</option>)}
          </select>
        </label>
        <label><span>{tr(locale, "键映射目标字段", "Key mapping target field")}</span>
          <select value={value.keyMapping.targetField} onChange={(event) => onChange({ ...value, keyMapping: { ...value.keyMapping, targetField: event.target.value } })}>
            <option value="">{tr(locale, "(选择)", "(select)")}</option>
            {targetObject?.properties.map((property) => <option key={property.key} value={property.key}>{property.key}</option>)}
          </select>
        </label>
      </div>
      <label><span>{tr(locale, "建立理由 (必填,没有理由的边不允许发布)", "Rationale (required; edges without rationale cannot be published)")}</span>
        <input value={value.source.note} onChange={(event) => onChange({ ...value, source: { ...value.source, note: event.target.value } })} />
      </label>
      <fieldset>
        <legend>{tr(locale, "证据 (至少一条)", "Evidence (at least one)")}</legend>
        {value.evidence.length === 0 && <small>{tr(locale, "发布要求关系有证据(门禁 2)", "Publishing requires evidence on relations (gate 2)")}</small>}
        {value.evidence.map((item, index) => (
          <div key={index} className="ontology-binding-row">
            <input value={item.source} aria-label={tr(locale, "证据来源", "Evidence source")} onChange={(event) => onChange({ ...value, evidence: value.evidence.map((entry, entryIndex) => (entryIndex === index ? { ...entry, source: event.target.value } : entry)) })} />
            <input type="number" min={0} value={item.sampleCount ?? ""} placeholder="N" aria-label={tr(locale, "样例数", "Sample count")} onChange={(event) => onChange({ ...value, evidence: value.evidence.map((entry, entryIndex) => (entryIndex === index ? { source: entry.source, recordedAt: entry.recordedAt, ...(event.target.value ? { sampleCount: Number(event.target.value) } : {}) } : entry)) })} />
            <button type="button" className="danger" aria-label={tr(locale, "移除证据", "Remove evidence")} onClick={() => onChange({ ...value, evidence: value.evidence.filter((_, entryIndex) => entryIndex !== index) })}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        <button type="button" onClick={() => onChange({ ...value, evidence: [...value.evidence, { source: "", recordedAt: new Date().toISOString() }] })}>
          <Plus size={12} />
          {tr(locale, "加证据", "Add evidence")}
        </button>
      </fieldset>
    </div>
  );
}

