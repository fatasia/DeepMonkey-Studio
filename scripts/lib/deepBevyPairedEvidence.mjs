import { createHash } from "node:crypto";
import { quantiles } from "./bevy019BenchmarkEvidence.mjs";

const REQUIRED = ["cpu-frame-p50-ms", "cpu-frame-p95-ms", "cpu-frame-p99-ms",
  "gpu-frame-p50-ms", "gpu-frame-p95-ms", "gpu-frame-p99-ms", "frame-p99-ms",
  "input-latency-p95-ms", "cold-start-ms", "load-to-interactive-ms",
  "long-run-frame-p99-ms", "peak-host-bytes", "peak-gpu-bytes", "visual-similarity"];

export function parseDeepTelemetry(stdout) {
  const marker = "native telemetry report: ";
  const line = stdout.split(/\r?\n/).find(value => value.startsWith(marker));
  if (!line) throw new Error("Deep Native telemetry report is missing");
  const report = JSON.parse(line.slice(marker.length));
  const window = report.metrics?.benchmark_sample_window;
  if (window?.schema !== "deep-engine.benchmark-sample-window") throw new Error("Deep sample window is invalid");
  return { report, frame: samples(window, "frame-interval"), gpu: samples(window, "gpu-timestamp") };
}

export function measurements(cpuSamples, gpuSamples, additions = {}) {
  const cpu = quantiles(cpuSamples), gpu = gpuSamples.length ? quantiles(gpuSamples) : null;
  return { "cpu-frame-p50-ms": cpu.p50, "cpu-frame-p95-ms": cpu.p95, "cpu-frame-p99-ms": cpu.p99,
    "gpu-frame-p50-ms": gpu?.p50 ?? null, "gpu-frame-p95-ms": gpu?.p95 ?? null,
    "gpu-frame-p99-ms": gpu?.p99 ?? null, "frame-p99-ms": cpu.p99,
    "input-latency-p95-ms": additions.inputLatencyP95Ms ?? null,
    "cold-start-ms": additions.coldStartMs ?? null, "load-to-interactive-ms": additions.loadToInteractiveMs ?? null,
    "long-run-frame-p99-ms": additions.longRunFrameP99Ms ?? null,
    "peak-host-bytes": additions.peakHostBytes ?? null, "peak-gpu-bytes": additions.peakGpuBytes ?? null,
    "visual-similarity": additions.visualSimilarity ?? null };
}

export function pairedReport({ rounds, fixture, settings, environment, provenance }) {
  if (!Array.isArray(rounds) || rounds.length < 5) throw new Error("at least five paired rounds are required");
  rounds.forEach((round, index) => {
    const expected = index % 2 === 0 ? "candidate" : "reference";
    if (round.round !== index + 1 || round.order[0] !== expected) throw new Error("paired rounds must alternate");
  });
  const missingRequiredMetrics = REQUIRED.filter(metric => rounds.some(round =>
    !Number.isFinite(round.candidate[metric]) || !Number.isFinite(round.reference[metric])));
  const environmentIssues = compareEnvironment(environment);
  return { schema: "deep-engine.competitive-benchmark.paired-raw", schemaVersion: 2,
    case: { id: `${fixture.id}/native-wgpu`, track: "native-wgpu", reference: "bevy",
      referenceVersion: "0.19.1", environmentHash: hash(environment), fixtureHash: hash(fixture),
      settingsHash: hash(settings) }, environment, fixture, settings, rounds, provenance,
    readiness: { status: missingRequiredMetrics.length || environmentIssues.length ? "incomplete" : "raw-complete",
      pairedAlternatingRounds: rounds.length, missingRequiredMetrics, environmentIssues,
      eligibleForBenchmarkVerdict: false },
    claim: { status: "not-evaluated", passed: false,
      reason: environmentIssues.length ? "Candidate and reference environments are not equivalent."
        : missingRequiredMetrics.length ? "Required paired metrics are missing."
        : "Raw evidence still requires benchmarkContract evaluation." } };
}

function compareEnvironment(environment) {
  const candidate = environment?.candidate ?? {}, reference = environment?.reference ?? {};
  const issues = [];
  if (String(candidate.backend ?? "").toLowerCase() !== String(reference.backend ?? "").toLowerCase()) {
    issues.push(`GPU backend differs: candidate=${candidate.backend ?? "unknown"}, reference=${reference.backend ?? "unknown"}`);
  }
  if (Number(candidate.vendor_id) !== Number(reference.vendor)) issues.push("GPU vendor differs");
  if (Number(candidate.device_id) !== Number(reference.device)) issues.push("GPU device differs");
  if (String(candidate.name ?? "") !== String(reference.name ?? "")) issues.push("GPU adapter name differs");
  return issues;
}

function samples(window, channel) {
  const value = window.channels?.find(entry => entry.channel === channel);
  if (value?.availability !== "measured" || !Array.isArray(value.samplesMs) || !value.samplesMs.length) {
    throw new Error(`Deep telemetry channel ${channel} is unavailable`);
  }
  return value.samplesMs;
}
function hash(value) { return createHash("sha256").update(JSON.stringify(sort(value))).digest("hex"); }
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
