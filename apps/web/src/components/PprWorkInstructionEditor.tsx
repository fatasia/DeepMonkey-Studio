import { BookOpenCheck, Image, Plus, ShieldAlert, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type {
  PprElectronicWorkInstruction,
  PprExternalReference,
  PprOperation,
} from "@bim-studio/contracts";
import {
  availablePprVisualReferences,
  createPprWorkInstruction,
  nextPprInstructionItemId,
  togglePprVisualReference,
} from "./pprWorkInstructionDraft";
import { PprQualityControlEditor } from "./PprQualityControlEditor";
import "./PprWorkInstructions.css";

export function PprWorkInstructionEditor({
  operation,
  planReferences,
  onChange,
}: {
  operation: PprOperation;
  planReferences: PprExternalReference[] | undefined;
  onChange: (instruction: PprElectronicWorkInstruction | undefined) => void;
}) {
  const instruction = operation.workInstruction;
  const visualReferences = availablePprVisualReferences(planReferences, operation.references, instruction?.visualReferences);
  if (!instruction) {
    return (
      <div className="ppr-ewi-enable">
        <span><BookOpenCheck size={15} /><span><strong>电子作业指导书（EWI）与质量控制</strong><small>EWI 可选；质量要求会随所属工序版本化并参与就绪检查。</small></span></span>
        <button type="button" onClick={() => onChange(createPprWorkInstruction(planReferences, operation.references))}><Plus size={13} />开始编制</button>
      </div>
    );
  }

  return (
    <section className="ppr-ewi-editor" aria-label={`${operation.name || operation.id} 电子作业指导书`}>
      <header>
        <span><BookOpenCheck size={15} /><span><strong>电子作业指导书（EWI）与质量控制</strong><small>{instruction.steps.length} 步 · {instruction.safetyNotes.length} 安全注意 · {instruction.qualityChecks.length} 控制点</small></span></span>
        <button className="icon" type="button" aria-label="移除电子作业指导书" title="移除该工序的作业指导书" onClick={() => onChange(undefined)}><Trash2 size={13} /></button>
      </header>

      <InstructionGroup
        icon={<BookOpenCheck size={13} />}
        title="操作步骤"
        hint="按现场执行顺序填写"
        onAdd={() => onChange({
          ...instruction,
          steps: [...instruction.steps, { id: nextPprInstructionItemId(instruction, "step"), instruction: "" }],
        })}
      >
        {instruction.steps.map((step, index) => (
          <div className="ppr-ewi-row step" key={step.id}>
            <span>{index + 1}</span>
            <textarea rows={2} aria-label={`步骤 ${index + 1} 操作说明`} value={step.instruction} placeholder="例如：将工件沿定位销放入夹具" onChange={(event) => onChange({ ...instruction, steps: patchItem(instruction.steps, step.id, { instruction: event.target.value }) })} />
            <button className="icon" type="button" disabled={instruction.steps.length === 1} aria-label={`删除步骤 ${index + 1}`} title={instruction.steps.length === 1 ? "至少保留一个操作步骤" : "删除步骤"} onClick={() => onChange({ ...instruction, steps: removeItem(instruction.steps, step.id) })}><Trash2 size={12} /></button>
          </div>
        ))}
      </InstructionGroup>

      <InstructionGroup
        icon={<ShieldAlert size={13} />}
        title="安全注意"
        hint="只记录该工序特有风险"
        onAdd={() => onChange({
          ...instruction,
          safetyNotes: [...instruction.safetyNotes, { id: nextPprInstructionItemId(instruction, "safety"), note: "" }],
        })}
      >
        {instruction.safetyNotes.map((note, index) => (
          <div className="ppr-ewi-row note" key={note.id}>
            <ShieldAlert size={13} />
            <textarea rows={2} aria-label={`安全注意 ${index + 1}`} value={note.note} placeholder="例如：夹具闭合前确认双手离开夹紧区" onChange={(event) => onChange({ ...instruction, safetyNotes: patchItem(instruction.safetyNotes, note.id, { note: event.target.value }) })} />
            <button className="icon" type="button" aria-label={`删除安全注意 ${index + 1}`} onClick={() => onChange({ ...instruction, safetyNotes: removeItem(instruction.safetyNotes, note.id) })}><Trash2 size={12} /></button>
          </div>
        ))}
      </InstructionGroup>

      <PprQualityControlEditor instruction={instruction} onChange={onChange} />

      <div className="ppr-ewi-visual">
        <header><span><Image size={13} /><strong>视觉上下文</strong></span><small>复用本计划已有的场景/对象 ID</small></header>
        {visualReferences.length ? (
          <div>{visualReferences.map((reference) => {
            const key = referenceKey(reference);
            const selected = instruction.visualReferences?.some((item) => referenceKey(item) === key) ?? false;
            return <label key={key}><input type="checkbox" checked={selected} onChange={(event) => onChange(togglePprVisualReference(instruction, reference, event.target.checked))} /><span>{reference.kind === "scene" ? "场景" : "对象"}</span><code>{reference.id}</code></label>;
          })}</div>
        ) : <p>当前没有可复用的场景或对象引用；可先在“高级标识与引用”中登记。</p>}
      </div>
    </section>
  );
}

function InstructionGroup({ icon, title, hint, onAdd, children }: { icon: ReactNode; title: string; hint: string; onAdd: () => void; children: ReactNode }) {
  return (
    <div className="ppr-ewi-group">
      <header><span>{icon}<strong>{title}</strong><small>{hint}</small></span><button type="button" onClick={onAdd}><Plus size={12} />添加</button></header>
      <div className="ppr-ewi-list">{children}</div>
    </div>
  );
}

function patchItem<T extends { id: string }>(items: T[], id: string, patch: Partial<T>): T[] {
  return items.map((item) => item.id === id ? { ...item, ...patch } : item);
}

function removeItem<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id);
}

function referenceKey(reference: PprExternalReference): string {
  return `${reference.kind}:${reference.id}`;
}
