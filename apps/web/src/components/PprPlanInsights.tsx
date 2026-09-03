import { Activity, AlertTriangle, BadgeCheck, CheckCircle2, CopyPlus, GitCompareArrows, Play, Route } from "lucide-react";
import { useEffect, useState } from "react";
import type { PprBopVersion, PprBopVersionDraft } from "@bim-studio/contracts";
import type { PprAnalysis, PprVersionComparison } from "@bim-studio/ppr-lite-engine";
import { PprLineBalanceView } from "./PprLineBalanceView";
import { PprPlantLiteHandoff } from "./PprPlantLiteHandoff";
import { PprWorkInstructionPreview } from "./PprWorkInstructionPreview";
import type { PprPlantLiteReadyDraft } from "./pprPlantLiteDraft";
import {
  currentPprVersionComparison,
  pprComparisonEntityName,
  type PprBoundVersionComparison,
} from "./pprPlanComparison";

export function PprVersionHistory({
  versions,
  busy,
  onAnalyze,
  onClone,
}: {
  versions: PprBopVersion[];
  busy: boolean;
  onAnalyze: (versionId: string) => void;
  onClone: (versionId: string) => void;
}) {
  return (
    <details className="ppr-history">
      <summary><strong>版本历史</strong><span>{versions.length}</span></summary>
      {!versions.length && <p>首次保存后会在这里形成不可覆盖的版本链。</p>}
      <div>
        {[...versions].reverse().map((version, index) => (
          <article key={version.id}>
            <span><strong>{version.version}</strong>{index === 0 && <em>最新</em>}<small>{formatDate(version.createdAt)}</small></span>
            <small>{version.operations.length} 工序 · {version.resources.length} 资源</small>
            <div>
              <button type="button" disabled={busy} onClick={() => onAnalyze(version.id)}><Play size={12} />分析</button>
              <button type="button" disabled={busy} onClick={() => onClone(version.id)}><CopyPlus size={12} />克隆</button>
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}

export function PprPlanInsights({
  instructionPlan,
  plantDraft,
  versions,
  analysis,
  analysisLabel,
  validationErrorCount,
  variantIds,
  activeVariantId,
  comparison,
  beforeVersionId,
  afterVersionId,
  busy,
  onActiveVariantChange,
  onBeforeChange,
  onAfterChange,
  onCompare,
  onCreatePlantLiteDraft,
}: {
  instructionPlan: PprBopVersionDraft;
  plantDraft: PprBopVersionDraft;
  versions: PprBopVersion[];
  analysis: PprAnalysis;
  analysisLabel: string;
  validationErrorCount: number;
  variantIds: string[];
  activeVariantId: string;
  comparison: PprBoundVersionComparison | undefined;
  beforeVersionId: string;
  afterVersionId: string;
  busy: boolean;
  onActiveVariantChange: (variantId: string) => void;
  onBeforeChange: (versionId: string) => void;
  onAfterChange: (versionId: string) => void;
  onCompare: () => void;
  onCreatePlantLiteDraft: (result: PprPlantLiteReadyDraft) => void;
}) {
  const [compareOpen, setCompareOpen] = useState(versions.length >= 2 || Boolean(comparison));
  useEffect(() => {
    if (versions.length >= 2 || comparison) setCompareOpen(true);
  }, [comparison, versions.length]);
  const errors = analysis.issues.filter((issue) => issue.severity === "error");
  const warnings = analysis.issues.filter((issue) => issue.severity === "warning");
  const entityName = (id: string) => findEntityName(id, [instructionPlan]);
  const activeComparison = currentPprVersionComparison(comparison, beforeVersionId, afterVersionId, activeVariantId);
  const comparisonEntityName = (id: string) => activeComparison
    ? pprComparisonEntityName(id, activeComparison, versions)
    : id;
  return (
    <aside className="ppr-insights" aria-label="计划诊断与版本影响">
      <PprPlantLiteHandoff draft={plantDraft} busy={busy} onCreateDraft={onCreatePlantLiteDraft} />

      <section className="ppr-analysis-card">
        <header><span><Activity size={15} /><strong>{analysisLabel}</strong></span>{validationErrorCount ? <em className="error">{validationErrorCount} 项阻断</em> : errors.length ? <em className="error">{errors.length} 错误</em> : !analysis.qualityControl.qualityPlanReady ? <em className="warning"><AlertTriangle size={12} />质量待完善</em> : warnings.length ? <em className="warning"><AlertTriangle size={12} />待复核</em> : <em className="healthy"><CheckCircle2 size={12} />计划就绪</em>}</header>
        {!!variantIds.length && (
          <div className="ppr-variant-scope">
            <label><span>分析变体</span><select aria-label="分析变体" value={activeVariantId} onChange={(event) => onActiveVariantChange(event.target.value)}><option value="">全部变体</option>{variantIds.map((variantId) => <option value={variantId} key={variantId}>{variantId}</option>)}</select></label>
            <p><strong>{activeVariantId || "全部变体"}</strong><span>{activeVariantId ? `${analysis.variantScope.included.operationIds.length} 道工序生效，排除 ${analysis.variantScope.excluded.operationIds.length} 道` : `${analysis.variantScope.included.operationIds.length} 道工序统一校核`}</span></p>
          </div>
        )}
        <div className="ppr-analysis-metrics">
          <div><span>关键路径</span><strong>{analysis.criticalPath.durationMinutes}<small> 分钟</small></strong></div>
          <div><span>提示</span><strong>{warnings.length}</strong></div>
          <div><span>资源冲突</span><strong>{analysis.resourceConflicts.length}</strong></div>
        </div>
        <div className={`ppr-quality-evidence${analysis.qualityControl.qualityPlanReady ? " ready" : " incomplete"}`}>
          <header><span><BadgeCheck size={13} /><strong>质量控制覆盖</strong></span><em>{analysis.qualityControl.completeOperationCount}/{analysis.qualityControl.operationCount} 工序完整</em></header>
          <div><span>{analysis.qualityControl.controlPointCount} 个控制点</span><span>{analysis.qualityControl.completeControlPointCount} 个定义完整</span></div>
          {(analysis.qualityControl.missingOperationIds.length > 0 || analysis.qualityControl.incompleteOperationIds.length > 0) && <p>{[...analysis.qualityControl.missingOperationIds, ...analysis.qualityControl.incompleteOperationIds].map(entityName).join("、")} 仍需补充质量定义。</p>}
          <small>定义级证据；不代表量测采集、SPC 或失控处置已执行。</small>
        </div>
        {!analysis.issues.length && <p className="ppr-healthy-message"><CheckCircle2 size={14} />结构和引用检查通过</p>}
        {!!analysis.issues.length && (
          <div className="ppr-issue-list">
            {analysis.issues.slice(0, 6).map((issue, index) => (
              <p className={issue.severity} key={`${issue.code}-${issue.entityId}-${index}`}><AlertTriangle size={13} /><span><strong>{entityName(issue.entityId)}</strong>{issue.message}</span></p>
            ))}
          </div>
        )}
        {!!analysis.schedule.length && (
          <div className="ppr-schedule">
            <h4><Route size={13} />排程预览</h4>
            {analysis.schedule.map((item) => <div className={analysis.criticalPath.operationIds.includes(item.operationId) ? "critical" : ""} key={item.operationId}><span>{entityName(item.operationId)}</span><small>{item.startMinutes}–{item.endMinutes} 分钟</small></div>)}
          </div>
        )}
        <PprWorkInstructionPreview draft={instructionPlan} operationOrder={analysis.topologicalOrder} documentLabel={analysisLabel} />
        <PprLineBalanceView balance={analysis.lineBalance} entityName={entityName} />
        {!!analysis.resourceConflicts.length && (
          <div className="ppr-conflicts">
            <h4>资源冲突</h4>
            {analysis.resourceConflicts.map((conflict) => <p key={`${conflict.resourceId}-${conflict.startMinutes}`}><strong>{entityName(conflict.resourceId)}</strong><span>{conflict.startMinutes}–{conflict.endMinutes} 分钟，同时需要 {conflict.requiredCapacity}/{conflict.availableCapacity}</span></p>)}
          </div>
        )}
      </section>

      <details className="ppr-compare-card" open={compareOpen} onToggle={(event) => setCompareOpen(event.currentTarget.open)}>
        <summary><span><GitCompareArrows size={15} /><strong>版本影响</strong></span><small>{versions.length >= 2 ? `${activeVariantId || "全部变体"} · 任意两版` : "保存两版后可比较"}</small></summary>
        <div className="ppr-compare-content">
          <div className="ppr-compare-selectors">
            <label><span>基线</span><select value={beforeVersionId} onChange={(event) => onBeforeChange(event.target.value)}><option value="">选择版本</option>{versions.map((version) => <option key={version.id} value={version.id}>{version.version}</option>)}</select></label>
            <label><span>目标</span><select value={afterVersionId} onChange={(event) => onAfterChange(event.target.value)}><option value="">选择版本</option>{versions.map((version) => <option key={version.id} value={version.id}>{version.version}</option>)}</select></label>
          </div>
          <button type="button" disabled={busy || versions.length < 2 || !beforeVersionId || !afterVersionId || beforeVersionId === afterVersionId} onClick={onCompare}><GitCompareArrows size={13} />比较影响</button>
          {!activeComparison && <p className="ppr-compare-empty">保存新版本后会自动对比上一版；也可在此选择任意两个历史版本。</p>}
          {activeComparison && <PprComparisonResult comparison={activeComparison.result} entityName={comparisonEntityName} />}
        </div>
      </details>
    </aside>
  );
}

function PprComparisonResult({ comparison, entityName }: { comparison: PprVersionComparison; entityName: (id: string) => string }) {
  const impacts = [
    ...comparison.impact.componentIds.map((id) => ({ key: `component:${id}`, id })),
    ...comparison.impact.operationIds.map((id) => ({ key: `operation:${id}`, id })),
    ...comparison.impact.resourceIds.map((id) => ({ key: `resource:${id}`, id })),
  ];
  return (
    <div className="ppr-comparison-result">
      <div className="ppr-analysis-metrics"><div><span>变更</span><strong>{comparison.changes.length}</strong></div><div><span>影响对象</span><strong>{impacts.length}</strong></div><div><span>退化</span><strong>{comparison.regressions.length}</strong></div></div>
      {!!comparison.regressions.length && <div className="ppr-regressions"><h4>需复核</h4>{comparison.regressions.map((item, index) => <p key={`${item.code}-${index}`}><AlertTriangle size={13} /><span>{item.message}</span></p>)}</div>}
      <details open>
        <summary>受影响范围</summary>
        <div className="ppr-impact-tags">{impacts.length ? impacts.map((impact) => <span key={impact.key}>{entityName(impact.id)}</span>) : <small>无连带影响</small>}</div>
      </details>
      <details>
        <summary>变更明细 · {comparison.changes.length}</summary>
        <div className="ppr-change-list">{comparison.changes.map((change) => <p key={`${change.entityType}-${change.entityId}`}><span>{change.changeType}</span><strong>{entityName(change.entityId)}</strong><small>{change.changedFields.map(changedFieldLabel).join("、")}</small></p>)}</div>
      </details>
    </div>
  );
}

function findEntityName(id: string, snapshots: readonly PprBopVersionDraft[]): string {
  for (const snapshot of snapshots) {
    const entity = [...snapshot.components, ...snapshot.operations, ...snapshot.resources].find((item) => item.id === id);
    if (entity) return entity.name || id;
  }
  return id === "__draft__" ? "当前草稿" : id;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : value;
}

const CHANGED_FIELD_LABELS: Record<string, string> = {
  name: "名称",
  kind: "类型",
  targetTaktMinutes: "目标节拍",
  parentComponentId: "上级产品",
  standardTimeMinutes: "标准工时",
  componentRefs: "物料角色",
  workInstruction: "电子作业指导书",
  predecessorOperationId: "前置工序",
  successorOperationId: "后续工序",
  minimumLagMinutes: "最小等待",
  operationId: "工序",
  resourceId: "资源",
  requiredCapacity: "占用能力",
  capacity: "并行能力",
  variantIds: "适用变体",
  condition: "适用条件",
  references: "外部引用",
};

function changedFieldLabel(field: string): string {
  return CHANGED_FIELD_LABELS[field] ?? field;
}
