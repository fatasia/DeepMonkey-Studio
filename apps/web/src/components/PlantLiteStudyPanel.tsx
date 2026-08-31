import { History, RotateCcw, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useMemo, useState } from "react";
import type { PlantLiteConfidenceInterval, PlantLiteStudyRecord } from "@bim-studio/contracts";
import { OperationsEmpty } from "./operationsPresentation";
import { isExactPlantLiteReproduction } from "./plantLiteStudyEvidence";

export function PlantLiteStudyPanel({
  results,
  busy,
  onReproduce,
}: {
  results: PlantLiteStudyRecord[];
  busy: boolean;
  onReproduce: (studyId: string) => void;
}) {
  const latest = results[0];
  const baselines = latest ? results.filter((item) => item.id !== latest.id) : [];
  const [baselineId, setBaselineId] = useState("");
  const baseline = useMemo(
    () => baselines.find((item) => item.id === baselineId)
      ?? baselines.find((item) => item.id === latest?.reproductionOf)
      ?? baselines[0],
    [baselines, baselineId, latest?.reproductionOf],
  );

  if (!latest) return <EmptyStudy />;
  const exact = isExactPlantLiteReproduction(latest, baseline);
  return (
    <section className="operations-panel logistics-study-panel">
      <header>
        <div>
          <strong>DES Study 结果与对比</strong>
          <small>随机性由固定 seed 和重复实验量化；结果不是解析估算值。</small>
        </div>
        <History size={17} />
      </header>
      <Evidence result={latest} />
      <div className="logistics-metric-table" role="table" aria-label="离散仿真统计区间">
        <Metric label="吞吐" unit="件/时" value={latest.outcome.throughputPerHour} />
        <Metric label="平均 WIP" unit="件" value={latest.outcome.averageWip} />
        <Metric label="平均 lead time" unit="分钟" value={latest.outcome.averageLeadTimeMinutes} />
      </div>
      <p className="logistics-bottleneck-change">瓶颈频率：{formatBottlenecks(latest)}</p>
      {baseline ? <Comparison latest={latest} baseline={baseline} exact={exact} busy={busy} onReproduce={onReproduce} onBaselineChange={setBaselineId} baselines={baselines} /> : <p className="logistics-first-run">再运行一个配置即可作为基线比较；当前记录已包含输入指纹与 seed。</p>}
    </section>
  );
}

function EmptyStudy() {
  return (
    <section className="operations-panel logistics-study-panel">
      <header>
        <div>
          <strong>DES Study 结果与对比</strong>
          <small>模板运行后显示统计区间、瓶颈频率和可复现证据。</small>
        </div>
        <History size={17} />
      </header>
      <OperationsEmpty text="默认 AGV 两工位产线已经就绪；运行后将保留 seed、引擎版本和 95% 统计区间。" />
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
  const delta = latest.outcome.throughputPerHour.mean - baseline.outcome.throughputPerHour.mean;
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
        <span>{exact ? "复现校验通过：输入、执行版本与全部统计证据一致。" : `吞吐均值对比：${formatDelta(delta)} 件/时`}</span>
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

function formatBottlenecks(result: PlantLiteStudyRecord): string {
  const items = result.outcome.bottlenecks.slice(0, 2).map((item) => `${item.nodeId} ${(item.probability * 100).toFixed(0)}%`);
  return items.join(" · ") || "数据不足";
}

function formatDelta(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
