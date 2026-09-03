import { Plus, Trash2 } from "lucide-react";
import type { PprCondition, PprExternalReference } from "@bim-studio/contracts";

const REFERENCE_LABELS: Record<PprExternalReference["kind"], string> = {
  scene: "场景",
  object: "对象",
  script: "脚本",
  study: "运行记录",
};

export function PprEntityIdentity({
  id,
  references,
  variantIds,
  condition,
  onReferencesChange,
  onVariantIdsChange,
  onConditionChange,
}: {
  id: string;
  references?: PprExternalReference[] | undefined;
  variantIds?: string[] | undefined;
  condition?: PprCondition | undefined;
  onReferencesChange: (references: PprExternalReference[]) => void;
  onVariantIdsChange: (variantIds: string[]) => void;
  onConditionChange: (condition: PprCondition | undefined) => void;
}) {
  return (
    <details className="ppr-advanced-meta">
      <summary>高级标识与引用</summary>
      <dl><div><dt>稳定 ID</dt><dd><code>{id}</code></dd></div></dl>
      <PprApplicabilityFields variantIds={variantIds} condition={condition} onVariantIdsChange={onVariantIdsChange} onConditionChange={onConditionChange} />
      <div className="ppr-reference-heading"><span>外部引用</span><button type="button" onClick={() => onReferencesChange([...(references ?? []), { kind: "object", id: "" }])}><Plus size={12} />添加</button></div>
      <div className="ppr-reference-rows">
        {references?.map((reference, index) => (
          <div key={`${reference.kind}-${index}`}>
            <select aria-label="引用类型" value={reference.kind} onChange={(event) => onReferencesChange(updateReference(references, index, { kind: event.target.value as PprExternalReference["kind"] }))}>{Object.entries(REFERENCE_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select>
            <input aria-label="引用 ID" value={reference.id} placeholder="输入现有 ID" onChange={(event) => onReferencesChange(updateReference(references, index, { id: event.target.value }))} />
            <button className="icon" type="button" aria-label="删除外部引用" onClick={() => onReferencesChange(references.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={12} /></button>
          </div>
        ))}
        {!references?.length && <small>无；仅在需要追溯场景、对象、脚本或运行记录时添加。</small>}
      </div>
    </details>
  );
}

export function PprApplicabilityFields({ variantIds, condition, onVariantIdsChange, onConditionChange }: {
  variantIds?: string[] | undefined;
  condition?: PprCondition | undefined;
  onVariantIdsChange: (variantIds: string[]) => void;
  onConditionChange: (condition: PprCondition | undefined) => void;
}) {
  return <div className="ppr-applicability-fields">
    <label className="ppr-variant-field"><span>适用变体 ID</span><input value={variantIds?.join(", ") ?? ""} placeholder="留空表示全部；多个用逗号分隔" onChange={(event) => onVariantIdsChange(splitIds(event.target.value))} /></label>
    <PprConditionFields condition={condition} onConditionChange={onConditionChange} />
    <small>变体与条件会进入版本和影响比较；Lite 引擎不执行条件表达式。</small>
  </div>;
}

export function PprConditionFields({
  condition,
  onConditionChange,
  expressionLabel = "适用条件表达式",
  descriptionLabel = "条件说明",
}: {
  condition?: PprCondition | undefined;
  onConditionChange: (condition: PprCondition | undefined) => void;
  expressionLabel?: string;
  descriptionLabel?: string;
}) {
  return <>
    <label><span>{expressionLabel}</span><input value={condition?.expression ?? ""} placeholder="例如 market == 'EU'（仅记录，不执行）" onChange={(event) => onConditionChange(withConditionExpression(condition, event.target.value))} /></label>
    {condition && <label><span>{descriptionLabel}</span><input value={condition.description ?? ""} placeholder="说明适用范围与判定依据" onChange={(event) => onConditionChange(withConditionDescription(condition, event.target.value))} /></label>}
  </>;
}

function updateReference(references: PprExternalReference[], index: number, patch: Partial<PprExternalReference>): PprExternalReference[] {
  return references.map((reference, itemIndex) => itemIndex === index ? { ...reference, ...patch } : reference);
}

function splitIds(value: string): string[] {
  return [...new Set(value.split(/[,，]/).map((item) => item.trim()).filter(Boolean))];
}

function withConditionExpression(condition: PprCondition | undefined, expression: string): PprCondition | undefined {
  if (!expression.trim()) return undefined;
  return { ...(condition ?? {}), expression };
}

function withConditionDescription(condition: PprCondition, description: string): PprCondition {
  const next = { ...condition };
  if (description.trim()) next.description = description;
  else delete next.description;
  return next;
}

export function PprEditorEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="ppr-editor-empty">
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  );
}
