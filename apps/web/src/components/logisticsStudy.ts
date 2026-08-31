import type {
  LogisticsExperimentRequest,
  LogisticsExperimentResult,
} from "@bim-studio/contracts";

export type LogisticsEvidenceStatus = "verified" | "legacy-missing" | "engine-mismatch";
export type LogisticsMetricImpact = "improved" | "worsened" | "unchanged" | "neutral";

export interface LogisticsMetricComparison {
  key: "throughputPerHour" | "fulfilledRate" | "utilization" | "averageWip" | "leadTimeMinutes";
  label: string;
  unit: string;
  baseline: number;
  candidate: number;
  delta: number;
  deltaPercent?: number;
  impact: LogisticsMetricImpact;
}

export interface LogisticsStudyComparison {
  evidenceStatus: LogisticsEvidenceStatus;
  evidenceMessage: string;
  bottleneckChanged: boolean;
  exactReproduction: boolean;
  metrics: LogisticsMetricComparison[];
}

const METRICS: Array<{
  key: LogisticsMetricComparison["key"];
  label: string;
  unit: string;
  better: "higher" | "lower" | "neutral";
}> = [
  { key: "throughputPerHour", label: "吞吐", unit: "件/时", better: "higher" },
  { key: "fulfilledRate", label: "交付率", unit: "%", better: "higher" },
  { key: "utilization", label: "利用率", unit: "%", better: "neutral" },
  { key: "averageWip", label: "平均 WIP", unit: "件", better: "lower" },
  { key: "leadTimeMinutes", label: "交付时长", unit: "分钟", better: "lower" },
];

export function logisticsRequestFromResult(result: LogisticsExperimentResult): LogisticsExperimentRequest {
  return {
    name: result.name,
    agvCount: result.agvCount,
    bufferCapacity: result.bufferCapacity,
    demandPerHour: result.demandPerHour,
    cycleTimeSec: result.cycleTimeSec,
    chargingMinutesPerHour: result.chargingMinutesPerHour,
    congestionFactor: result.congestionFactor,
    durationHours: result.durationHours,
  };
}

export function compareLogisticsStudies(
  baseline: LogisticsExperimentResult,
  candidate: LogisticsExperimentResult,
): LogisticsStudyComparison {
  const evidence = compareExecutionEvidence(baseline, candidate);
  const metrics = METRICS.map((definition) => {
    const baselineValue = baseline[definition.key];
    const candidateValue = candidate[definition.key];
    const delta = candidateValue - baselineValue;
    return {
      key: definition.key,
      label: definition.label,
      unit: definition.unit,
      baseline: baselineValue,
      candidate: candidateValue,
      delta,
      ...(baselineValue !== 0 ? { deltaPercent: delta / Math.abs(baselineValue) * 100 } : {}),
      impact: metricImpact(delta, definition.better),
    };
  });
  const exactMetrics = metrics.every((metric) => Math.abs(metric.delta) < 1e-9);
  return {
    ...evidence,
    bottleneckChanged: baseline.bottleneck !== candidate.bottleneck,
    exactReproduction:
      candidate.reproductionOf === baseline.id
      && evidence.evidenceStatus === "verified"
      && baseline.execution?.inputFingerprint === candidate.execution?.inputFingerprint
      && exactMetrics,
    metrics,
  };
}

function compareExecutionEvidence(
  baseline: LogisticsExperimentResult,
  candidate: LogisticsExperimentResult,
): Pick<LogisticsStudyComparison, "evidenceStatus" | "evidenceMessage"> {
  if (!baseline.execution || !candidate.execution) {
    return {
      evidenceStatus: "legacy-missing",
      evidenceMessage: "历史记录缺少执行引擎证据；数值可查看，但不能宣称严格可复现。",
    };
  }
  if (
    baseline.execution.engineId !== candidate.execution.engineId
    || baseline.execution.engineVersion !== candidate.execution.engineVersion
  ) {
    return {
      evidenceStatus: "engine-mismatch",
      evidenceMessage: "两次运行使用了不同引擎版本；差异可能来自算法变更。",
    };
  }
  return {
    evidenceStatus: "verified",
    evidenceMessage: `${candidate.execution.engineId} ${candidate.execution.engineVersion} · 输入与结果均已留证`,
  };
}

function metricImpact(
  delta: number,
  better: "higher" | "lower" | "neutral",
): LogisticsMetricImpact {
  if (Math.abs(delta) < 1e-9) return "unchanged";
  if (better === "neutral") return "neutral";
  return (delta > 0) === (better === "higher") ? "improved" : "worsened";
}
