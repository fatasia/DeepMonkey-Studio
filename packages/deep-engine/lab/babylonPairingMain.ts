import type { BenchmarkTrajectory } from "@bim-studio/deep-engine";
import {
  createAssetBenchmarkScene,
  createBenchmarkScene,
  BENCHMARK_COUNTS,
  type BenchmarkInstanceCount,
  type BenchmarkSceneFixture,
} from "./benchmarkScene.js";
import type { ModelName } from "./modelPacket.js";
import { DeepBenchmarkBackend } from "./deepBenchmarkBackend.js";
import {
  BABYLON_BENCHMARK_VERSION,
  BABYLON_MAPPING_NOTES,
  BabylonBenchmarkBackend,
  type BabylonBenchmarkModuleSet,
} from "./babylonBenchmarkBackend.js";
import {
  runCompetitiveBenchmark,
  DEFAULT_COMPETITIVE_BENCHMARK_OPTIONS,
  type CompetitiveBenchmarkOptions,
  type CompetitiveBenchmarkReport,
  type CompetitiveBenchmarkProgress,
} from "./competitiveBenchmarkRunner.js";
import { BENCHMARK_PROFILES, type BenchmarkProfile } from "./benchmarkProfile.js";
import trajectoryCatalog from "../fixtures/benchmark-assets/trajectories-v1.json";

export interface A01xPairingRunOptions extends CompetitiveBenchmarkOptions {
  readonly fixtureKind: "procedural" | "asset";
  readonly assetName?: ModelName;
  readonly instanceCount: BenchmarkInstanceCount;
  readonly profile: BenchmarkProfile;
  readonly trajectoryId: string;
  readonly vendorUrl: string;
  readonly requestTimestampQuery: boolean;
}

export interface A01xPairingRunResult {
  readonly report: CompetitiveBenchmarkReport;
  readonly mappingNotes: readonly string[];
  readonly babylonVersion: string;
  readonly environment: Readonly<Record<string, unknown>>;
}

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id); if (!value) throw new Error(`Missing pairing element ${id}.`); return value as T;
};
const candidateCanvas = element<HTMLCanvasElement>("candidate-canvas");
const referenceCanvas = element<HTMLCanvasElement>("reference-canvas");
const status = element<HTMLElement>("benchmark-status"), output = element<HTMLElement>("benchmark-output");
const pageErrors: string[] = [];
window.addEventListener("error", event => pageErrors.push(event.message));
window.addEventListener("unhandledrejection", event => pageErrors.push(String(event.reason)));

function show(message: string, error = false): void {
  status.textContent = message; status.dataset.state = error ? "error" : "ready";
}

function progress(value: CompetitiveBenchmarkProgress): void {
  const phase = { warmup: "预热", cpu: "CPU 采样", gpu: "GPU 时间戳", capture: "画面回读", "long-run": "长稳采样" }[value.phase];
  show(`第 ${value.round} 轮 · ${value.engine} · ${phase}`);
}

async function run(options: A01xPairingRunOptions): Promise<A01xPairingRunResult> {
  if (!BENCHMARK_PROFILES.includes(options.profile)) throw new RangeError("Unknown benchmark profile.");
  if (!BENCHMARK_COUNTS.includes(options.instanceCount)) throw new RangeError("Unknown benchmark instance count.");
  const controller = new AbortController();
  let fixture: BenchmarkSceneFixture | undefined;
  let candidate: DeepBenchmarkBackend | undefined;
  let reference: BabylonBenchmarkBackend | undefined;
  try {
    show("加载 Babylon vendor（锁定的隔离构建）…");
    const vendor = await import(/* @vite-ignore */ options.vendorUrl) as
      BabylonBenchmarkModuleSet & { readonly BABYLON_VENDOR_VERSION: string };
    if (vendor.BABYLON_VENDOR_VERSION !== BABYLON_BENCHMARK_VERSION) {
      throw new Error(`Babylon vendor drift: page pins ${BABYLON_BENCHMARK_VERSION}, vendor reports ${vendor.BABYLON_VENDOR_VERSION}.`);
    }
    show("准备基准夹具…");
    fixture = options.fixtureKind === "procedural"
      ? createBenchmarkScene(options.instanceCount)
      : await createAssetBenchmarkScene(options.assetName!, options.instanceCount, controller.signal);
    candidate = await DeepBenchmarkBackend.create(candidateCanvas, fixture, controller.signal, options.profile);
    show("准备 Babylon.js WebGPU 参考端…");
    const adapterProbe = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    const adapterInfo = adapterProbe?.info ? { ...adapterProbe.info,
      features: [...adapterProbe.features].sort() } : undefined;
    reference = await BabylonBenchmarkBackend.create(referenceCanvas, fixture, controller.signal,
      options.profile, { modules: vendor, declaredVersion: vendor.BABYLON_VENDOR_VERSION,
        requestTimestampQuery: options.requestTimestampQuery, ...(adapterInfo ? { adapterInfo } : {}) });
    const trajectory = options.trajectoryId === "static" ? undefined : trajectoryCatalog.trajectories
      .find(value => value.id === options.trajectoryId) as BenchmarkTrajectory | undefined;
    if (options.trajectoryId !== "static" && !trajectory) throw new Error("Unknown frozen benchmark trajectory.");
    const report = await runCompetitiveBenchmark(fixture, candidate, reference,
      { ...DEFAULT_COMPETITIVE_BENCHMARK_OPTIONS, ...options,
        ...(trajectory ? { trajectory } : {}) }, controller.signal, progress, pageErrors);
    output.textContent = JSON.stringify(report, null, 2);
    const cpuGap = report.channelGaps.find(gap => gap.channel === "cpu-submit");
    show(`采样完成 · CPU P95 中位 ${cpuGap?.candidateP95MedianMs?.toFixed(3) ?? "—"} / ${cpuGap?.referenceP95MedianMs?.toFixed(3) ?? "—"} ms · 相似度 ${report.rounds.map(round => round.visualSimilarity.toFixed(2)).join(", ")}`);
    return Object.freeze({ report, mappingNotes: BABYLON_MAPPING_NOTES,
      babylonVersion: BABYLON_BENCHMARK_VERSION,
      environment: Object.freeze({ userAgent: navigator.userAgent,
        deepAdapter: candidate.adapter, babylonAdapter: reference.adapter,
        adapterInfo: adapterInfo ?? null,
        timestampSupport: { deep: candidate.timestampSupported, babylon: reference.timestampSupported },
        commonSubset: reference.commonSubsetSupport }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pageErrors.push(message);
    output.textContent = JSON.stringify({ schema: 1, status: "invalid", outcome: "withheld",
      caseId: fixture?.id ?? `a01x-${options.fixtureKind}-${options.instanceCount}`,
      profile: options.profile, error: message,
      stack: error instanceof Error ? error.stack : undefined }, null, 2);
    show(`配对无效：${message}`, true);
    throw error;
  } finally {
    candidate?.dispose(); reference?.dispose();
  }
}

declare global {
  interface Window { __a01xBabylonPairing?: { run(options: A01xPairingRunOptions): Promise<A01xPairingRunResult>;
    mappingNotes(): readonly string[];
    errors(): readonly string[] } }
}
window.__a01xBabylonPairing = { run, mappingNotes: () => BABYLON_MAPPING_NOTES, errors: () => pageErrors.slice() };
