import { GitBranch, ListPlus, Plus, Trash2, Workflow } from "lucide-react";
import type { PprBopVersionDraft, PprCondition, PprElectronicWorkInstruction, PprOperation, PprOperationComponentRef, PprPrecedenceRelation } from "@bim-studio/contracts";
import { isPprQualityControlComplete } from "@bim-studio/ppr-lite-engine";
import { PprConditionFields, PprEditorEmpty, PprEntityIdentity } from "./PprPlanEditorShared";
import { PprWorkInstructionEditor } from "./PprWorkInstructionEditor";
import {
  addPprOperation,
  addPprOperationComponentRef,
  addPprPrecedenceRelation,
  removePprOperation,
  setPprEntityVariantIds,
  setPprPrecedenceRelationCondition,
} from "./pprPlanDraftModel";

const ROLE_LABELS: Record<PprOperationComponentRef["role"], string> = {
  input: "投入",
  "in-process": "加工中",
  output: "产出",
};

export function PprOperationEditor({
  draft,
  onChange,
}: {
  draft: PprBopVersionDraft;
  onChange: (draft: PprBopVersionDraft) => void;
}) {
  return (
    <section className="ppr-editor-section" aria-labelledby="ppr-operation-title">
      <header>
        <div>
          <span className="ppr-step-number">2</span>
          <div><h3 id="ppr-operation-title">工序安排</h3><p>设置顺序与工时；需要现场指导的工序可按需编制 EWI。</p></div>
        </div>
        <button className={draft.components.length > 0 && !draft.operations.length ? "primary" : undefined} type="button" disabled={!draft.components.length} onClick={() => onChange(addPprOperation(draft))}><ListPlus size={14} />添加工序</button>
      </header>
      {!draft.components.length && <PprEditorEmpty title="先完成产品结构" description="工序必须指向实际产品或零部件，避免形成悬空计划。" />}
      {draft.components.length > 0 && !draft.operations.length && <PprEditorEmpty title="还没有工序" description="点击“添加工序”，再设置名称、标准工时和物料角色。" />}
      <div className="ppr-entity-stack">
        {draft.operations.map((operation, operationIndex) => (
          <article className="ppr-entity-card" key={operation.id}>
            <header><span className="ppr-sequence">{operationIndex + 1}</span><strong>{operation.name || "未命名工序"}</strong><OperationQualityStatus operation={operation} /><code>{operation.id}</code><button className="icon" type="button" aria-label={`删除 ${operation.name || operation.id}`} onClick={() => onChange(removePprOperation(draft, operation.id))}><Trash2 size={14} /></button></header>
            <div className="ppr-field-grid two">
              <label><span>工序名称</span><input value={operation.name} onChange={(event) => onChange(updateOperation(draft, operation.id, { name: event.target.value }))} /></label>
              <label><span>标准工时（分钟）</span><input type="number" min={0.01} step={0.1} value={operation.standardTimeMinutes} onChange={(event) => onChange(updateOperation(draft, operation.id, { standardTimeMinutes: Number(event.target.value) }))} /></label>
            </div>
            <div className="ppr-subsection-heading"><span><Workflow size={13} />物料角色</span><button type="button" disabled={!canAddReference(draft, operation)} onClick={() => onChange(addPprOperationComponentRef(draft, operation.id))}><Plus size={13} />添加</button></div>
            <div className="ppr-inline-rows">
              {operation.componentRefs.map((reference, referenceIndex) => (
                <div className="ppr-inline-row component" key={`${reference.componentId}-${reference.role}-${referenceIndex}`}>
                  <select aria-label="产品或零部件" value={reference.componentId} onChange={(event) => onChange(updateOperationReference(draft, operation.id, referenceIndex, { componentId: event.target.value }))}>{draft.components.map((component) => <option key={component.id} value={component.id}>{component.name}</option>)}</select>
                  <select aria-label="物料角色" value={reference.role} onChange={(event) => onChange(updateOperationReference(draft, operation.id, referenceIndex, { role: event.target.value as PprOperationComponentRef["role"] }))}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
                  <input aria-label="数量" type="number" min={0.01} step={1} value={reference.quantity ?? 1} onChange={(event) => onChange(updateOperationReference(draft, operation.id, referenceIndex, { quantity: Number(event.target.value) }))} />
                  <button className="icon" type="button" aria-label="移除物料角色" onClick={() => onChange(removeOperationReference(draft, operation.id, referenceIndex))}><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
            <PprWorkInstructionEditor
              operation={operation}
              planReferences={draft.references}
              onChange={(workInstruction) => onChange(updateOperationWorkInstruction(draft, operation.id, workInstruction))}
            />
            <PprEntityIdentity
              id={operation.id}
              references={operation.references}
              variantIds={operation.variantIds}
              condition={operation.condition}
              onReferencesChange={(references) => onChange(updateOperation(draft, operation.id, { references }))}
              onVariantIdsChange={(variantIds) => onChange(setPprEntityVariantIds(draft, "operation", operation.id, variantIds))}
              onConditionChange={(condition) => onChange(updateOperationCondition(draft, operation.id, condition))}
            />
          </article>
        ))}
      </div>
      {draft.operations.length > 1 && (
        <details className="ppr-dependency-editor">
          <summary><span><GitBranch size={14} />高级：工序依赖</span><small>{draft.precedenceRelations.length} 条关系</small></summary>
          <p>默认按新增顺序串接；只有并行、汇合或等待时间变化时才需要调整。</p>
          <div className="ppr-inline-rows">
            {draft.precedenceRelations.map((relation) => <DependencyRow key={relation.id} draft={draft} relation={relation} onChange={onChange} />)}
          </div>
          <button type="button" onClick={() => onChange(addPprPrecedenceRelation(draft))}><Plus size={13} />添加依赖</button>
        </details>
      )}
    </section>
  );
}

function OperationQualityStatus({ operation }: { operation: PprOperation }) {
  const checks = operation.workInstruction?.qualityChecks ?? [];
  if (!checks.length) return <span className="ppr-operation-quality missing" title="该工序尚未定义质量特性、检测频率和失控反应">缺质量定义</span>;
  const complete = checks.filter(isPprQualityControlComplete).length;
  if (complete === checks.length) return <span className="ppr-operation-quality complete" title={`${checks.length} 个质量控制点定义完整`}>{checks.length} 个控制点</span>;
  return <span className="ppr-operation-quality incomplete" title={`${complete}/${checks.length} 个质量控制点定义完整`}>{complete}/{checks.length} 已完整</span>;
}

function DependencyRow({ draft, relation, onChange }: { draft: PprBopVersionDraft; relation: PprPrecedenceRelation; onChange: (draft: PprBopVersionDraft) => void }) {
  return (
    <div className="ppr-dependency-item">
      <div className="ppr-inline-row dependency">
        <select aria-label="前一道工序" value={relation.predecessorOperationId} onChange={(event) => onChange(updateRelation(draft, relation.id, { predecessorOperationId: event.target.value }))}>{draft.operations.filter((operation) => operation.id !== relation.successorOperationId).map((operation) => <option key={operation.id} value={operation.id}>{operation.name}</option>)}</select>
        <span>之后</span>
        <select aria-label="后一道工序" value={relation.successorOperationId} onChange={(event) => onChange(updateRelation(draft, relation.id, { successorOperationId: event.target.value }))}>{draft.operations.filter((operation) => operation.id !== relation.predecessorOperationId).map((operation) => <option key={operation.id} value={operation.id}>{operation.name}</option>)}</select>
        <input aria-label="等待分钟" type="number" min={0} step={0.1} value={relation.minimumLagMinutes ?? 0} onChange={(event) => onChange(updateRelation(draft, relation.id, { minimumLagMinutes: Number(event.target.value) }))} />
        <button className="icon" type="button" aria-label="删除工序依赖" onClick={() => onChange({ ...draft, precedenceRelations: draft.precedenceRelations.filter((item) => item.id !== relation.id) })}><Trash2 size={13} /></button>
      </div>
      <details className="ppr-dependency-condition">
        <summary><span>条件前置关系</span><small>{relation.condition?.expression || "始终生效"}</small></summary>
        <div className="ppr-applicability-fields">
          <PprConditionFields
            condition={relation.condition}
            expressionLabel="关系适用条件表达式"
            descriptionLabel="关系条件说明"
            onConditionChange={(condition) => onChange(setPprPrecedenceRelationCondition(draft, relation.id, condition))}
          />
          <small>仅在所描述的变体或工况下应用这条依赖；Lite 引擎负责校验并记录表达式，不执行表达式。</small>
        </div>
      </details>
    </div>
  );
}

function canAddReference(draft: PprBopVersionDraft, operation: PprOperation) {
  return draft.components.some((component) => !operation.componentRefs.some((reference) => reference.componentId === component.id && reference.role === "in-process"));
}

function updateOperation(draft: PprBopVersionDraft, id: string, patch: Partial<PprOperation>): PprBopVersionDraft {
  return { ...draft, operations: draft.operations.map((item) => item.id === id ? { ...item, ...patch } : item) };
}

function updateOperationWorkInstruction(draft: PprBopVersionDraft, id: string, workInstruction: PprElectronicWorkInstruction | undefined): PprBopVersionDraft {
  return {
    ...draft,
    operations: draft.operations.map((item) => {
      if (item.id !== id) return item;
      if (workInstruction) return { ...item, workInstruction };
      const next = { ...item };
      delete next.workInstruction;
      return next;
    }),
  };
}

function updateOperationCondition(draft: PprBopVersionDraft, id: string, condition: PprCondition | undefined): PprBopVersionDraft {
  return {
    ...draft,
    operations: draft.operations.map((item) => {
      if (item.id !== id) return item;
      if (condition) return { ...item, condition };
      const next = { ...item };
      delete next.condition;
      return next;
    }),
  };
}

function updateOperationReference(draft: PprBopVersionDraft, operationId: string, index: number, patch: Partial<PprOperationComponentRef>): PprBopVersionDraft {
  const operation = draft.operations.find((item) => item.id === operationId);
  if (!operation) return draft;
  return updateOperation(draft, operationId, { componentRefs: operation.componentRefs.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item) });
}

function removeOperationReference(draft: PprBopVersionDraft, operationId: string, index: number): PprBopVersionDraft {
  const operation = draft.operations.find((item) => item.id === operationId);
  return operation ? updateOperation(draft, operationId, { componentRefs: operation.componentRefs.filter((_, itemIndex) => itemIndex !== index) }) : draft;
}

function updateRelation(draft: PprBopVersionDraft, id: string, patch: Partial<PprPrecedenceRelation>): PprBopVersionDraft {
  return { ...draft, precedenceRelations: draft.precedenceRelations.map((item) => item.id === id ? { ...item, ...patch } : item) };
}
