import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const BEVY_VERSION = "0.19.1";
export const BEVY_CRATE_SHA256 = "4bfadbebfc6599aa59289b754ac30023959854304f3d393da2cf62bb3cd5df8f";
export const REQUIRED_METRICS = Object.freeze([
  "cpu-frame-p50-ms", "cpu-frame-p95-ms", "cpu-frame-p99-ms",
  "gpu-frame-p50-ms", "gpu-frame-p95-ms", "gpu-frame-p99-ms",
  "frame-p99-ms", "input-latency-p95-ms", "cold-start-ms", "load-to-interactive-ms",
  "long-run-frame-p99-ms", "peak-host-bytes", "peak-gpu-bytes", "visual-similarity",
]);

export function externalCacheRoot(repositoryRoot, environment = process.env) {
  const local = environment.LOCALAPPDATA;
  if (!local) throw new Error("LOCALAPPDATA is required for the isolated Bevy cache");
  const root = path.resolve(environment.BEVY_BENCHMARK_CACHE_ROOT
    ?? path.join(local, "bim-studio-benchmarks", `bevy-${BEVY_VERSION}`));
  const relative = path.relative(path.resolve(repositoryRoot), root);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("Bevy benchmark cache must be outside the repository");
  }
  return root;
}

export async function verifyFrozenSources(repositoryRoot, manifest) {
  if (manifest.bevy.version !== BEVY_VERSION || manifest.bevy.crateSha256 !== BEVY_CRATE_SHA256) {
    throw new Error("Bevy source identity does not match the frozen 0.19.1 release");
  }
  for (const entry of manifest.files) {
    const absolute = path.resolve(repositoryRoot, entry.path);
    const relative = path.relative(path.resolve(repositoryRoot), absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`source escapes repository: ${entry.path}`);
    const actual = sha256(await readFile(absolute));
    if (actual !== entry.sha256) throw new Error(`frozen runner source changed: ${entry.path}`);
  }
  const lock = await readFile(path.resolve(repositoryRoot, manifest.cargoLock), "utf8");
  const checksum = lock.match(/\[\[package\]\]\s+name = "bevy"\s+version = "0\.19\.1"[\s\S]*?checksum = "([a-f0-9]{64})"/)?.[1];
  if (checksum !== BEVY_CRATE_SHA256) throw new Error("Cargo.lock does not pin the expected Bevy crate checksum");
}

export function normalizeRawRun(raw, provenance) {
  validateRawRun(raw);
  const cpu = quantiles(raw.samples.cpuFrameMs);
  const gpu = raw.samples.gpuFrameMs.length ? quantiles(raw.samples.gpuFrameMs) : null;
  const longRun = raw.observations.elapsedSeconds >= 1_800 ? cpu.p99 : null;
  const measurements = {
    "cpu-frame-p50-ms": cpu.p50, "cpu-frame-p95-ms": cpu.p95, "cpu-frame-p99-ms": cpu.p99,
    "gpu-frame-p50-ms": gpu?.p50 ?? null, "gpu-frame-p95-ms": gpu?.p95 ?? null,
    "gpu-frame-p99-ms": gpu?.p99 ?? null, "frame-p99-ms": cpu.p99,
    "input-latency-p95-ms": null, "cold-start-ms": finiteOrNull(raw.observations.coldStartMs),
    "load-to-interactive-ms": finiteOrNull(raw.observations.loadToInteractiveMs),
    "long-run-frame-p99-ms": longRun, "device-recovery-ms": null,
    "peak-host-bytes": raw.observations.peakHostBytes > 0 ? raw.observations.peakHostBytes : null,
    "peak-gpu-bytes": null, "visual-similarity": null,
  };
  const missingRequiredMetrics = REQUIRED_METRICS.filter(metric => measurements[metric] === null);
  const fingerprints = {
    environmentHash: sha256Json(raw.environment), fixtureHash: sha256Json(raw.fixture),
    settingsHash: sha256Json(raw.settings),
  };
  return Object.freeze({ schema: "deep-engine.competitive-benchmark.raw-run", schemaVersion: 2,
    engine: raw.engine, environment: raw.environment, fixture: raw.fixture, settings: raw.settings,
    fingerprints, measurements, samples: raw.samples, observations: raw.observations,
    provenance, readiness: { status: missingRequiredMetrics.length ? "incomplete" : "raw-complete",
      missingRequiredMetrics, pairedAlternatingRounds: 0, eligibleForBenchmarkVerdict: false },
    claim: { status: "not-evaluated", passed: false,
      reason: "A single reference run cannot establish a paired Deep Engine performance verdict." } });
}

export function quantiles(values) {
  if (!Array.isArray(values) || values.length < 1 || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error("benchmark samples must be finite non-negative numbers");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = value => sorted[Math.min(sorted.length - 1, Math.ceil(value * sorted.length) - 1)];
  return { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) };
}

function validateRawRun(raw) {
  if (raw?.schema !== "deep-engine.bevy-raw-run" || raw.schemaVersion !== 1
    || raw.engine?.reference !== "bevy" || raw.engine.version !== BEVY_VERSION
    || raw.engine.track !== "native-wgpu" || !/^wgpu\/vulkan$/i.test(raw.engine.renderer ?? "")) {
    throw new Error("runner output is not the frozen Bevy 0.19.1 Native wgpu/Vulkan schema");
  }
  if (!Array.isArray(raw.samples?.cpuFrameMs) || raw.samples.cpuFrameMs.length < raw.settings.sampleFrames) {
    throw new Error("runner output is below the requested CPU sample floor");
  }
  quantiles(raw.samples.cpuFrameMs);
  if (raw.samples.gpuFrameMs.length) quantiles(raw.samples.gpuFrameMs);
}

function finiteOrNull(value) { return Number.isFinite(value) && value >= 0 ? value : null; }
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function sha256Json(value) { return sha256(Buffer.from(JSON.stringify(sortKeys(value)))); }
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, sortKeys(value[key])]));
  return value;
}
