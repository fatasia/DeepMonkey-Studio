import { useEffect, useRef, useState } from "react";
import { Boxes, CopyPlus, LoaderCircle, Save, Settings2, TimerReset, X } from "lucide-react";
import type { PprBopVersionDraft, PprCondition } from "@bim-studio/contracts";
import { PprPlanEditor } from "./PprPlanEditor";
import { PprApplicabilityFields } from "./PprPlanEditorShared";
import { PprPlanInsights, PprVersionHistory } from "./PprPlanInsights";
import { usePprPlanController } from "./pprPlanController";
import type { PprPlanReferenceContext, PprPlanSection } from "./pprPlanDraftModel";
import type { PprPlantLiteReadyDraft } from "./pprPlantLiteDraft";
import "./PprPlanWorkbench.css";

const STEPS: Array<{ id: PprPlanSection; label: string; description: string }> = [
  { id: "product", label: "产品结构", description: "产品与零部件" },
  { id: "operations", label: "工序安排", description: "顺序、工时与作业指导" },
  { id: "resources", label: "资源配置", description: "工位、设备与人员" },
];

export function PprPlanDetails({
  projectId,
  references,
  onClose,
  onCreatePlantLiteDraft,
}: {
  projectId: string;
  references: PprPlanReferenceContext;
  onClose: () => void;
  onCreatePlantLiteDraft: (result: PprPlantLiteReadyDraft) => void;
}) {
  const controller = usePprPlanController(projectId, references);
  const [section, setSection] = useState<PprPlanSection>("product");
  const dialogRef = useRef<HTMLElement>(null);
  const currentStep = STEPS.findIndex((item) => item.id === section);
  const stepBlocker = nextStepBlocker(section, controller.draft);

  function requestClose() {
    if (!controller.dirty || window.confirm("当前工艺草稿尚未保存，仍要关闭吗？")) onClose();
  }

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialogRef.current?.querySelector<HTMLElement>(".ppr-plan-name input")?.focus();
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (!controller.dirty || window.confirm("当前工艺草稿尚未保存，仍要关闭吗？"))) onClose();
      if (event.key === "Tab") keepFocusInside(event, dialogRef.current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controller.dirty, onClose]);

  return (
    <div className="ppr-workbench-backdrop" role="presentation">
      <section ref={dialogRef} className="ppr-workbench" role="dialog" aria-modal="true" aria-labelledby="ppr-workbench-title">
        <header className="ppr-workbench-header">
          <div className="ppr-workbench-title"><span><Boxes size={19} /></span><div><strong id="ppr-workbench-title">工艺规划</strong><small>产品 → 工序 → 资源，系统实时计算排程与影响</small></div></div>
          <div className="ppr-workbench-state">
            {controller.dirty ? <em>未保存草稿</em> : <span>{controller.versions.length ? `基于 ${controller.versions.at(-1)?.version}` : "新计划"}</span>}
            {controller.validationErrorCount > 0 && <b>{controller.validationErrorCount} 项错误</b>}
          </div>
          <div className="ppr-workbench-actions">
            <button type="button" disabled={Boolean(controller.busyAction) || !controller.versions.length} onClick={() => controller.cloneVersion(controller.versions.at(-1)?.id ?? "")}><CopyPlus size={14} />从最新版新建</button>
            <button className="primary" type="button" disabled={!controller.canSave} onClick={() => void controller.saveVersion()}>{controller.busyAction === "saving" ? <LoaderCircle className="spin" size={14} /> : <Save size={14} />}保存为新版本</button>
            <button className="icon" type="button" aria-label="关闭工艺规划" onClick={requestClose}><X size={17} /></button>
          </div>
        </header>

        <div className="ppr-workbench-body">
          <nav className="ppr-workbench-nav" aria-label="工艺规划步骤">
            <label className="ppr-plan-name"><span>计划名称</span><input value={controller.draft.name} maxLength={120} onChange={(event) => controller.setDraft({ ...controller.draft, name: event.target.value })} /></label>
            <label className="ppr-plan-takt"><span>目标节拍（分钟/件）</span><input type="number" min={0.01} step={0.1} value={controller.draft.targetTaktMinutes ?? ""} placeholder="未设置" onChange={(event) => controller.setDraft(withTargetTakt(controller.draft, event.target.value))} /></label>
            <div className="ppr-step-list">
              {STEPS.map((step, index) => (
                <button className={section === step.id ? "active" : ""} type="button" key={step.id} onClick={() => setSection(step.id)}><span>{index + 1}</span><strong>{step.label}</strong><small>{step.description}</small></button>
              ))}
            </div>
            <details className="ppr-context-references">
              <summary><Settings2 size={13} />变体与高级上下文</summary>
              <PprApplicabilityFields
                variantIds={controller.draft.variantIds}
                condition={controller.draft.condition}
                onVariantIdsChange={(variantIds) => controller.setDraft(withPlanVariants(controller.draft, variantIds))}
                onConditionChange={(condition) => controller.setDraft(withPlanCondition(controller.draft, condition))}
              />
              <p>场景、对象、脚本和运行记录只保存现有 ID，不复制内容。</p>
              <div>{controller.draft.references?.length
                ? controller.draft.references.map((reference) => <span key={`${reference.kind}-${reference.id}`}>{reference.kind}<code>{reference.id}</code></span>)
                : <small>当前没有可用上下文引用</small>}</div>
            </details>
            <PprVersionHistory versions={controller.versions} busy={Boolean(controller.busyAction)} onAnalyze={(id) => void controller.analyzeVersion(id)} onClone={controller.cloneVersion} />
          </nav>

          <main className="ppr-workbench-editor">
            <PprPlanEditor section={section} draft={controller.draft} onChange={controller.setDraft} />
            <footer className="ppr-step-footer">
              <span>{stepBlocker ?? `第 ${currentStep + 1} / ${STEPS.length} 步`}</span>
              {currentStep > 0 && <button type="button" onClick={() => setSection(STEPS[currentStep - 1]!.id)}>上一步</button>}
              {currentStep < STEPS.length - 1 && <button className="primary" type="button" disabled={Boolean(stepBlocker)} title={stepBlocker ?? undefined} onClick={() => setSection(STEPS[currentStep + 1]!.id)}>继续：{STEPS[currentStep + 1]!.label}</button>}
            </footer>
          </main>

          <PprPlanInsights
            instructionPlan={controller.analysisPlan}
            plantDraft={controller.draft}
            versions={controller.versions}
            analysis={controller.analysis}
            analysisLabel={controller.analysisLabel}
            validationErrorCount={controller.analysisValidationErrorCount}
            variantIds={controller.availableVariantIds}
            activeVariantId={controller.activeVariantId}
            comparison={controller.comparison}
            beforeVersionId={controller.beforeVersionId}
            afterVersionId={controller.afterVersionId}
            busy={Boolean(controller.busyAction)}
            onActiveVariantChange={controller.setActiveVariantId}
            onBeforeChange={controller.setBeforeVersionId}
            onAfterChange={controller.setAfterVersionId}
            onCompare={() => void controller.compareVersions()}
            onCreatePlantLiteDraft={onCreatePlantLiteDraft}
          />
        </div>

        {(controller.busyAction || controller.summary || controller.error) && (
          <footer className={`ppr-workbench-feedback${controller.error ? " error" : ""}`} role={controller.error ? "alert" : "status"} aria-live="polite">
            {controller.busyAction ? <LoaderCircle className="spin" size={13} /> : controller.error ? <X size={13} /> : <TimerReset size={13} />}
            <span>{controller.error || controller.summary || busyLabel(controller.busyAction)}</span>
          </footer>
        )}
      </section>
    </div>
  );
}

function nextStepBlocker(section: PprPlanSection, draft: PprBopVersionDraft): string | undefined {
  if (section === "product") {
    if (!draft.components.length) return "先添加至少一个产品";
    if (draft.components.some((item) => !item.name.trim())) return "先补全产品或零部件名称";
  }
  if (section === "operations") {
    if (!draft.operations.length) return "先添加至少一道工序";
    if (draft.operations.some((item) => !item.name.trim() || item.standardTimeMinutes <= 0)) return "先补全工序名称和标准工时";
  }
  return undefined;
}

function withTargetTakt(draft: PprBopVersionDraft, value: string): PprBopVersionDraft {
  const next = { ...draft };
  if (!value.trim()) delete next.targetTaktMinutes;
  else next.targetTaktMinutes = Number(value);
  return next;
}

function withPlanVariants(draft: PprBopVersionDraft, variantIds: string[]): PprBopVersionDraft {
  const next = { ...draft };
  if (variantIds.length) next.variantIds = variantIds;
  else delete next.variantIds;
  return next;
}

function withPlanCondition(draft: PprBopVersionDraft, condition: PprCondition | undefined): PprBopVersionDraft {
  const next = { ...draft };
  if (condition) next.condition = condition;
  else delete next.condition;
  return next;
}

function busyLabel(action: ReturnType<typeof usePprPlanController>["busyAction"]): string {
  if (action === "loading") return "正在载入版本历史…";
  if (action === "saving") return "正在追加版本并运行分析…";
  if (action === "analyzing") return "正在运行版本分析…";
  if (action === "comparing") return "正在比较版本影响…";
  return "";
}

function keepFocusInside(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) return;
  const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex='-1'])")];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
