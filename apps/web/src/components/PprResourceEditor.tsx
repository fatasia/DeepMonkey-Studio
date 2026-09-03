import { Plus, Trash2, UsersRound } from "lucide-react";
import type { PprBopVersionDraft, PprCondition, PprOperationResourceAssignment, PprResource } from "@bim-studio/contracts";
import { PprEditorEmpty, PprEntityIdentity } from "./PprPlanEditorShared";
import { addPprResource, addPprResourceAssignment, removePprResource, setPprEntityVariantIds } from "./pprPlanDraftModel";

const RESOURCE_LABELS: Record<PprResource["kind"], string> = {
  station: "工位",
  equipment: "设备",
  robot: "机器人",
  tool: "工具",
  person: "人员",
};

export function PprResourceEditor({ draft, onChange }: { draft: PprBopVersionDraft; onChange: (draft: PprBopVersionDraft) => void }) {
  return (
    <section className="ppr-editor-section" aria-labelledby="ppr-resource-title">
      <header>
        <div>
          <span className="ppr-step-number">3</span>
          <div><h3 id="ppr-resource-title">资源配置</h3><p>定义工位、设备或人员，并分配给实际执行的工序。</p></div>
        </div>
        <button type="button" onClick={() => onChange(addPprResource(draft))}><Plus size={14} />添加资源</button>
      </header>
      {!draft.resources.length && <PprEditorEmpty title="还没有执行资源" description="资源并非保存前必填；添加后会优先关联第一道尚未分配的工序。" />}
      <div className="ppr-entity-stack compact">
        {draft.resources.map((resource) => (
          <article className="ppr-entity-card" key={resource.id}>
            <header><UsersRound size={15} /><strong>{resource.name || "未命名资源"}</strong><code>{resource.id}</code><button className="icon" type="button" aria-label={`删除 ${resource.name || resource.id}`} onClick={() => onChange(removePprResource(draft, resource.id))}><Trash2 size={14} /></button></header>
            <div className="ppr-field-grid three">
              <label><span>名称</span><input value={resource.name} onChange={(event) => onChange(updateResource(draft, resource.id, { name: event.target.value }))} /></label>
              <label><span>类型</span><select value={resource.kind} onChange={(event) => onChange(updateResource(draft, resource.id, { kind: event.target.value as PprResource["kind"] }))}>{Object.entries(RESOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
              <label><span>并行能力</span><input type="number" min={0.01} step={1} value={resource.capacity ?? 1} onChange={(event) => onChange(updateResource(draft, resource.id, { capacity: Number(event.target.value) }))} /></label>
            </div>
            <PprEntityIdentity
              id={resource.id}
              references={resource.references}
              variantIds={resource.variantIds}
              condition={resource.condition}
              onReferencesChange={(references) => onChange(updateResource(draft, resource.id, { references }))}
              onVariantIdsChange={(variantIds) => onChange(setPprEntityVariantIds(draft, "resource", resource.id, variantIds))}
              onConditionChange={(condition) => onChange(updateResourceCondition(draft, resource.id, condition))}
            />
          </article>
        ))}
      </div>
      <section className="ppr-assignment-section">
        <header><div><h4>工序使用资源</h4><p>一条记录表示该工序执行时占用多少资源能力。</p></div><button type="button" disabled={!draft.operations.length || !draft.resources.length} onClick={() => onChange(addPprResourceAssignment(draft))}><Plus size={13} />添加分配</button></header>
        {!draft.resourceAssignments.length && <PprEditorEmpty title="暂无资源分配" description="先添加工序与资源；系统会在可判断时自动建立首条分配。" />}
        <div className="ppr-inline-rows">
          {draft.resourceAssignments.map((assignment) => <AssignmentRow key={assignment.id} draft={draft} assignment={assignment} onChange={onChange} />)}
        </div>
      </section>
    </section>
  );
}

function AssignmentRow({ draft, assignment, onChange }: { draft: PprBopVersionDraft; assignment: PprOperationResourceAssignment; onChange: (draft: PprBopVersionDraft) => void }) {
  return (
    <div className="ppr-inline-row assignment">
      <select aria-label="执行工序" value={assignment.operationId} onChange={(event) => onChange(updateAssignment(draft, assignment.id, { operationId: event.target.value }))}>{draft.operations.map((operation) => <option key={operation.id} value={operation.id}>{operation.name}</option>)}</select>
      <span>使用</span>
      <select aria-label="执行资源" value={assignment.resourceId} onChange={(event) => onChange(updateAssignment(draft, assignment.id, { resourceId: event.target.value }))}>{draft.resources.map((resource) => <option key={resource.id} value={resource.id}>{resource.name}</option>)}</select>
      <input aria-label="占用能力" type="number" min={0.01} step={1} value={assignment.requiredCapacity ?? 1} onChange={(event) => onChange(updateAssignment(draft, assignment.id, { requiredCapacity: Number(event.target.value) }))} />
      <button className="icon" type="button" aria-label="删除资源分配" onClick={() => onChange({ ...draft, resourceAssignments: draft.resourceAssignments.filter((item) => item.id !== assignment.id) })}><Trash2 size={13} /></button>
    </div>
  );
}

function updateResource(draft: PprBopVersionDraft, id: string, patch: Partial<PprResource>): PprBopVersionDraft {
  return { ...draft, resources: draft.resources.map((item) => item.id === id ? { ...item, ...patch } : item) };
}

function updateAssignment(draft: PprBopVersionDraft, id: string, patch: Partial<PprOperationResourceAssignment>): PprBopVersionDraft {
  return { ...draft, resourceAssignments: draft.resourceAssignments.map((item) => item.id === id ? { ...item, ...patch } : item) };
}

function updateResourceCondition(draft: PprBopVersionDraft, id: string, condition: PprCondition | undefined): PprBopVersionDraft {
  return {
    ...draft,
    resources: draft.resources.map((item) => {
      if (item.id !== id) return item;
      if (condition) return { ...item, condition };
      const next = { ...item };
      delete next.condition;
      return next;
    }),
  };
}
