import {
  evaluateCompetitiveBenchmark,
  type BenchmarkCase,
  type BenchmarkCriterion,
  type BenchmarkFidelityCheck,
  type CompetitiveEngineSummary,
  type CompetitiveRoundEvidence,
} from "@bim-studio/deep-engine";
import type { BenchmarkBackend, BenchmarkFrameStats } from "./benchmarkBackend.js";
import { assertBenchmarkImage, BENCHMARK_VISUAL_METHOD, perceptualSimilarity,
  type BenchmarkImage } from "./benchmarkImage.js";
import { evaluateBenchmarkFidelity } from "./benchmarkFidelity.js";
import { benchmarkRenderSettings } from "./benchmarkProfile.js";
import { frozenFixtureDescription, type BenchmarkSceneFixture } from "./benchmarkScene.js";

export interface CompetitiveBenchmarkOptions {
  readonly pairRounds: number;
  readonly warmupFrames: number;
  readonly cpuSampleFrames: number;
  readonly gpuSampleFrames: number;
}

export interface CompetitiveBenchmarkProgress {
  readonly round: number;
  readonly engine: BenchmarkBackend["id"];
  readonly phase: "warmup" | "cpu" | "gpu" | "capture";
}

export interface CompetitiveBenchmarkReport {
  readonly schema: 1;
  readonly case: BenchmarkCase;
  readonly fixture: Readonly<Record<string, unknown>>;
  readonly settings: CompetitiveBenchmarkOptions;
  readonly renderSettings: Readonly<Record<string, unknown>>;
  readonly timing: Readonly<{ unit: "milliseconds"; mode: "CPU submit plus serialized per-frame GPU timestamps";
    instrumentationEnabled: boolean; candidateSource: string; referenceSource: string }>;
  readonly visual: typeof BENCHMARK_VISUAL_METHOD;
  readonly fidelity: readonly BenchmarkFidelityCheck[];
  readonly rounds: readonly CompetitiveRoundEvidence[];
  readonly cpuBreakdown: readonly Readonly<{ round: number; candidate: CpuStageSummary;
    reference: CpuStageSummary }>[];
  readonly images: readonly Readonly<{ round: number; candidate: ImageSummary; reference: ImageSummary }>[];
  readonly evaluation: ReturnType<typeof evaluateCompetitiveBenchmark>;
}

interface ImageSummary { readonly sha256: string; readonly meanLuminance: number; readonly geometryDetailFraction: number }
interface Quantiles { readonly p50: number; readonly p95: number; readonly p99: number }
export interface CpuStageSummary { readonly renderCallMs: Quantiles; readonly statisticsReadMs: Quantiles }
interface Measured { readonly summary: CompetitiveEngineSummary; readonly image: BenchmarkImage;
  readonly cpuStages: CpuStageSummary }

export const DEFAULT_COMPETITIVE_BENCHMARK_OPTIONS = Object.freeze({
  pairRounds: 5, warmupFrames: 20, cpuSampleFrames: 90, gpuSampleFrames: 15,
});

export async function runCompetitiveBenchmark(fixture: BenchmarkSceneFixture,
  candidate: BenchmarkBackend, reference: BenchmarkBackend,
  options: CompetitiveBenchmarkOptions = DEFAULT_COMPETITIVE_BENCHMARK_OPTIONS,
  signal?: AbortSignal, progress?: (value: CompetitiveBenchmarkProgress) => void,
  pageErrors: readonly string[] = []): Promise<CompetitiveBenchmarkReport> {
  validateOptions(options); signal?.throwIfAborted();
  if (candidate.profile !== reference.profile) throw new Error("Benchmark profiles differ between engines.");
  const profile = candidate.profile;
  const fidelity = evaluateBenchmarkFidelity(profile, candidate.fidelity, reference.fidelity);
  const fixtureDescription = frozenFixtureDescription(fixture);
  const pairedTimestampSupport = candidate.timestampSupported && reference.timestampSupported;
  const bothGpu = pairedTimestampSupport && options.gpuSampleFrames > 0;
  candidate.setGpuInstrumentation(pairedTimestampSupport);
  reference.setGpuInstrumentation(pairedTimestampSupport);
  const environment = { userAgent: navigator.userAgent, candidate: candidate.adapter, reference: reference.adapter };
  const settings = { ...options, profile, canvas: [fixture.view.width, fixture.view.height], dpr: fixture.view.pixelRatio,
    gpuInstrumentationEnabled: pairedTimestampSupport,
    candidate: `${candidate.id}@${candidate.version}`, reference: `${reference.id}@${reference.version}` };
  const [environmentHash, fixtureHash, settingsHash] = await Promise.all([
    hashJson(environment), hashJson(fixtureDescription), hashJson(settings),
  ]);
  const criteria: BenchmarkCriterion[] = [
    { metric: "cpu-frame-p95-ms", direction: "lower", maxRegressionFraction: 0.05, minImprovementFraction: 0.05 },
    ...(bothGpu ? [{ metric: "gpu-frame-p95-ms" as const, direction: "lower" as const,
      maxRegressionFraction: 0.05, minImprovementFraction: 0.05 }] : []),
    { metric: "visual-similarity", direction: "higher", maxRegressionFraction: 0.08, absoluteMinimum: 0.92 },
  ];
  const definition: BenchmarkCase = Object.freeze({ id: `${fixture.id}/${profile}`, track: "browser-webgpu", critical: true,
    environmentHash, fixtureHash, settingsHash, criteria: Object.freeze(criteria) });
  const rounds: CompetitiveRoundEvidence[] = [], images: CompetitiveBenchmarkReport["images"][number][] = [];
  const cpuBreakdown: CompetitiveBenchmarkReport["cpuBreakdown"][number][] = [];
  for (let index = 0; index < options.pairRounds; index++) {
    signal?.throwIfAborted(); const round = index + 1;
    const order = index % 2 === 0 ? [candidate, reference] as const : [reference, candidate] as const;
    const measured = new Map<BenchmarkBackend["id"], Measured>();
    for (const backend of order) measured.set(backend.id,
      await measureBackend(backend, options, bothGpu, pairedTimestampSupport, round, signal, progress));
    const candidateRun = measured.get(candidate.id)!, referenceRun = measured.get(reference.id)!;
    const visualSimilarity = perceptualSimilarity(candidateRun.image, referenceRun.image);
    rounds.push(Object.freeze({ round, order: index % 2 === 0
      ? ["candidate", "reference"] as const : ["reference", "candidate"] as const,
    environmentHash, fixtureHash, settingsHash, candidate: candidateRun.summary,
    reference: referenceRun.summary, visualSimilarity }));
    images.push(Object.freeze({ round, candidate: imageSummary(candidateRun.image), reference: imageSummary(referenceRun.image) }));
    cpuBreakdown.push(Object.freeze({ round, candidate: candidateRun.cpuStages, reference: referenceRun.cpuStages }));
  }
  const runtimeErrors = [...pageErrors, ...candidate.errors(), ...reference.errors()];
  const evaluation = evaluateCompetitiveBenchmark(definition, rounds, fidelity, runtimeErrors, options.pairRounds);
  return Object.freeze({ schema: 1, case: definition, fixture: compactFixture(fixture, fixtureHash),
    settings: Object.freeze({ ...options }), renderSettings: benchmarkRenderSettings(candidate.fidelity, reference.fidelity),
    timing: Object.freeze({ unit: "milliseconds",
      mode: "CPU submit plus serialized per-frame GPU timestamps",
      instrumentationEnabled: pairedTimestampSupport,
      candidateSource: "Deep GpuTimer: Number(timestampEnd - timestampStart) / 1e6",
      referenceSource: "three@0.185.1 WebGPUTimestampQueryPool: Number(endTime - startTime) / 1e6" }),
    visual: BENCHMARK_VISUAL_METHOD, fidelity, rounds: Object.freeze(rounds),
    cpuBreakdown: Object.freeze(cpuBreakdown),
    images: Object.freeze(images), evaluation });
}

async function measureBackend(backend: BenchmarkBackend, options: CompetitiveBenchmarkOptions,
  bothGpu: boolean, instrumentationEnabled: boolean, round: number, signal?: AbortSignal,
  progress?: (value: CompetitiveBenchmarkProgress) => void): Promise<Measured> {
  progress?.({ round, engine: backend.id, phase: "warmup" });
  let stats: BenchmarkFrameStats = { drawCalls: 0, triangles: 0, resources: 0,
    cpuStages: { renderCallMs: 0, statisticsReadMs: 0 } };
  for (let index = 0; index < options.warmupFrames; index++) {
    signal?.throwIfAborted(); stats = backend.render();
    if (index % 30 === 29) await yieldTask();
  }
  await backend.settle();
  progress?.({ round, engine: backend.id, phase: "cpu" });
  const cpu: number[] = [], renderCall: number[] = [], statisticsRead: number[] = [];
  for (let index = 0; index < options.cpuSampleFrames; index++) {
    signal?.throwIfAborted(); const started = performance.now(); stats = backend.render();
    cpu.push(performance.now() - started); recordCpuStages(stats, renderCall, statisticsRead);
    if (index % 30 === 29) await yieldTask();
  }
  await backend.settle(); const gpu: number[] = [];
  if (bothGpu) {
    progress?.({ round, engine: backend.id, phase: "gpu" });
    for (let index = 0; index < options.gpuSampleFrames; index++) {
      signal?.throwIfAborted(); const value = await backend.measureGpuFrame();
      if (value === null) throw new Error(`${backend.id} lost timestamp support during a paired run.`);
      gpu.push(value);
    }
  }
  progress?.({ round, engine: backend.id, phase: "capture" });
  const image = await backend.capture(); assertBenchmarkImage(image, backend.id);
  const gpuValues = gpu.length ? summarize(gpu) : null;
  const cpuValues = summarize(cpu);
  return Object.freeze({ image, cpuStages: Object.freeze({ renderCallMs: summarize(renderCall),
    statisticsReadMs: summarize(statisticsRead) }), summary: Object.freeze({ engine: backend.id,
    warmupFrames: options.warmupFrames, cpuSampleCount: cpu.length, gpuSampleCount: gpu.length,
    cpuFrameP50Ms: cpuValues.p50, cpuFrameP95Ms: cpuValues.p95, cpuFrameP99Ms: cpuValues.p99,
    gpuFrameP50Ms: gpuValues?.p50 ?? null, gpuFrameP95Ms: gpuValues?.p95 ?? null,
    gpuFrameP99Ms: gpuValues?.p99 ?? null, gpuTimestampUnit: gpuValues ? "milliseconds" : null,
    gpuMeasurementMode: gpuValues ? "serialized-per-frame" : null,
    gpuInstrumentationEnabled: instrumentationEnabled,
    ...stats, deviceErrors: Object.freeze([...backend.errors()]) }) });
}

function recordCpuStages(stats: BenchmarkFrameStats, renderCall: number[], statisticsRead: number[]): void {
  const { renderCallMs, statisticsReadMs } = stats.cpuStages;
  if (![renderCallMs, statisticsReadMs].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error("Benchmark CPU stage samples are invalid.");
  }
  renderCall.push(renderCallMs); statisticsRead.push(statisticsReadMs);
}

function summarize(values: readonly number[]) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error("Benchmark samples are invalid.");
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
  return Object.freeze({ p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) });
}

async function hashJson(value: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(digest), item => item.toString(16).padStart(2, "0")).join("");
}

function imageSummary(image: BenchmarkImage): ImageSummary {
  return Object.freeze({ sha256: image.sha256, meanLuminance: image.meanLuminance,
    geometryDetailFraction: image.geometryDetailFraction });
}
function compactFixture(fixture: BenchmarkSceneFixture, hash: string): Readonly<Record<string, unknown>> {
  const geometry = fixture.packet.geometries[0]!;
  return Object.freeze({ id: fixture.id, sha256: hash, instanceCount: fixture.instanceCount,
    canvas: [fixture.view.width, fixture.view.height], dpr: fixture.view.pixelRatio,
    vertexCount: geometry.vertices.length / 6, triangleCount: geometry.indices.length / 3,
    transformGenerator: "grid-v1/spacing2.1/scale0.74/golden-angle" });
}
function validateOptions(options: CompetitiveBenchmarkOptions): void {
  if (!Number.isSafeInteger(options.pairRounds) || options.pairRounds < 5
    || ![options.warmupFrames, options.cpuSampleFrames, options.gpuSampleFrames]
      .every(value => Number.isSafeInteger(value) && value >= 0)
    || options.warmupFrames < 10 || options.cpuSampleFrames < 30) throw new RangeError("Benchmark sample plan is below the evidence floor.");
}
function yieldTask(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)); }
