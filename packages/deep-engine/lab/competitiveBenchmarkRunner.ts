import {
  evaluateCompetitiveBenchmark,
  compareBenchmarkWindows,
  type BenchmarkChannelGap,
  type BenchmarkCase,
  type BenchmarkCriterion,
  type BenchmarkFidelityCheck,
  type CompetitiveEngineSummary,
  type CompetitiveRoundEvidence,
  type SampleWindow,
  type BenchmarkTrajectory,
  type TrajectoryCameraPose,
} from "@bim-studio/deep-engine";
import type { BenchmarkBackend, BenchmarkFrameStats } from "./benchmarkBackend.js";
import { assertBenchmarkImage, BENCHMARK_VISUAL_METHOD, perceptualSimilarity,
  type BenchmarkImage } from "./benchmarkImage.js";
import { evaluateBenchmarkFidelity } from "./benchmarkFidelity.js";
import { benchmarkRenderSettings } from "./benchmarkProfile.js";
import type { BenchmarkSceneFixture } from "./benchmarkScene.js";
import { benchmarkFixtureIdentity } from "./benchmarkFixtureIdentity.js";
import { benchmarkRawWindow } from "./benchmarkRawWindow.js";
import { createBenchmarkTrajectoryReplay } from "./benchmarkTrajectoryReplay.js";

export interface CompetitiveBenchmarkOptions {
  readonly pairRounds: number;
  readonly warmupFrames: number;
  readonly cpuSampleFrames: number;
  readonly gpuSampleFrames: number;
  /**
   * 长稳相位时长（分钟，墙钟）。缺省/0 = 关闭；正式 V4 口径 30 分钟。
   * 开启时在配对轮次全部完成后，对 candidate/reference 串行各渲染指定墙钟时长，
   * 以帧间隔（含调度让步）口径采 long-run-frame-p99，注入收尾轮次双侧 summary。
   */
  readonly longRunMinutes?: number;
  readonly trajectory?: BenchmarkTrajectory;
  /** Declared provenance of each GPU timestamp channel; the Deep/Three defaults keep the A04 wording. */
  readonly timingSources?: { readonly candidateSource: string; readonly referenceSource: string };
}

export interface CompetitiveBenchmarkProgress {
  readonly round: number;
  readonly engine: BenchmarkBackend["id"];
  readonly phase: "warmup" | "cpu" | "gpu" | "capture" | "long-run";
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
  readonly longRun: CompetitiveLongRunEvidence | null;
  readonly sampleWindows: readonly Readonly<{ round: number; candidate: SampleWindow; reference: SampleWindow }>[];
  readonly channelGaps: readonly BenchmarkChannelGap[];
  readonly cpuBreakdown: readonly Readonly<{ round: number; candidate: CpuStageSummary;
    reference: CpuStageSummary }>[];
  readonly images: readonly Readonly<{ round: number; candidate: ImageSummary; reference: ImageSummary }>[];
  readonly evaluation: ReturnType<typeof evaluateCompetitiveBenchmark>;
}

interface ImageSummary { readonly sha256: string; readonly meanLuminance: number; readonly geometryDetailFraction: number }
interface Quantiles { readonly p50: number; readonly p95: number; readonly p99: number }
export interface CpuStageSummary { readonly renderCallMs: Quantiles; readonly statisticsReadMs: Quantiles }
interface Measured { readonly summary: CompetitiveEngineSummary; readonly image: BenchmarkImage;
  readonly cpuStages: CpuStageSummary; readonly window: SampleWindow }

/** 单引擎长稳相位证据：帧间隔分位数（含调度让步）+ 样本量 + 实际墙钟。 */
export interface CompetitiveLongRunEngineEvidence {
  readonly frameP50Ms: number;
  readonly frameP95Ms: number;
  readonly frameP99Ms: number;
  readonly sampleCount: number;
  readonly wallClockMs: number;
}

/** 长稳相位汇总：candidate/reference 串行各渲染 longRunMinutes 分钟墙钟。 */
export interface CompetitiveLongRunEvidence {
  readonly minutes: number;
  readonly sampleMode: "frame-interval-including-yield";
  readonly candidate: CompetitiveLongRunEngineEvidence;
  readonly reference: CompetitiveLongRunEngineEvidence;
}

export const DEFAULT_COMPETITIVE_BENCHMARK_OPTIONS = Object.freeze({
  pairRounds: 5, warmupFrames: 20, cpuSampleFrames: 90, gpuSampleFrames: 15,
});

export async function runCompetitiveBenchmark(fixture: BenchmarkSceneFixture,
  candidate: BenchmarkBackend, reference: BenchmarkBackend,
  options: CompetitiveBenchmarkOptions = DEFAULT_COMPETITIVE_BENCHMARK_OPTIONS,
  signal?: AbortSignal, progress?: (value: CompetitiveBenchmarkProgress) => void,
  pageErrors: readonly string[] = []): Promise<CompetitiveBenchmarkReport> {
  validateOptions(options); signal?.throwIfAborted();
  if (candidate.id === reference.id) throw new Error("Paired benchmark requires distinct candidate and reference backends.");
  if (candidate.profile !== reference.profile) throw new Error("Benchmark profiles differ between engines.");
  const profile = candidate.profile;
  if (options.trajectory && (!candidate.setCamera || !reference.setCamera)) throw new Error("Both benchmark adapters must support camera replay.");
  const replay = options.trajectory ? createBenchmarkTrajectoryReplay(fixture, options.trajectory) : undefined;
  const fidelity = evaluateBenchmarkFidelity(profile, candidate.fidelity, reference.fidelity);
  const fixtureDescription = await benchmarkFixtureIdentity(fixture);
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
  const definition: BenchmarkCase = Object.freeze({ id: `${fixture.id}/${profile}`, track: "browser-webgpu",
    reference: "three", referenceVersion: reference.version, critical: true,
    environmentHash, fixtureHash, settingsHash, criteria: Object.freeze(criteria) });
  const rounds: CompetitiveRoundEvidence[] = [], images: CompetitiveBenchmarkReport["images"][number][] = [];
  const cpuBreakdown: CompetitiveBenchmarkReport["cpuBreakdown"][number][] = [];
  const sampleWindows: CompetitiveBenchmarkReport["sampleWindows"][number][] = [];
  for (let index = 0; index < options.pairRounds; index++) {
    signal?.throwIfAborted(); const round = index + 1;
    const order = index % 2 === 0 ? [candidate, reference] as const : [reference, candidate] as const;
    const measured = new Map<BenchmarkBackend["id"], Measured>();
    for (const backend of order) measured.set(backend.id,
      await measureBackend(backend, options, bothGpu, pairedTimestampSupport, round, signal, progress, replay));
    const candidateRun = measured.get(candidate.id)!, referenceRun = measured.get(reference.id)!;
    const visualSimilarity = perceptualSimilarity(candidateRun.image, referenceRun.image);
    sampleWindows.push({ round, candidate: candidateRun.window, reference: referenceRun.window });
    rounds.push(Object.freeze({ round, order: index % 2 === 0
      ? ["candidate", "reference"] as const : ["reference", "candidate"] as const,
    environmentHash, fixtureHash, settingsHash, candidate: candidateRun.summary,
    reference: referenceRun.summary, visualSimilarity }));
    images.push(Object.freeze({ round, candidate: imageSummary(candidateRun.image), reference: imageSummary(referenceRun.image) }));
    cpuBreakdown.push(Object.freeze({ round, candidate: candidateRun.cpuStages, reference: referenceRun.cpuStages }));
  }
  // 长稳相位（可选）：配对轮次全部完成后，candidate/reference 串行各渲染 longRunMinutes
  // 分钟墙钟。结果注入收尾轮次双侧 summary（longRunFrameP99Ms）并随报告携带完整元数据；
  // 非收尾轮次不回填该字段——只有实际被长稳测量覆盖的轮次才允许携带，防止覆盖度虚标。
  const longRun = options.longRunMinutes && options.longRunMinutes > 0
    ? await runLongRunPhase(candidate, reference, options, signal, progress, replay)
    : null;
  if (longRun) {
    const last = rounds[rounds.length - 1]!;
    rounds[rounds.length - 1] = Object.freeze({ ...last,
      candidate: Object.freeze({ ...last.candidate, longRunFrameP99Ms: longRun.candidate.frameP99Ms }),
      reference: Object.freeze({ ...last.reference, longRunFrameP99Ms: longRun.reference.frameP99Ms }) });
  }
  const runtimeErrors = [...pageErrors, ...candidate.errors(), ...reference.errors()];
  const evaluation = evaluateCompetitiveBenchmark(definition, rounds, fidelity, runtimeErrors, options.pairRounds);
  return Object.freeze({ schema: 1, case: definition, fixture: compactFixture(fixture, fixtureHash),
    settings: Object.freeze({ ...options }), renderSettings: benchmarkRenderSettings(candidate.fidelity, reference.fidelity),
    timing: Object.freeze({ unit: "milliseconds",
      mode: "CPU submit plus serialized per-frame GPU timestamps",
      instrumentationEnabled: pairedTimestampSupport,
      candidateSource: options.timingSources?.candidateSource
        ?? "Deep GpuTimer: Number(timestampEnd - timestampStart) / 1e6",
      referenceSource: options.timingSources?.referenceSource
        ?? "three@0.185.1 WebGPUTimestampQueryPool: Number(endTime - startTime) / 1e6" }),
    visual: BENCHMARK_VISUAL_METHOD, fidelity, rounds: Object.freeze(rounds),
    longRun,
    sampleWindows: Object.freeze(sampleWindows),
    channelGaps: compareBenchmarkWindows(sampleWindows),
    cpuBreakdown: Object.freeze(cpuBreakdown),
    images: Object.freeze(images), evaluation });
}

async function measureBackend(backend: BenchmarkBackend, options: CompetitiveBenchmarkOptions,
  bothGpu: boolean, instrumentationEnabled: boolean, round: number, signal?: AbortSignal,
  progress?: (value: CompetitiveBenchmarkProgress) => void,
  replay?: (frame: number, count: number) => TrajectoryCameraPose): Promise<Measured> {
  progress?.({ round, engine: backend.id, phase: "warmup" });
  let stats: BenchmarkFrameStats = { drawCalls: 0, triangles: 0, resources: 0,
    cpuStages: { renderCallMs: 0, statisticsReadMs: 0 } };
  for (let index = 0; index < options.warmupFrames; index++) {
    signal?.throwIfAborted(); if (replay) backend.setCamera!(replay(index, options.warmupFrames)); stats = backend.render();
    if (index % 30 === 29) await yieldTask();
  }
  await backend.settle();
  progress?.({ round, engine: backend.id, phase: "cpu" });
  const windowStartMs = performance.now();
  const cpu: number[] = [], renderCall: number[] = [], statisticsRead: number[] = [];
  for (let index = 0; index < options.cpuSampleFrames; index++) {
    signal?.throwIfAborted(); if (replay) backend.setCamera!(replay(index, options.cpuSampleFrames));
    const started = performance.now(); stats = backend.render();
    cpu.push(performance.now() - started); recordCpuStages(stats, renderCall, statisticsRead);
    if (index % 30 === 29) await yieldTask();
  }
  await backend.settle(); const gpu: number[] = [];
  if (bothGpu) {
    progress?.({ round, engine: backend.id, phase: "gpu" });
    for (let index = 0; index < options.gpuSampleFrames; index++) {
      signal?.throwIfAborted(); if (replay) backend.setCamera!(replay(index, options.gpuSampleFrames));
      const value = await backend.measureGpuFrame();
      if (value === null) throw new Error(`${backend.id} lost timestamp support during a paired run.`);
      gpu.push(value);
    }
  }
  progress?.({ round, engine: backend.id, phase: "capture" });
  const image = await backend.capture(); assertBenchmarkImage(image, backend.id);
  const gpuValues = gpu.length ? summarize(gpu) : null;
  const cpuValues = summarize(cpu);
  const window = benchmarkRawWindow(`${backend.id}/round-${round}`, windowStartMs, performance.now(), cpu, gpu);
  return Object.freeze({ image, window, cpuStages: Object.freeze({ renderCallMs: summarize(renderCall),
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

/**
 * 长稳相位：candidate → reference 串行（与首轮 A/B 顺序一致），每引擎先复热再连续渲染
 * longRunMinutes 分钟墙钟。帧时取「帧间隔」口径（本帧开始到下一帧开始的墙钟差，含每
 * 30 帧一次的调度让步），对齐 bevy 轨道 long-run 的 frame-interval 语义；页内同步渲染
 * 无 vsync 钳制，该间隔反映 submit 节奏 + 让步/GC 抖动，不做 vsync 换算（如实标注）。
 * 轨迹按 600 帧一圈连续循环回放，避免长稳期间画面冻结在单一姿态。
 */
async function runLongRunPhase(candidate: BenchmarkBackend, reference: BenchmarkBackend,
  options: CompetitiveBenchmarkOptions, signal?: AbortSignal,
  progress?: (value: CompetitiveBenchmarkProgress) => void,
  replay?: (frame: number, count: number) => TrajectoryCameraPose): Promise<CompetitiveLongRunEvidence> {
  const round = options.pairRounds;
  progress?.({ round, engine: candidate.id, phase: "long-run" });
  const candidateRun = await measureLongRun(candidate, options, signal, replay);
  progress?.({ round, engine: reference.id, phase: "long-run" });
  const referenceRun = await measureLongRun(reference, options, signal, replay);
  return Object.freeze({ minutes: options.longRunMinutes!, sampleMode: "frame-interval-including-yield" as const,
    candidate: candidateRun, reference: referenceRun });
}

const LONG_RUN_TRAJECTORY_LOOP_FRAMES = 600;

async function measureLongRun(backend: BenchmarkBackend, options: CompetitiveBenchmarkOptions,
  signal?: AbortSignal, replay?: (frame: number, count: number) => TrajectoryCameraPose)
  : Promise<CompetitiveLongRunEngineEvidence> {
  // 复热：长稳相位开始前画面/着色器已就绪，但 capture 回读等动作可能引入状态扰动，重走预热。
  for (let index = 0; index < options.warmupFrames; index++) {
    signal?.throwIfAborted(); if (replay) backend.setCamera!(replay(index, options.warmupFrames)); backend.render();
    if (index % 30 === 29) await yieldTask();
  }
  await backend.settle();
  const deadline = performance.now() + options.longRunMinutes! * 60_000;
  const startedAt = performance.now();
  const intervals: number[] = [];
  let previous = startedAt;
  for (let frames = 0;; frames++) {
    signal?.throwIfAborted();
    if (replay) backend.setCamera!(replay(frames % LONG_RUN_TRAJECTORY_LOOP_FRAMES, LONG_RUN_TRAJECTORY_LOOP_FRAMES));
    backend.render();
    const now = performance.now();
    intervals.push(now - previous); previous = now;
    if (now >= deadline) break;
    if (frames % 30 === 29) await yieldTask();
  }
  await backend.settle();
  const values = summarize(intervals);
  return Object.freeze({ frameP50Ms: values.p50, frameP95Ms: values.p95, frameP99Ms: values.p99,
    sampleCount: intervals.length, wallClockMs: previous - startedAt });
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
  return Object.freeze({ id: fixture.id, sha256: hash, instanceCount: fixture.packet.instances.length,
    ...(fixture.assetIdentity ? { assetIdentity: fixture.assetIdentity } : {}),
    ...(fixture.cameraFrame ? { cameraFrame: fixture.cameraFrame } : {}),
    canvas: [fixture.view.width, fixture.view.height], dpr: fixture.view.pixelRatio,
    geometryCount: fixture.packet.geometries.length, materialCount: fixture.packet.materials.length,
    textureCount: fixture.packet.textures?.length ?? 0,
    vertexCount: fixture.packet.geometries.reduce((sum, geometry) => sum + geometry.vertices.length / 6, 0),
    triangleCount: fixture.packet.geometries.reduce((sum, geometry) => sum + geometry.indices.length / 3, 0) });
}
function validateOptions(options: CompetitiveBenchmarkOptions): void {
  if (!Number.isSafeInteger(options.pairRounds) || options.pairRounds < 5
    || ![options.warmupFrames, options.cpuSampleFrames, options.gpuSampleFrames]
      .every(value => Number.isSafeInteger(value) && value >= 0)
    || options.warmupFrames < 10 || options.cpuSampleFrames < 30) throw new RangeError("Benchmark sample plan is below the evidence floor.");
  // 长稳时长：缺省/0 = 关闭；开启时上限 60 分钟（正式 V4 口径 30，管道验证用更短时长）。
  if (options.longRunMinutes !== undefined
    && (!Number.isFinite(options.longRunMinutes) || options.longRunMinutes <= 0 || options.longRunMinutes > 60)) {
    throw new RangeError("longRunMinutes must be within (0, 60] minutes when provided.");
  }
}
function yieldTask(): Promise<void> { return new Promise(resolve => setTimeout(resolve, 0)); }
