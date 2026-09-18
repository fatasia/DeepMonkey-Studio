import { AlertTriangle, Cpu, Database, ShieldCheck } from "lucide-react";
import { BatteryAnalysisReport } from "./BatteryAnalysisReport";
import { BatteryTrend } from "./BatteryTrend";
import {
  batteryReferencePoints,
  batteryTrendPoints,
} from "./batteryResultPresentation";
import {
  batteryCombinedConfidence,
  batteryConfidenceDiagnostics,
  batteryVerificationChecks,
  mergeUniqueText,
  type BatteryVerificationInput,
} from "./batteryVerification";
import type { BatteryTask } from "./batteryIntelligenceConfig";
import {
  confidenceLabel,
  expertRoutingLabel,
  finiteNumber,
  hasMetric,
  objectValue,
  resultMetrics,
  resultSummary,
  runtimeLabel,
  stringArray,
} from "./batteryResultFormatters";

interface ResultContext {
  nominalCapacityAh?: number | undefined;
  referenceCycleLife?: number | undefined;
}

export function BatteryPredictionResult({ task, result, nominalCapacityAh, referenceCycleLife }: ResultContext & {
  task: BatteryTask;
  result: Record<string, unknown>;
}) {
  const metrics = resultMetrics(task, result);
  const trend = batteryTrendPoints(task, result);
  const reference = batteryReferencePoints(task, result);
  const threshold = task === "rul" ? finiteNumber(objectValue(result.rulObservation)?.targetThresholdPct) : undefined;
  const runtime = objectValue(result.runtimeExecution);
  const routing = objectValue(result.expertRouting);
  const sourceEvidence = objectValue(result.sourceEvidence);
  const warnings = stringArray(result.warnings);
  const checks = batteryVerificationChecks({
    ...(task === "soc" ? { soc: result } : {}),
    ...(task === "soh" ? { soh: result } : {}),
    ...(task === "rul" ? { rul: result } : {}),
    ...(nominalCapacityAh !== undefined ? { nominalCapacityAh } : {}),
    ...(referenceCycleLife !== undefined ? { referenceCycleLife } : {}),
  });
  return (
    <article className={`battery-result confidence-${String(result.confidence ?? "unknown")}`}>
      <ResultHeading title="分析结论" confidence={result.confidence} routing={routing} runtime={runtime} />
      <div className="battery-metrics">
        {metrics.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>)}
      </div>
      {sourceEvidence && <SourceProof evidence={sourceEvidence} />}
      {trend.length > 1 && <BatteryTrend task={task} points={trend} reference={reference} thresholdY={threshold} />}
      {resultSummary(task, result) && <p>{resultSummary(task, result)}</p>}
      {checks.length > 0 && <BatteryVerificationList checks={checks} />}
      <BatteryAnalysisReport result={result} />
      {routing?.reviewRequired === true && <ReviewNotice />}
      {warnings.length > 0 && <ul>{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
    </article>
  );
}

export function BatteryCombinedResult({ result, nominalCapacityAh, referenceCycleLife, thresholdHint }: ResultContext & {
  result: Record<string, unknown>;
  thresholdHint?: number | undefined;
}) {
  const soc = objectValue(result.soc);
  const soh = objectValue(result.soh);
  const rul = objectValue(result.rul);
  const failures = Array.isArray(result.failures)
    ? (result.failures as Array<{ label: string; message: string }>)
    : [];
  const verificationInput: BatteryVerificationInput = {
    ...(soc ? { soc } : {}),
    ...(soh ? { soh } : {}),
    ...(rul ? { rul } : {}),
    ...(nominalCapacityAh !== undefined ? { nominalCapacityAh } : {}),
    ...(referenceCycleLife !== undefined ? { referenceCycleLife } : {}),
  };
  const confidence = batteryCombinedConfidence(verificationInput);
  const checks = batteryVerificationChecks(verificationInput);
  const diagnostics = batteryConfidenceDiagnostics(verificationInput);
  const warnings = mergeUniqueText(soc?.warnings, soh?.warnings, rul?.warnings);
  const routing = objectValue(rul?.expertRouting);
  const runtime = objectValue(rul?.runtimeExecution) ?? objectValue(soh?.runtimeExecution) ?? objectValue(soc?.runtimeExecution);
  const sourceEvidence = objectValue(rul?.sourceEvidence) ?? objectValue(soh?.sourceEvidence) ?? objectValue(soc?.sourceEvidence);
  const socTrend = soc ? batteryTrendPoints("soc", soc) : [];
  const socReference = soc ? batteryReferencePoints("soc", soc) : [];
  const rulTrend = rul ? batteryTrendPoints("rul", rul) : [];
  const threshold = finiteNumber(objectValue(rul?.rulObservation)?.targetThresholdPct) ?? thresholdHint;
  const groups: Array<{ task: "soc" | "soh" | "rul"; name: string; output: Record<string, unknown>; extra: Array<{ label: string; value: string }> }> = [];
  if (soc) groups.push({ task: "soc", name: "SOC · SOCFormer", output: soc, extra: [] });
  if (soh) groups.push({ task: "soh", name: "SOH · BMSFormer", output: soh, extra: [] });
  if (rul) groups.push({ task: "rul", name: "RUL · BatteryMFormer", output: rul, extra: [remainingLifeMetric(rul)].filter(hasMetric) });
  const summaries = groups.flatMap(group => typeof group.output.summary === "string" ? [`${group.name.split(" · ")[0]}：${group.output.summary}`] : []);
  return (
    <article className={`battery-result battery-result-combined confidence-${confidence ?? "unknown"}`}>
      <ResultHeading title="综合结论" confidence={confidence} routing={routing} runtime={runtime} />
      {failures.length > 0 && (
        <p className="operations-notice"><AlertTriangle size={14} />{failures.map(item => `${item.label} 模型未完成：${item.message}`).join("；")}。其余结果仍按独立置信展示。</p>
      )}
      <div className="battery-combined-groups">
        {groups.map(group => (
          <section key={group.task}>
            <header><span>{group.name}</span><small>{confidenceLabel(group.output.confidence)}</small></header>
            <div className="battery-metrics">
              {[...resultMetrics(group.task, group.output), ...group.extra].map(metric => (
                <div key={metric.label}><span>{metric.label}</span><strong>{metric.value}</strong></div>
              ))}
            </div>
          </section>
        ))}
      </div>
      {sourceEvidence && <SourceProof evidence={sourceEvidence} />}
      {(socTrend.length > 1 || rulTrend.length > 1) && (
        <div className="battery-trend-grid">
          {socTrend.length > 1 && <BatteryTrend task="soc" points={socTrend} reference={socReference} />}
          {rulTrend.length > 1 && <BatteryTrend task="rul" points={rulTrend} thresholdY={threshold} />}
        </div>
      )}
      {summaries.map(summary => <p key={summary}>{summary}</p>)}
      {checks.length > 0 && <div className="battery-subsection"><span>结论核验</span><BatteryVerificationList checks={checks} /></div>}
      {diagnostics.length > 0 && (
        <div className="battery-subsection">
          <span>逐模型置信诊断</span>
          <div className="battery-diagnostics">
            {diagnostics.map(item => (
              <div key={item.task}>
                <span>{item.name}</span><b>{item.version}</b>
                <small>{confidenceLabel(item.confidence)} · {item.runtime}</small>
                <p>{item.reason}</p>
              </div>
            ))}
          </div>
        </div>
      )}
      {(rul ?? soh) && <BatteryAnalysisReport result={(rul ?? soh)!} />}
      {routing?.reviewRequired === true && <ReviewNotice />}
      {warnings.length > 0 && <ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    </article>
  );
}

function ResultHeading({ title, confidence, routing, runtime }: {
  title: string;
  confidence: unknown;
  routing: Record<string, unknown> | undefined;
  runtime: Record<string, unknown> | undefined;
}) {
  return (
    <div className="battery-result-heading">
      <div><span>{title}</span><strong>{confidenceLabel(confidence)}</strong></div>
      <div>
        {routing && <small><ShieldCheck size={13} />{expertRoutingLabel(routing)}</small>}
        {runtime && <small><Cpu size={13} />{runtimeLabel(runtime)}</small>}
      </div>
    </div>
  );
}

function SourceProof({ evidence }: { evidence: Record<string, unknown> }) {
  return (
    <p className="operations-source-proof">
      <Database size={14} />
      数据证据：{String(evidence.datasetName ?? evidence.datasetId ?? "数据集")} · {String(evidence.connectionType ?? "连接")} · {String(evidence.rowCount ?? 0)} 行
    </p>
  );
}

function BatteryVerificationList({ checks }: { checks: ReturnType<typeof batteryVerificationChecks> }) {
  return (
    <div className="battery-verify">
      {checks.map(check => (
        <div key={check.id} className={`is-${check.status}`}>
          <i aria-hidden="true" />
          <div><span>{check.name}</span><small>{check.detail}</small></div>
          <strong>{check.value}</strong>
        </div>
      ))}
    </div>
  );
}

function remainingLifeMetric(rul: Record<string, unknown>): { label: string; value: string } {
  const predicted = finiteNumber(rul.predictedCycleLife);
  const observed = finiteNumber(objectValue(rul.rulObservation)?.observedSurvivalCycles);
  return {
    label: "预计剩余",
    value: predicted !== undefined && observed !== undefined ? `${Math.max(0, predicted - observed).toFixed(0)} 圈` : "",
  };
}

function ReviewNotice() {
  return <p className="operations-notice"><AlertTriangle size={14} />专家分歧超过保护阈值，当前结果需复核。</p>;
}
