import {
  evaluateBenchmarkCase,
  type BenchmarkCase,
  type BenchmarkCaseResult,
  type BenchmarkMeasurements,
  type BenchmarkPairObservation,
} from "./benchmarkContract.js";

export const COMPETITIVE_RUN_SCHEMA_VERSION = 1 as const;

export type BenchmarkFidelityState = "equivalent" | "degraded" | "invalid";

export interface BenchmarkFidelityCheck {
  readonly id: string;
  readonly state: BenchmarkFidelityState;
  readonly candidate: string;
  readonly reference: string;
  readonly reason?: string;
}

export interface CompetitiveEngineSummary {
  readonly engine: "deep-webgpu" | "three-webgpu" | "babylon-webgpu";
  readonly warmupFrames: number;
  readonly cpuSampleCount: number;
  readonly gpuSampleCount: number;
  readonly cpuFrameP50Ms: number;
  readonly cpuFrameP95Ms: number;
  readonly cpuFrameP99Ms: number;
  readonly gpuFrameP50Ms: number | null;
  readonly gpuFrameP95Ms: number | null;
  readonly gpuFrameP99Ms: number | null;
  readonly gpuTimestampUnit: "milliseconds" | null;
  readonly gpuMeasurementMode: "serialized-per-frame" | null;
  readonly gpuInstrumentationEnabled: boolean;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly resources: number;
  readonly deviceErrors: readonly string[];
}

export interface CompetitiveRoundEvidence {
  readonly round: number;
  readonly order: readonly ["candidate", "reference"] | readonly ["reference", "candidate"];
  readonly environmentHash: string;
  readonly fixtureHash: string;
  readonly settingsHash: string;
  readonly candidate: CompetitiveEngineSummary;
  readonly reference: CompetitiveEngineSummary;
  readonly visualSimilarity: number;
}

export interface CompetitiveBenchmarkEvaluation {
  readonly status: "comparable" | "degraded" | "invalid";
  readonly outcome: "candidate-meets-criteria" | "candidate-does-not-meet-criteria" | "withheld";
  readonly issues: readonly string[];
  readonly benchmark: BenchmarkCaseResult;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

/** Fails closed: runtime faults invalidate evidence and fidelity gaps always suppress ranking. */
export function evaluateCompetitiveBenchmark(
  definition: BenchmarkCase,
  rounds: readonly CompetitiveRoundEvidence[],
  fidelity: readonly BenchmarkFidelityCheck[],
  pageErrors: readonly string[] = [],
  minimumPairs = 5,
): CompetitiveBenchmarkEvaluation {
  const issues = validateFidelity(fidelity);
  if (pageErrors.length) issues.push(...pageErrors.map(error => `page error: ${error}`));
  for (const round of rounds) {
    for (const summary of [round.candidate, round.reference]) {
      issues.push(...validateSummary(summary, round.round));
    }
    if (!Number.isFinite(round.visualSimilarity) || round.visualSimilarity < 0 || round.visualSimilarity > 1) {
      issues.push(`round ${round.round} has invalid visual similarity`);
    }
  }
  issues.push(...validateStableSeries(rounds));
  const benchmark = evaluateBenchmarkCase(definition, rounds.map(observation), minimumPairs);
  issues.push(...benchmark.issues);
  if (benchmark.valid && benchmark.criteria.some(criterion => criterion.metric === "visual-similarity" && !criterion.passed)) {
    issues.push("visual fidelity gate failed");
  }
  const invalid = issues.length > 0 || fidelity.some(check => check.state === "invalid");
  if (invalid) return Object.freeze({ status: "invalid", outcome: "withheld", issues: Object.freeze(issues), benchmark });
  const degraded = fidelity.some(check => check.state === "degraded");
  if (degraded) return Object.freeze({ status: "degraded", outcome: "withheld", issues: Object.freeze([]), benchmark });
  return Object.freeze({
    status: "comparable",
    outcome: benchmark.passed ? "candidate-meets-criteria" : "candidate-does-not-meet-criteria",
    issues: Object.freeze([]), benchmark,
  });
}

function observation(round: CompetitiveRoundEvidence): BenchmarkPairObservation {
  const measurements = (summary: CompetitiveEngineSummary): BenchmarkMeasurements => Object.freeze({
    "cpu-frame-p95-ms": summary.cpuFrameP95Ms,
    ...(summary.gpuFrameP95Ms === null ? {} : { "gpu-frame-p95-ms": summary.gpuFrameP95Ms }),
    "frame-p99-ms": summary.cpuFrameP99Ms,
    "visual-similarity": round.visualSimilarity,
  });
  return Object.freeze({ round: round.round, order: round.order,
    environmentHash: round.environmentHash, fixtureHash: round.fixtureHash, settingsHash: round.settingsHash,
    candidate: measurements(round.candidate), reference: Object.freeze({
      ...measurements(round.reference), "visual-similarity": 1,
    }) });
}

function validateFidelity(checks: readonly BenchmarkFidelityCheck[]): string[] {
  if (!checks.length) return ["fidelity checks are missing"];
  const issues: string[] = [], seen = new Set<string>();
  for (const check of checks) {
    if (!ID.test(check.id) || seen.has(check.id)) issues.push(`invalid or duplicate fidelity check ${check.id}`);
    seen.add(check.id);
    if (!["equivalent", "degraded", "invalid"].includes(check.state)) issues.push(`invalid fidelity state for ${check.id}`);
    if (!check.candidate || !check.reference) issues.push(`fidelity check ${check.id} lacks frozen settings`);
    if (check.state !== "equivalent" && !check.reason) issues.push(`fidelity check ${check.id} lacks a reason`);
  }
  return issues;
}

function validateSummary(summary: CompetitiveEngineSummary, round: number): string[] {
  const issues: string[] = [];
  const finite = [summary.cpuFrameP50Ms, summary.cpuFrameP95Ms, summary.cpuFrameP99Ms,
    summary.drawCalls, summary.triangles, summary.resources];
  if (!finite.every(value => Number.isFinite(value) && value >= 0)) issues.push(`round ${round} ${summary.engine} has invalid metrics`);
  if (![summary.warmupFrames, summary.cpuSampleCount, summary.gpuSampleCount]
    .every(value => Number.isSafeInteger(value) && value >= 0)) issues.push(`round ${round} ${summary.engine} has invalid sample counts`);
  const gpu = [summary.gpuFrameP50Ms, summary.gpuFrameP95Ms, summary.gpuFrameP99Ms];
  if (!gpu.every(value => value === null || (Number.isFinite(value) && value >= 0))
    || (summary.gpuSampleCount === 0) !== gpu.every(value => value === null)
    || (summary.gpuSampleCount === 0) !== (summary.gpuTimestampUnit === null)
    || (summary.gpuSampleCount === 0) !== (summary.gpuMeasurementMode === null)) {
    issues.push(`round ${round} ${summary.engine} has inconsistent GPU timing`);
  }
  if (summary.gpuSampleCount > 0 && !summary.gpuInstrumentationEnabled) {
    issues.push(`round ${round} ${summary.engine} sampled GPU timing without frozen instrumentation`);
  }
  if (summary.deviceErrors.length) issues.push(...summary.deviceErrors.map(error =>
    `round ${round} ${summary.engine} device error: ${error}`));
  return issues;
}

function validateStableSeries(rounds: readonly CompetitiveRoundEvidence[]): string[] {
  const issues: string[] = [];
  for (const side of ["candidate", "reference"] as const) {
    const first = rounds[0]?.[side]; if (!first) continue;
    for (const metric of ["warmupFrames", "cpuSampleCount", "gpuSampleCount", "gpuInstrumentationEnabled",
      "drawCalls", "triangles", "resources"] as const) {
      if (rounds.some(round => round[side][metric] !== first[metric])) {
        issues.push(`${first.engine} ${metric} changed across paired rounds`);
      }
    }
  }
  return issues;
}
