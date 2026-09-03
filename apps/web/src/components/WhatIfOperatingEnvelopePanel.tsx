import {
  Activity,
  AlertTriangle,
  Calculator,
  Copy,
  History,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  WhatIfOperatingEnvelopeResult,
  WhatIfStudyRecord,
  WhatIfStudyRequest,
} from "@bim-studio/studio-core";
import { OperationsEmpty } from "./operationsPresentation";
import {
  compareWhatIfStudies,
  DEFAULT_WHAT_IF_DRAFT,
  type WhatIfDraft,
  whatIfDraftFromStudy,
  whatIfRequestFromDraft,
} from "./whatIfStudy";

export function WhatIfOperatingEnvelopePanel({
  results,
  busy,
  onRun,
  onReproduce,
}: {
  results: WhatIfStudyRecord[];
  busy: boolean;
  onRun: (request: WhatIfStudyRequest) => void;
  onReproduce: (studyId: string) => void;
}) {
  const [draft, setDraft] = useState<WhatIfDraft>(DEFAULT_WHAT_IF_DRAFT);
  const [selectedBaselineId, setSelectedBaselineId] = useState("");
  const [error, setError] = useState("");
  const latest = results[0];
  const baselines = latest ? results.filter((item) => item.id !== latest.id) : [];
  const baseline = useMemo(() => {
    if (!latest) return undefined;
    return baselines.find((item) => item.id === selectedBaselineId)
      ?? baselines.find((item) => item.id === latest.reproductionOf)
      ?? baselines[0];
  }, [baselines, latest, selectedBaselineId]);
  const comparison = latest && baseline ? compareWhatIfStudies(baseline, latest) : undefined;

  function run() {
    try {
      const request = whatIfRequestFromDraft(draft);
      if (!request.name) throw new Error("请先填写工况名称");
      if (!request.input.baselines[0]?.metricId || !request.input.changes[0]?.variableId) {
        throw new Error("结果指标和可控变量不能为空");
      }
      setError("");
      onRun(request);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <div className="operations-grid what-if-workspace">
      <section className="operations-panel">
        <header>
          <div>
            <strong>What-if 工况包络</strong>
            <small>先做局部响应筛查；域外工况再提交正式仿真，不直接控制现场。</small>
          </div>
          <button className="button primary" disabled={busy} onClick={run}>
            {busy ? <LoaderCircle className="spin" size={15} /> : <Calculator size={15} />}
            运行并留证
          </button>
        </header>
        <div className="what-if-primary-fields">
          <TextField className="operations-field-wide" label="工况名称" value={draft.name} onChange={(name) => setDraft({ ...draft, name })} />
          <TextField label="结果指标" value={draft.metricId} onChange={(metricId) => setDraft({ ...draft, metricId })} />
          <NumberField label="当前基线" value={draft.baseline} onChange={(baselineValue) => setDraft({ ...draft, baseline: baselineValue })} />
          <TextField label="可控变量" value={draft.variableId} onChange={(variableId) => setDraft({ ...draft, variableId })} />
          <NumberField label="变量变化（%）" value={draft.changePercent} onChange={(changePercent) => setDraft({ ...draft, changePercent })} />
        </div>
        <details className="what-if-calibration">
          <summary>标定与适用域</summary>
          <p>这些参数应来自历史回归、正式仿真或工程确认；默认值只用于说明工作流。</p>
          <div className="operations-form-grid">
            <NumberField label="响应系数" value={draft.elasticity} step={0.05} onChange={(elasticity) => setDraft({ ...draft, elasticity })} />
            <NumberField label="系数可靠度（%）" value={draft.reliabilityPercent} onChange={(reliabilityPercent) => setDraft({ ...draft, reliabilityPercent })} />
            <NumberField label="指标下限" value={draft.metricMinimum} onChange={(metricMinimum) => setDraft({ ...draft, metricMinimum })} />
            <NumberField label="指标上限" value={draft.metricMaximum} onChange={(metricMaximum) => setDraft({ ...draft, metricMaximum })} />
            <NumberField label="变量域下限（%）" value={draft.changeMinimumPercent} onChange={(changeMinimumPercent) => setDraft({ ...draft, changeMinimumPercent })} />
            <NumberField label="变量域上限（%）" value={draft.changeMaximumPercent} onChange={(changeMaximumPercent) => setDraft({ ...draft, changeMaximumPercent })} />
          </div>
        </details>
        {error && <p className="operations-notice"><AlertTriangle size={14} />{error}</p>}
      </section>

      <section className="operations-panel what-if-result">
        <header>
          <div><strong>结果与对比</strong><small>每次运行独立保存输入、引擎与结果证据。</small></div>
          <History size={17} aria-hidden="true" />
        </header>
        {!latest ? (
          <OperationsEmpty text="运行第一个工况后，这里会显示确定性结果、历史对比和精确复现入口。" />
        ) : (
          <>
            <ResultSummary study={latest} />
            <ExecutionEvidence study={latest} />
            {baseline && comparison ? (
              <div className="what-if-comparison">
                <label>
                  <span>对比基线</span>
                  <select value={baseline.id} onChange={(event) => setSelectedBaselineId(event.target.value)}>
                    {baselines.map((item) => <option key={item.id} value={item.id}>{item.name} · {formatTime(item.createdAt)}</option>)}
                  </select>
                </label>
                <div className={`logistics-evidence ${comparison.evidenceStatus}`}>
                  {comparison.evidenceStatus === "verified" ? <ShieldCheck size={15} /> : <ShieldQuestion size={15} />}
                  <span>{comparison.exactReproduction ? "复现校验通过：输入、引擎版本和结果证据完全一致。" : comparison.evidenceMessage}</span>
                </div>
                <div className="what-if-comparison-table" role="table" aria-label="What-if 结果对比">
                  {comparison.metrics.map((metric) => <div key={metric.metricId} role="row">
                    <span role="cell">{metric.metricId}</span>
                    <strong role="cell">{format(metric.candidate)}</strong>
                    <small role="cell">{signed(metric.delta)}</small>
                  </div>)}
                </div>
                <p>风险：{riskLabel(baseline.result.risk.level)} → {riskLabel(latest.result.risk.level)}{comparison.riskChanged ? "（已变化）" : "（未变化）"}</p>
                <div className="operations-inline-actions">
                  <button disabled={busy} onClick={() => setDraft(whatIfDraftFromStudy(baseline))}><Copy size={14} />载入基线参数</button>
                  <button disabled={busy} onClick={() => onReproduce(baseline.id)}><RotateCcw size={14} />精确复现基线</button>
                </div>
              </div>
            ) : <p className="what-if-first-run">再运行一个不同工况即可对比；当前记录已可作为后续基线。</p>}
            <details className="what-if-history">
              <summary>运行历史（{results.length}）</summary>
              <div>{results.slice(0, 8).map((item) => <button key={item.id} disabled={item.id === latest.id} onClick={() => setSelectedBaselineId(item.id)}>
                <span>{item.name}</span><small>{formatTime(item.createdAt)} · {riskLabel(item.result.risk.level)}</small>
              </button>)}</div>
            </details>
          </>
        )}
      </section>
    </div>
  );
}

function ResultSummary({ study }: { study: WhatIfStudyRecord }) {
  const result = study.result;
  const prediction = result.predictions[0];
  return <div className="what-if-study-result">
    <div className="what-if-study-heading"><span><strong>{study.name}</strong><small>指纹 {result.evidenceFingerprint.slice(-12)}</small></span><em className={`what-if-risk ${result.risk.level}`}>{riskLabel(result.risk.level)}</em></div>
    {prediction && <div className="what-if-kpis">
      <div><small>预测值</small><strong>{format(prediction.predictedValue)}</strong></div>
      <div><small>预测增量</small><strong>{signed(prediction.predictedDelta)}</strong></div>
      <div><small>结果置信</small><strong>{Math.round(result.confidence.score * 100)}%</strong></div>
    </div>}
    <div className={`what-if-applicability ${result.applicability.status}`}>
      {result.applicability.status === "supported" ? <ShieldCheck size={16} /> : <AlertTriangle size={16} />}
      <span><strong>{applicabilityLabel(result.applicability.status)}</strong><small>{result.risk.reasons.join("；") || "未发现约束越界"}</small></span>
    </div>
    <div className="what-if-contributions">
      <strong><Activity size={14} />可解释贡献</strong>
      {prediction?.contributions.map((item) => <p key={`${prediction.metricId}-${item.variableId}`}><span>{item.variableId}</span><em>{item.formula}</em><b>{signed(item.predictedDelta)}</b></p>)}
    </div>
    <p className="what-if-declaration">{result.nonSolverDeclaration}</p>
  </div>;
}

function ExecutionEvidence({ study }: { study: WhatIfStudyRecord }) {
  if (!study.execution) return <div className="logistics-evidence legacy-missing"><ShieldQuestion size={15} />旧记录缺少引擎证据，不标记为可复现。</div>;
  return <div className="logistics-evidence verified"><ShieldCheck size={15} /><span>{study.execution.engineId} {study.execution.engineVersion} · {study.execution.inputFingerprint.slice(-12)}</span></div>;
}

function TextField({ label, value, className, onChange }: { label: string; value: string; className?: string; onChange: (value: string) => void }) {
  return <label {...(className ? { className } : {})}><span>{label}</span><input value={value} onChange={(event) => onChange(event.target.value)} /></label>;
}

function NumberField({ label, value, step = 1, onChange }: { label: string; value: number; step?: number; onChange: (value: number) => void }) {
  return <label><span>{label}</span><input type="number" step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}

function riskLabel(value: WhatIfOperatingEnvelopeResult["risk"]["level"]): string { return ({ low: "低风险", medium: "需注意", high: "高风险", critical: "严重越界" })[value]; }
function applicabilityLabel(value: WhatIfOperatingEnvelopeResult["applicability"]["status"]): string { return ({ supported: "适用域内", caution: "证据不完整", "out-of-domain": "超出适用域" })[value]; }
function format(value: number): string { return Number(value.toFixed(4)).toLocaleString("zh-CN"); }
function signed(value: number): string { return `${value >= 0 ? "+" : ""}${format(value)}`; }
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false }); }
