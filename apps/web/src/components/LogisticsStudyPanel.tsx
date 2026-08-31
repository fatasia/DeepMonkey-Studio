import { Copy, History, RotateCcw, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useMemo, useState } from "react";
import type { LogisticsExperimentRequest, LogisticsExperimentResult } from "@bim-studio/contracts";
import { LogisticsCard, OperationsEmpty } from "./operationsPresentation";
import { compareLogisticsStudies, logisticsRequestFromResult } from "./logisticsStudy";

export function LogisticsStudyPanel({
  results,
  busy,
  onLoadInputs,
  onReproduce,
}: {
  results: LogisticsExperimentResult[];
  busy: boolean;
  onLoadInputs: (request: LogisticsExperimentRequest) => void;
  onReproduce: (experimentId: string) => void;
}) {
  const latest = results[0];
  const baselines = latest ? results.filter((item) => item.id !== latest.id) : [];
  const [selectedBaselineId, setSelectedBaselineId] = useState("");
  const baseline = useMemo(() => {
    if (!latest) return undefined;
    return baselines.find((item) => item.id === selectedBaselineId)
      ?? baselines.find((item) => item.id === latest.reproductionOf)
      ?? baselines[0];
  }, [baselines, latest, selectedBaselineId]);
  const comparison = latest && baseline ? compareLogisticsStudies(baseline, latest) : undefined;

  return (
    <section className="operations-panel logistics-study-panel">
      <header>
        <div>
          <strong>Study 结果与对比</strong>
          <small>每次运行独立留存；可载入历史参数或创建一条精确复现记录。</small>
        </div>
        <History size={17} aria-hidden="true" />
      </header>
      {!latest ? (
        <OperationsEmpty text="运行第一个工况后，这里会显示结果证据、历史对比和复现入口。" />
      ) : (
        <>
          <LogisticsCard result={latest} />
          <ExecutionEvidence result={latest} />
          {baseline && comparison ? (
            <div className="logistics-comparison">
              <label>
                <span>对比基线</span>
                <select value={baseline.id} onChange={(event) => setSelectedBaselineId(event.target.value)}>
                  {baselines.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {formatTime(item.createdAt)}
                    </option>
                  ))}
                </select>
              </label>
              <div className={`logistics-evidence ${comparison.evidenceStatus}`}>
                {comparison.evidenceStatus === "verified" ? <ShieldCheck size={15} /> : <ShieldQuestion size={15} />}
                <span>
                  {comparison.exactReproduction ? "复现校验通过：输入、引擎版本和关键结果完全一致。" : comparison.evidenceMessage}
                </span>
              </div>
              <div className="logistics-metric-table" role="table" aria-label="物流仿真对比">
                {comparison.metrics.map((metric) => (
                  <div key={metric.key} className={metric.impact} role="row">
                    <span role="cell">{metric.label}</span>
                    <strong role="cell">{formatMetric(metric.candidate, metric.unit)}</strong>
                    <small role="cell">{formatDelta(metric.delta, metric.unit)}</small>
                  </div>
                ))}
              </div>
              <p className="logistics-bottleneck-change">
                瓶颈：{baseline.bottleneck} → {latest.bottleneck}
                {comparison.bottleneckChanged ? "（已变化）" : "（未变化）"}
              </p>
              <div className="operations-inline-actions">
                <button disabled={busy} onClick={() => onLoadInputs(logisticsRequestFromResult(baseline))}>
                  <Copy size={14} />载入基线参数
                </button>
                <button disabled={busy} onClick={() => onReproduce(baseline.id)}>
                  <RotateCcw size={14} />精确复现基线
                </button>
              </div>
            </div>
          ) : (
            <p className="logistics-first-run">再运行一个不同工况，即可获得基线对比；当前结果已可作为后续基线。</p>
          )}
          <details className="logistics-history">
            <summary>运行历史（{results.length}）</summary>
            <div>
              {results.slice(0, 8).map((item) => (
                <button key={item.id} disabled={item.id === latest.id} onClick={() => setSelectedBaselineId(item.id)}>
                  <span>{item.name}</span>
                  <small>{formatTime(item.createdAt)} · {item.throughputPerHour.toFixed(0)} 件/时</small>
                </button>
              ))}
            </div>
          </details>
        </>
      )}
    </section>
  );
}

function ExecutionEvidence({ result }: { result: LogisticsExperimentResult }) {
  if (!result.execution) {
    return <div className="logistics-evidence legacy-missing"><ShieldQuestion size={15} />旧记录缺少引擎证据，不标记为可复现。</div>;
  }
  return (
    <div className="logistics-evidence verified">
      <ShieldCheck size={15} />
      <span>{result.execution.engineId} {result.execution.engineVersion} · {result.execution.inputFingerprint.slice(0, 12)}</span>
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

function formatMetric(value: number, unit: string): string {
  const display = unit === "%" ? value * 100 : value;
  return `${display.toFixed(unit === "%" ? 1 : 1)} ${unit}`;
}

function formatDelta(delta: number, unit: string): string {
  const display = unit === "%" ? delta * 100 : delta;
  const sign = display > 0 ? "+" : "";
  return `${sign}${display.toFixed(1)} ${unit}`;
}
