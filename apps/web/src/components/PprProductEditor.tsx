import { Box, PackagePlus, Plus, Trash2 } from "lucide-react";
import type { PprBopVersionDraft, PprComponent, PprCondition } from "@bim-studio/contracts";
import { PprEditorEmpty, PprEntityIdentity } from "./PprPlanEditorShared";
import { addPprComponent, availablePprParents, removePprComponent, setPprEntityVariantIds } from "./pprPlanDraftModel";

export function PprProductEditor({
  draft,
  onChange,
}: {
  draft: PprBopVersionDraft;
  onChange: (draft: PprBopVersionDraft) => void;
}) {
  return (
    <section className="ppr-editor-section" aria-labelledby="ppr-product-title">
      <header>
        <div>
          <span className="ppr-step-number">1</span>
          <div><h3 id="ppr-product-title">产品结构</h3><p>先列出最终产品和组成零部件，系统会保留父子层级。</p></div>
        </div>
        <div className="ppr-section-actions">
          <button className={!draft.components.length ? "primary" : undefined} type="button" onClick={() => onChange(addPprComponent(draft, "product"))}><PackagePlus size={14} />添加产品</button>
          <button type="button" disabled={!draft.components.some((item) => item.kind === "product")} onClick={() => onChange(addPprComponent(draft, "part"))}><Plus size={14} />添加零部件</button>
        </div>
      </header>
      {!draft.components.length && <PprEditorEmpty title="还没有产品结构" description="从“添加产品”开始；零部件随后可挂到产品或子总成下。" />}
      <div className="ppr-entity-stack">
        {draft.components.map((component) => (
          <article className="ppr-entity-card" key={component.id}>
            <header><Box size={15} /><strong>{component.name || "未命名节点"}</strong><code>{component.id}</code><button className="icon" type="button" aria-label={`删除 ${component.name || component.id}`} onClick={() => onChange(removePprComponent(draft, component.id))}><Trash2 size={14} /></button></header>
            <div className="ppr-field-grid three">
              <label><span>名称</span><input value={component.name} onChange={(event) => onChange(updateComponent(draft, component.id, { name: event.target.value }))} /></label>
              <label><span>类型</span><select value={component.kind} onChange={(event) => onChange(updateComponent(draft, component.id, { kind: event.target.value as PprComponent["kind"] }))}><option value="product">产品 / 子总成</option><option value="part">零部件</option></select></label>
              <label><span>上级</span><select value={component.parentComponentId ?? ""} onChange={(event) => onChange(updateParent(draft, component.id, event.target.value))}><option value="">根节点</option>{availablePprParents(draft, component.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label>
            </div>
            <PprEntityIdentity
              id={component.id}
              references={component.references}
              variantIds={component.variantIds}
              condition={component.condition}
              onReferencesChange={(references) => onChange(updateComponent(draft, component.id, { references }))}
              onVariantIdsChange={(variantIds) => onChange(setPprEntityVariantIds(draft, "component", component.id, variantIds))}
              onConditionChange={(condition) => onChange(updateComponentCondition(draft, component.id, condition))}
            />
          </article>
        ))}
      </div>
    </section>
  );
}

function updateComponent(draft: PprBopVersionDraft, id: string, patch: Partial<PprComponent>): PprBopVersionDraft {
  return { ...draft, components: draft.components.map((item) => item.id === id ? { ...item, ...patch } : item) };
}

function updateParent(draft: PprBopVersionDraft, id: string, parentComponentId: string): PprBopVersionDraft {
  return {
    ...draft,
    components: draft.components.map((item) => {
      if (item.id !== id) return item;
      const next = { ...item };
      if (parentComponentId) next.parentComponentId = parentComponentId;
      else delete next.parentComponentId;
      return next;
    }),
  };
}

function updateComponentCondition(draft: PprBopVersionDraft, id: string, condition: PprCondition | undefined): PprBopVersionDraft {
  return {
    ...draft,
    components: draft.components.map((item) => {
      if (item.id !== id) return item;
      if (condition) return { ...item, condition };
      const next = { ...item };
      delete next.condition;
      return next;
    }),
  };
}
