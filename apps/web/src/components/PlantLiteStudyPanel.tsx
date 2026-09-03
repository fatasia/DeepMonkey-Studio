import { FlaskConical, History, LoaderCircle, RotateCcw, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useMemo, useState } from "react";
import type { DataDatasetPreview, DataDatasetRecord, PlantLiteConfidenceInterval, PlantLiteStudyRecord, PlantLiteStudyRequest } from "@bim-studio/contracts";
import { OperationsEmpty } from "./operationsPresentation";
import { createPlantLiteBottleneckSweep } from "./plantLiteBottleneckSweep";
import { PlantLitePlayback } from "./PlantLitePlayback";
import { PlantLiteMaterialFlowAnalysis } from "./PlantLiteMaterialFlowAnalysis";
import { PlantLiteEquipmentEvidence } from "./PlantLiteEquipmentEvidence";
import { PlantLiteWorkforceEvidence } from "./PlantLiteWorkforceEvidence";
import { PlantLiteEnergyEvidence } from "./PlantLiteEnergyEvidence";
import { PlantLiteResourceTimeline } from "./PlantLiteResourceTimeline";
import { PlantLiteScenarioDecision } from "./PlantLiteScenarioDecision";
import { PlantLiteAcceptanceEvidence } from "./PlantLiteAcceptanceEvidence";
import { PlantLiteChangeoverEvidence } from "./PlantLiteChangeoverEvidence";
import { PlantLiteQualityEvidence } from "./PlantLiteQualityEvidence";
import { PlantLiteProductionOrderEvidence } from "./PlantLiteProductionOrderEvidence";
import { PlantLiteBufferStrategyExperiment } from "./PlantLiteBufferStrategyExperiment";
import { PlantLiteMeasurementWindowEvidence } from "./PlantLiteMeasurementWindowEvidence";
import { PlantLiteEvidenceExportActions } from "./PlantLiteEvidenceExportActions";
import { PlantLiteFlowDynamics } from "./PlantLiteFlowDynamics";
import { PlantLiteReliabilityExperiment } from "./PlantLiteReliabilityExperiment";
import { PlantLiteRealDataCalibration } from "./PlantLiteRealDataCalibration";
import { assessPlantLiteComparability } from "./plantLiteScenarioDecisionModel";
import { isExactPlantLiteReproduction } from "./plantLiteStudyEvidence";
import { diagnosePlantLiteBottleneck, plantLiteBottleneckClassLabel } from "./plantLiteBottleneckDiagnosis";

export function PlantLiteStudyPanel({
  results,
  busy,
  onReproduce,
  onRunSweep,
  datasets,
  loadDatasetPreview,
}: {
  results: PlantLiteStudyRecord[];
  busy: boolean;
  onReproduce: (studyId: string) => void;
  onRunSweep?: (requests: PlantLiteStudyRequest[]) => void;
  datasets?: DataDatasetRecord[];
  loadDatasetPreview?: (datasetId: string) => Promise<DataDatasetPreview>;
}) {
  const latest = results[0];
  const baselines = latest ? results.filter((item) => item.id !== latest.id) : [];
  const [baselineId, setBaselineId] = useState("");
  const baseline = useMemo(
    () => baselines.find((item) => item.id === baselineId)
      ?? baselines.find((item) => item.id === latest?.comparison?.baselineStudyId)
      ?? baselines.find((item) => item.id === latest?.reproductionOf)
      ?? baselines[0],
    [baselines, baselineId, latest?.comparison?.baselineStudyId, latest?.reproductionOf],
  );

  if (!latest) return <EmptyStudy />;
  const exact = isExactPlantLiteReproduction(latest, baseline);
  const sweep = createPlantLiteBottleneckSweep(latest);
  const primaryBottleneckNode = latest.model?.nodes.find((node) => node.id === latest.outcome.bottlenecks[0]?.nodeId);
  const bufferIsPrimaryBottleneck = primaryBottleneckNode?.kind === "buffer" || primaryBottleneckNode?.kind === "queue-buffer";
  return (
    <section className="operations-panel logistics-study-panel">
      <header>
        <div>
          <strong>流程仿真结果</strong>
          <small>查看产出、在制品、交付周期和节点瓶颈。</small>
        </div>
        <History size={17} />
      </header>
      <BottleneckAdvice result={latest} />
      {latest.trace && latest.model
        ? <PlantLitePlayback trace={latest.trace} model={latest.model} />
        : <p className="plant-playback-unavailable">这条旧记录没有事件轨迹；重新运行当前工况即可生成可拖动的物流回放。</p>}
      <PlantLiteMeasurementWindowEvidence result={latest} />
      <div className="logistics-metric-table" role="table" aria-label="离散仿真统计区间">
        <Metric label="吞吐" unit="件/时" value={latest.outcome.throughputPerHour} />
        <Metric label="平均 WIP" unit="件" value={latest.outcome.averageWip} />
        <Metric label="平均交付周期" unit="分钟" value={latest.outcome.averageLeadTimeMinutes} />
      </div>
      <PlantLiteAcceptanceEvidence result={latest} />
      <PlantLiteQualityEvidence result={latest} />
      <PlantLiteProductionOrderEvidence result={latest} />
      <PlantLiteEnergyEvidence latest={latest} baseline={baseline} />
      <PlantLiteChangeoverEvidence result={latest} />
      <PlantLiteScenarioDecision results={results} />
      {onRunSweep ? <details className="plant-improvement-lab">
        <summary><FlaskConical size={14} /><span><strong>改进实验</strong><small>缓冲、产能与可靠性 · 按需运行</small></span></summary>
        <div>
          <PlantLiteBufferStrategyExperiment
            study={latest}
            busy={busy}
            onRunSweep={(requests) => { setBaselineId(latest.id); onRunSweep(requests); }}
          />
          {sweep && !bufferIsPrimaryBottleneck ? <div className="plant-sweep-action">
            <span><strong>瓶颈方案实验</strong><small>固定 seed 与重复次数，仅调整{sweep.parameterLabel}：{sweep.candidateLabels.join(" / ")}</small></span>
            <button type="button" disabled={busy} onClick={() => { setBaselineId(latest.id); onRunSweep(sweep.requests); }}>
              {busy ? <LoaderCircle className="spin" size={13} /> : <FlaskConical size={13} />}{busy ? "正在运行" : `运行 ${sweep.requests.length} 个方案`}
            </button>
          </div> : null}
          <PlantLiteReliabilityExperiment
            study={latest}
            results={results}
            busy={busy}
            onRunSweep={(requests, baselineStudyId) => { setBaselineId(baselineStudyId); onRunSweep(requests); }}
          />
        </div>
      </details> : null}
      {datasets && loadDatasetPreview ? <PlantLiteRealDataCalibration study={latest} datasets={datasets} loadPreview={loadDatasetPreview} /> : null}
      <PlantLiteEvidenceExportActions study={latest} {...(baseline ? { baseline } : {})} />
      <NodeEvidence result={latest} />
      <PlantLiteEquipmentEvidence result={latest} />
      <PlantLiteWorkforceEvidence result={latest} />
      {latest.trace && latest.model ? <PlantLiteResourceTimeline trace={latest.trace} model={latest.model} /> : null}
      {latest.trace && latest.model ? <PlantLiteFlowDynamics trace={latest.trace} model={latest.model} /> : null}
      {latest.trace && latest.model ? <PlantLiteMaterialFlowAnalysis trace={latest.trace} model={latest.model} /> : null}
      <Evidence result={latest} />
      {baseline ? <Comparison latest={latest} baseline={baseline} exact={exact} busy={busy} onReproduce={onReproduce} onBaselineChange={setBaselineId} baselines={baselines} /> : <p className="logistics-first-run">再运行一个配置即可作为基线比较；当前记录已包含输入指纹与 seed。</p>}
    </section>
  );
}

function EmptyStudy() {
  return (
    <section className="operations-panel logistics-study-panel">
      <header>
        <div>
          <strong>流程仿真结果</strong>
          <small>运行后显示统计区间、节点瓶颈和可复现证据。</small>
        </div>
        <History size={17} />
      </header>
      <OperationsEmpty text="起步产线已经就绪；也可增删和排序节点。运行后会保留模型快照、seed、引擎版本和 95% 统计区间。" />
    </section>
  );
}

function Comparison({ latest, baseline, exact, busy, onReproduce, onBaselineChange, baselines }: {
  latest: PlantLiteStudyRecord;
  baseline: PlantLiteStudyRecord;
  exact: boolean;
  busy: boolean;
  onReproduce: (studyId: string) => void;
  onBaselineChange: (id: string) => void;
  baselines: PlantLiteStudyRecord[];
}) {
  const comparison = assessPlantLiteComparability(latest, baseline);
  const delta = comparison.comparable ? latest.outcome.throughputPerHour.mean - baseline.outcome.throughputPerHour.mean : undefined;
  return (
    <div className="logistics-comparison">
      <label>
        <span>对比基线</span>
        <select value={baseline.id} onChange={(event) => onBaselineChange(event.target.value)}>
          {baselines.map((item) => <option key={item.id} value={item.id}>{item.name} · {formatTime(item.createdAt)}</option>)}
        </select>
      </label>
      <div className={`logistics-evidence ${exact ? "verified" : "engine-mismatch"}`}>
        {exact ? <ShieldCheck size={15} /> : <ShieldQuestion size={15} />}
        <span>{exact
          ? "复现校验通过：输入、执行版本与全部统计证据一致。"
          : delta === undefined
            ? comparison.reason
            : `吞吐均值对比：${formatDelta(delta)} 件/时`}</span>
      </div>
      <div className="operations-inline-actions">
        <button disabled={busy} onClick={() => onReproduce(baseline.id)}><RotateCcw size={14} />精确复现基线</button>
      </div>
    </div>
  );
}

function Evidence({ result }: { result: PlantLiteStudyRecord }) {
  const completed = result.outcome.status === "completed";
  const text = completed
    ? `${result.execution.engineId} ${result.execution.engineVersion} · seed ${String(result.seed)} · ${result.outcome.completedReplications} 次重复`
    : result.outcome.message ?? "当前结果不具备可用统计证据";
  return <div className={`logistics-evidence ${completed ? "verified" : "legacy-missing"}`}>{completed ? <ShieldCheck size={15} /> : <ShieldQuestion size={15} />}<span>{text}</span></div>;
}

function Metric({ label, unit, value }: { label: string; unit: string; value: PlantLiteConfidenceInterval }) {
  return <div role="row"><span role="cell">{label}</span><strong role="cell">{value.mean.toFixed(1)} {unit}</strong><small role="cell">95% CI {value.lower95.toFixed(1)}–{value.upper95.toFixed(1)} · n={value.samples}</small></div>;
}

function NodeEvidence({ result }: { result: PlantLiteStudyRecord }) {
  const metrics = result.outcome.nodeMetrics95;
  const rows = metrics ? Object.entries(metrics)
    .filter(([nodeId]) => {
      const kind = result.model?.nodes.find((node) => node.id === nodeId)?.kind;
      return kind !== "source" && kind !== "sink";
    })
    .sort(([leftId, left], [rightId, right]) => bottleneckProbability(result, rightId) - bottleneckProbability(result, leftId) || right.utilization.mean - left.utilization.mean)
    .slice(0, 6) : [];
  return <section className="plant-node-evidence">
    <header><span>节点证据</span><small>{rows.length ? "利用率 · 平均队列 · 瓶颈概率" : "旧记录没有节点级统计"}</small></header>
    {rows.map(([nodeId, metric]) => {
      const probability = bottleneckProbability(result, nodeId);
      const name = result.model?.nodes.find((node) => node.id === nodeId)?.name ?? nodeId;
      const node = result.model?.nodes.find((candidate) => candidate.id === nodeId);
      const utilizationLabel = node?.kind === "buffer" || node?.kind === "queue-buffer" ? "平均占用率" : "计划利用率";
      return <div key={nodeId} className={probability > 0 ? "is-bottleneck" : ""}><span>{name}</span><strong>{(metric.utilization.mean * 100).toFixed(0)}% {utilizationLabel}</strong><small>{metric.averageQueueLength.mean.toFixed(1)} 队列 · {(probability * 100).toFixed(0)}%</small></div>;
    })}
  </section>;
}

function bottleneckProbability(result: PlantLiteStudyRecord, nodeId: string): number {
  return result.outcome.bottlenecks.find((item) => item.nodeId === nodeId)?.probability ?? 0;
}

function BottleneckAdvice({ result }: { result: PlantLiteStudyRecord }) {
  const bottleneck = result.outcome.bottlenecks[0];
  if (!bottleneck) {
    const message = result.outcome.throughputPerHour.mean > 0
      ? "当前流程有有效产出，但未识别到工位或搬运资源瓶颈；请结合缓冲队列确认建模是否完整。"
      : "有效产出不足，先检查流程是否连通以及来料、班次和运行时长。";
    return <p className="plant-bottleneck-advice">{message}</p>;
  }
  const diagnosis = diagnosePlantLiteBottleneck(result);
  if (!diagnosis) return null;
  return <p className="plant-bottleneck-advice">
    <b>{plantLiteBottleneckClassLabel(diagnosis.classification)}</b>
    {diagnosis.nodeName} 在 {(diagnosis.probability * 100).toFixed(0)}% 的重复运行中成为瓶颈；{diagnosis.evidence}。{diagnosis.action}
  </p>;
}

function formatDelta(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
