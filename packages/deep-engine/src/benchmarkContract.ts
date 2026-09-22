export const COMPETITIVE_BENCHMARK_SCHEMA_VERSION = 2 as const;

export type BenchmarkTrack = "browser-webgpu" | "native-wgpu";
export type BenchmarkReference = "three" | "babylon" | "unity" | "bevy";
export type BenchmarkDirection = "lower" | "higher";
export type BenchmarkMetric =
  | "cpu-frame-p50-ms"
  | "cpu-frame-p95-ms"
  | "cpu-frame-p99-ms"
  | "gpu-frame-p50-ms"
  | "gpu-frame-p95-ms"
  | "gpu-frame-p99-ms"
  | "frame-p99-ms"
  | "input-latency-p95-ms"
  | "cold-start-ms"
  | "load-to-interactive-ms"
  | "long-run-frame-p99-ms"
  | "device-recovery-ms"
  | "peak-host-bytes"
  | "peak-gpu-bytes"
  | "visual-similarity";

/** Bevy 0.19 challenge cases are invalid until all user-visible costs and quality parity are gated. */
export const BEVY_019_REQUIRED_METRICS = Object.freeze([
  "cpu-frame-p50-ms",
  "cpu-frame-p95-ms",
  "cpu-frame-p99-ms",
  "gpu-frame-p50-ms",
  "gpu-frame-p95-ms",
  "gpu-frame-p99-ms",
  "frame-p99-ms",
  "input-latency-p95-ms",
  "cold-start-ms",
  "load-to-interactive-ms",
  "long-run-frame-p99-ms",
  "peak-host-bytes",
  "peak-gpu-bytes",
  "visual-similarity",
] satisfies readonly BenchmarkMetric[]);

export type CapabilityDomain =
  | "rendering"
  | "large-scene"
  | "material-vfx"
  | "animation"
  | "simulation-media-xr"
  | "editor-workflow"
  | "gui-chart-text"
  | "script-plugin-api"
  | "native-delivery"
  | "diagnostics-reliability";

export const CAPABILITY_DOMAIN_WEIGHTS: Readonly<Record<CapabilityDomain, number>> = Object.freeze({
  rendering: 20,
  "large-scene": 15,
  "material-vfx": 10,
  animation: 10,
  "simulation-media-xr": 10,
  "editor-workflow": 10,
  "gui-chart-text": 10,
  "script-plugin-api": 5,
  "native-delivery": 5,
  "diagnostics-reliability": 5,
});

export interface BenchmarkCriterion {
  readonly metric: BenchmarkMetric;
  readonly direction: BenchmarkDirection;
  readonly maxRegressionFraction: number;
  readonly minImprovementFraction?: number;
  readonly absoluteMaximum?: number;
  readonly absoluteMinimum?: number;
}

export interface BenchmarkCase {
  readonly id: string;
  readonly track: BenchmarkTrack;
  readonly reference: BenchmarkReference;
  readonly referenceVersion: string;
  readonly critical: boolean;
  readonly environmentHash: string;
  readonly fixtureHash: string;
  readonly settingsHash: string;
  readonly criteria: readonly BenchmarkCriterion[];
}

export type BenchmarkMeasurements = Partial<Readonly<Record<BenchmarkMetric, number>>>;

export interface BenchmarkPairObservation {
  readonly round: number;
  readonly order: readonly ["candidate", "reference"] | readonly ["reference", "candidate"];
  readonly environmentHash: string;
  readonly fixtureHash: string;
  readonly settingsHash: string;
  readonly candidate: BenchmarkMeasurements;
  readonly reference: BenchmarkMeasurements;
}

export interface BenchmarkCriterionResult {
  readonly metric: BenchmarkMetric;
  readonly candidateMedian: number;
  readonly referenceMedian: number;
  readonly relativeChange: number;
  readonly passed: boolean;
  readonly improved: boolean;
}

export interface BenchmarkCaseResult {
  readonly caseId: string;
  readonly valid: boolean;
  readonly passed: boolean;
  readonly issues: readonly string[];
  readonly criteria: readonly BenchmarkCriterionResult[];
}

export interface CapabilityItem {
  readonly id: string;
  readonly domain: CapabilityDomain;
  readonly weight: number;
  readonly critical: boolean;
  readonly status: "passed" | "failed" | "unverified";
  readonly evidenceIds: readonly string[];
}

export interface CapabilityClaimResult {
  readonly valid: boolean;
  readonly passed: boolean;
  readonly score: number;
  readonly domainScores: Readonly<Record<CapabilityDomain, number>>;
  readonly issues: readonly string[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
const REFERENCES = new Set<BenchmarkReference>(["three", "babylon", "unity", "bevy"]);
const TRACKS = new Set<BenchmarkTrack>(["browser-webgpu", "native-wgpu"]);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function metricChange(direction: BenchmarkDirection, candidate: number, reference: number): number {
  if (direction === "lower") {
    if (reference === 0) return candidate === 0 ? 0 : Number.POSITIVE_INFINITY;
    return candidate / reference - 1;
  }
  if (candidate === 0) return reference === 0 ? 0 : Number.POSITIVE_INFINITY;
  return reference / candidate - 1;
}

function validCriterion(criterion: BenchmarkCriterion): boolean {
  return criterion.maxRegressionFraction >= 0
    && criterion.maxRegressionFraction <= 1
    && (criterion.minImprovementFraction === undefined
      || (criterion.minImprovementFraction >= 0 && criterion.minImprovementFraction <= 1))
    && (criterion.absoluteMaximum === undefined || (Number.isFinite(criterion.absoluteMaximum) && criterion.absoluteMaximum >= 0))
    && (criterion.absoluteMinimum === undefined || (Number.isFinite(criterion.absoluteMinimum) && criterion.absoluteMinimum >= 0))
    && (criterion.absoluteMaximum === undefined || criterion.absoluteMinimum === undefined
      || criterion.absoluteMinimum <= criterion.absoluteMaximum);
}

/**
 * Evaluates paired, alternating runs. This deliberately rejects incomplete evidence instead of
 * converting missing measurements into a favorable score.
 */
export function evaluateBenchmarkCase(
  definition: BenchmarkCase,
  observations: readonly BenchmarkPairObservation[],
  minimumPairs = 5,
): BenchmarkCaseResult {
  const issues: string[] = [];
  if (!ID.test(definition.id)) issues.push("case id is invalid");
  if (!REFERENCES.has(definition.reference)) issues.push("benchmark reference is invalid");
  if (!TRACKS.has(definition.track)) issues.push("benchmark track is invalid");
  if (typeof definition.referenceVersion !== "string" || !definition.referenceVersion.trim()) {
    issues.push("reference version is required");
  }
  if (![definition.environmentHash, definition.fixtureHash, definition.settingsHash].every((hash) => HASH.test(hash))) {
    issues.push("case fingerprints must be lowercase SHA-256 values");
  }
  if (!Number.isSafeInteger(minimumPairs) || minimumPairs < 5) issues.push("minimumPairs must be at least 5");
  if (observations.length < minimumPairs) issues.push(`requires at least ${minimumPairs} paired rounds`);
  if (!definition.criteria.length) issues.push("case has no criteria");
  const metricIds = new Set<BenchmarkMetric>();
  for (const criterion of definition.criteria) {
    if (metricIds.has(criterion.metric)) issues.push(`duplicate criterion ${criterion.metric}`);
    metricIds.add(criterion.metric);
    if (!validCriterion(criterion)) issues.push(`invalid criterion ${criterion.metric}`);
  }
  if (definition.reference === "bevy") {
    if (definition.track !== "native-wgpu") issues.push("Bevy 0.19 challenge must use the native-wgpu track");
    if (typeof definition.referenceVersion !== "string" || !/^0\.19(?:\.|$)/.test(definition.referenceVersion)) {
      issues.push("Bevy challenge must pin a 0.19 release");
    }
    for (const metric of BEVY_019_REQUIRED_METRICS) {
      if (!metricIds.has(metric)) issues.push(`Bevy 0.19 challenge lacks required criterion ${metric}`);
    }
    for (const metric of ["cpu-frame-p95-ms", "cpu-frame-p99-ms", "gpu-frame-p95-ms", "gpu-frame-p99-ms"] as const) {
      const criterion = definition.criteria.find((item) => item.metric === metric);
      if (criterion && !(criterion.minImprovementFraction && criterion.minImprovementFraction > 0)) {
        issues.push(`Bevy 0.19 challenge must require a measured improvement for ${metric}`);
      }
    }
    for (const criterion of definition.criteria) {
      const expectedDirection = criterion.metric === "visual-similarity" ? "higher" : "lower";
      if (criterion.direction !== expectedDirection) {
        issues.push(`Bevy 0.19 challenge uses the wrong direction for ${criterion.metric}`);
      }
    }
    const visual = definition.criteria.find((item) => item.metric === "visual-similarity");
    if (visual && (visual.absoluteMinimum === undefined || visual.absoluteMinimum < 0.98)) {
      issues.push("Bevy 0.19 challenge requires visual similarity of at least 0.98");
    }
  }

  const rounds = new Set<number>();
  observations.forEach((observation, index) => {
    if (!Number.isSafeInteger(observation.round) || observation.round < 1 || rounds.has(observation.round)) {
      issues.push(`round ${index + 1} is invalid or duplicated`);
    }
    rounds.add(observation.round);
    if (observation.round !== index + 1) issues.push("rounds must be supplied in ascending sequence from 1");
    const expectedOrder = index % 2 === 0 ? "candidate" : "reference";
    if (observation.order[0] !== expectedOrder) issues.push(`round ${observation.round} does not alternate execution order`);
    if (observation.environmentHash !== definition.environmentHash
      || observation.fixtureHash !== definition.fixtureHash
      || observation.settingsHash !== definition.settingsHash) {
      issues.push(`round ${observation.round} does not match frozen fingerprints`);
    }
    for (const metric of metricIds) {
      const candidate = observation.candidate[metric];
      const reference = observation.reference[metric];
      if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0
        || typeof reference !== "number" || !Number.isFinite(reference) || reference < 0) {
        issues.push(`round ${observation.round} lacks finite non-negative ${metric}`);
      }
    }
  });
  const orderedRounds = [...rounds].sort((left, right) => left - right);
  if (orderedRounds.some((round, index) => round !== index + 1)) issues.push("round numbers must be consecutive from 1");

  if (issues.length) return { caseId: definition.id, valid: false, passed: false, issues, criteria: [] };
  const criteria = definition.criteria.map((criterion): BenchmarkCriterionResult => {
    const candidateMedian = median(observations.map((item) => item.candidate[criterion.metric]!));
    const referenceMedian = median(observations.map((item) => item.reference[criterion.metric]!));
    const relativeChange = metricChange(criterion.direction, candidateMedian, referenceMedian);
    const absolutePassed = (criterion.absoluteMaximum === undefined || candidateMedian <= criterion.absoluteMaximum)
      && (criterion.absoluteMinimum === undefined || candidateMedian >= criterion.absoluteMinimum);
    const improved = criterion.minImprovementFraction === undefined
      || relativeChange <= -criterion.minImprovementFraction;
    return {
      metric: criterion.metric,
      candidateMedian,
      referenceMedian,
      relativeChange,
      passed: relativeChange <= criterion.maxRegressionFraction && absolutePassed && improved,
      improved,
    };
  });
  return {
    caseId: definition.id,
    valid: true,
    passed: criteria.every((criterion) => criterion.passed),
    issues,
    criteria,
  };
}

/** Evaluates one separately frozen Unity or Bevy capability matrix. */
export function evaluateCapabilityClaim(items: readonly CapabilityItem[]): CapabilityClaimResult {
  const validationIssues: string[] = [];
  const claimIssues: string[] = [];
  const seen = new Set<string>();
  const domainWeights = Object.fromEntries(Object.keys(CAPABILITY_DOMAIN_WEIGHTS).map((domain) => [domain, 0])) as Record<CapabilityDomain, number>;
  const passedWeights = { ...domainWeights };
  for (const item of items) {
    if (!ID.test(item.id) || seen.has(item.id)) validationIssues.push(`invalid or duplicate capability id ${item.id}`);
    seen.add(item.id);
    if (!(item.domain in CAPABILITY_DOMAIN_WEIGHTS)) {
      validationIssues.push(`invalid domain for ${item.id}`);
      continue;
    }
    if (!Number.isFinite(item.weight) || item.weight <= 0) validationIssues.push(`invalid weight for ${item.id}`);
    else {
      domainWeights[item.domain] += item.weight;
      if (item.status === "passed" && item.evidenceIds.length > 0) passedWeights[item.domain] += item.weight;
    }
    if (!["passed", "failed", "unverified"].includes(item.status)) validationIssues.push(`invalid status for ${item.id}`);
    if (!Array.isArray(item.evidenceIds) || item.evidenceIds.some((evidenceId) => !ID.test(evidenceId))) {
      validationIssues.push(`invalid evidence ids for ${item.id}`);
    }
    if (item.status === "passed" && item.evidenceIds.length === 0) validationIssues.push(`passed capability ${item.id} has no evidence`);
    if (item.critical && item.status !== "passed") claimIssues.push(`critical capability ${item.id} did not pass`);
  }
  for (const domain of Object.keys(CAPABILITY_DOMAIN_WEIGHTS) as CapabilityDomain[]) {
    if (Math.abs(domainWeights[domain] - CAPABILITY_DOMAIN_WEIGHTS[domain]) > 1e-9) {
      validationIssues.push(`${domain} weights must total ${CAPABILITY_DOMAIN_WEIGHTS[domain]}`);
    }
  }
  const domainScores = Object.fromEntries((Object.keys(CAPABILITY_DOMAIN_WEIGHTS) as CapabilityDomain[]).map((domain) => [
    domain,
    domainWeights[domain] === 0 ? 0 : passedWeights[domain] / domainWeights[domain] * 100,
  ])) as Record<CapabilityDomain, number>;
  const score = Object.values(passedWeights).reduce((total, weight) => total + weight, 0);
  if (score < 90) claimIssues.push("overall capability score is below 90");
  for (const [domain, domainScore] of Object.entries(domainScores)) {
    if (domainScore < 80) claimIssues.push(`${domain} capability score is below 80`);
  }
  return {
    valid: validationIssues.length === 0,
    passed: validationIssues.length === 0 && claimIssues.length === 0,
    score,
    domainScores,
    issues: [...validationIssues, ...claimIssues],
  };
}
