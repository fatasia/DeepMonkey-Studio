import type { WhatIfStudyRecord, WhatIfStudyRequest } from "@bim-studio/studio-core";

export interface WhatIfDraft {
  name: string;
  metricId: string;
  variableId: string;
  baseline: number;
  changePercent: number;
  elasticity: number;
  reliabilityPercent: number;
  metricMinimum: number;
  metricMaximum: number;
  changeMinimumPercent: number;
  changeMaximumPercent: number;
}

export const DEFAULT_WHAT_IF_DRAFT: WhatIfDraft = {
  name: "产线速度筛查",
  metricId: "throughput",
  variableId: "line-speed",
  baseline: 100,
  changePercent: 10,
  elasticity: 0.8,
  reliabilityPercent: 85,
  metricMinimum: 80,
  metricMaximum: 110,
  changeMinimumPercent: -20,
  changeMaximumPercent: 20,
};

export interface WhatIfMetricComparison {
  metricId: string;
  baseline: number;
  candidate: number;
  delta: number;
}

export interface WhatIfStudyComparison {
  evidenceStatus: "verified" | "legacy-missing" | "engine-mismatch";
  evidenceMessage: string;
  exactReproduction: boolean;
  riskChanged: boolean;
  applicabilityChanged: boolean;
  metrics: WhatIfMetricComparison[];
}

export function whatIfRequestFromDraft(draft: WhatIfDraft): WhatIfStudyRequest {
  const metricId = draft.metricId.trim();
  const variableId = draft.variableId.trim();
  return {
    name: draft.name.trim(),
    input: {
      baselines: [{ metricId, value: draft.baseline }],
      changes: [{ variableId, delta: draft.changePercent / 100, mode: "relative" }],
      elasticities: [{
        variableId,
        metricId,
        coefficient: draft.elasticity,
        inputMode: "relative",
        outputMode: "relative",
        reliability: draft.reliabilityPercent / 100,
        evidenceRef: "user-confirmed-calibration",
      }],
      constraints: [{
        constraintId: `${metricId}-operating-range`,
        metricId,
        minimum: draft.metricMinimum,
        maximum: draft.metricMaximum,
        severity: "critical",
      }],
      applicabilityDomain: {
        variableRanges: [{
          variableId,
          mode: "relative",
          minimumDelta: draft.changeMinimumPercent / 100,
          maximumDelta: draft.changeMaximumPercent / 100,
        }],
        metricRanges: [{
          metricId,
          minimum: draft.metricMinimum,
          maximum: draft.metricMaximum,
        }],
        evidenceRef: "user-confirmed-operating-envelope",
      },
    },
  };
}

export function whatIfDraftFromStudy(study: WhatIfStudyRecord): WhatIfDraft {
  const baseline = study.input.baselines[0];
  const change = study.input.changes[0];
  const elasticity = study.input.elasticities[0];
  const constraint = study.input.constraints.find((item) => item.metricId === baseline?.metricId);
  const variableRange = study.input.applicabilityDomain.variableRanges.find((item) => item.variableId === change?.variableId);
  return {
    name: study.name,
    metricId: baseline?.metricId ?? "throughput",
    variableId: change?.variableId ?? "line-speed",
    baseline: baseline?.value ?? 0,
    changePercent: (change?.delta ?? 0) * (change?.mode === "relative" ? 100 : 1),
    elasticity: elasticity?.coefficient ?? 0,
    reliabilityPercent: (elasticity?.reliability ?? 0) * 100,
    metricMinimum: constraint?.minimum ?? baseline?.value ?? 0,
    metricMaximum: constraint?.maximum ?? baseline?.value ?? 0,
    changeMinimumPercent: (variableRange?.minimumDelta ?? 0) * (variableRange?.mode === "relative" ? 100 : 1),
    changeMaximumPercent: (variableRange?.maximumDelta ?? 0) * (variableRange?.mode === "relative" ? 100 : 1),
  };
}

export function compareWhatIfStudies(
  baseline: WhatIfStudyRecord,
  candidate: WhatIfStudyRecord,
): WhatIfStudyComparison {
  const evidence = compareExecutionEvidence(baseline, candidate);
  const metrics = candidate.result.predictions.flatMap((prediction) => {
    const previous = baseline.result.predictions.find((item) => item.metricId === prediction.metricId);
    return previous ? [{
      metricId: prediction.metricId,
      baseline: previous.predictedValue,
      candidate: prediction.predictedValue,
      delta: prediction.predictedValue - previous.predictedValue,
    }] : [];
  });
  return {
    ...evidence,
    exactReproduction: candidate.reproductionOf === baseline.id
      && evidence.evidenceStatus === "verified"
      && baseline.execution?.inputFingerprint === candidate.execution?.inputFingerprint
      && baseline.result.evidenceFingerprint === candidate.result.evidenceFingerprint,
    riskChanged: baseline.result.risk.level !== candidate.result.risk.level,
    applicabilityChanged: baseline.result.applicability.status !== candidate.result.applicability.status,
    metrics,
  };
}

function compareExecutionEvidence(
  baseline: WhatIfStudyRecord,
  candidate: WhatIfStudyRecord,
): Pick<WhatIfStudyComparison, "evidenceStatus" | "evidenceMessage"> {
  if (!baseline.execution || !candidate.execution) return {
    evidenceStatus: "legacy-missing",
    evidenceMessage: "历史记录缺少执行引擎证据；结果可查看，但不能宣称严格可复现。",
  };
  if (baseline.execution.engineId !== candidate.execution.engineId
    || baseline.execution.engineVersion !== candidate.execution.engineVersion) return {
    evidenceStatus: "engine-mismatch",
    evidenceMessage: "两次运行使用不同引擎版本，结果差异可能来自算法升级。",
  };
  return {
    evidenceStatus: "verified",
    evidenceMessage: `${candidate.execution.engineId} ${candidate.execution.engineVersion} · 输入与结果均已留证`,
  };
}
