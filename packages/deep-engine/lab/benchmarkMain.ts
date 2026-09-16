import { createAssetBenchmarkScene, createBenchmarkScene, BENCHMARK_COUNTS } from "./benchmarkScene.js";
import type { ModelName } from "./modelPacket.js";
import { DeepBenchmarkBackend } from "./deepBenchmarkBackend.js";
import { ThreeWebGpuBenchmarkBackend } from "./threeWebGpuBenchmarkBackend.js";
import {
  runCompetitiveBenchmark,
  type CompetitiveBenchmarkReport,
  type CompetitiveBenchmarkProgress,
} from "./competitiveBenchmarkRunner.js";
import { BENCHMARK_PROFILES, type BenchmarkProfile } from "./benchmarkProfile.js";

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id); if (!value) throw new Error(`Missing benchmark element ${id}.`); return value as T;
};
const candidateCanvas = element<HTMLCanvasElement>("candidate-canvas");
const referenceCanvas = element<HTMLCanvasElement>("reference-canvas");
const status = element<HTMLElement>("benchmark-status"), output = element<HTMLElement>("benchmark-output");
const runButton = element<HTMLButtonElement>("run"), saveButton = element<HTMLButtonElement>("save");
const pageErrors: string[] = []; let controller: AbortController | undefined;
let latest: CompetitiveBenchmarkReport | undefined, failure: Readonly<Record<string, unknown>> | undefined;
let activeBackends: Readonly<{ candidate: DeepBenchmarkBackend; reference: ThreeWebGpuBenchmarkBackend }> | undefined;
const buildIdentity = fetch("/manifest.json").then(response => response.json());

window.addEventListener("error", event => pageErrors.push(event.message));
window.addEventListener("unhandledrejection", event => pageErrors.push(String(event.reason)));

async function run(instanceCount: 1024 | 10000,
  profile: BenchmarkProfile = element<HTMLSelectElement>("profile").value as BenchmarkProfile): Promise<CompetitiveBenchmarkReport> {
  if (!BENCHMARK_PROFILES.includes(profile)) throw new RangeError("Unknown benchmark profile.");
  controller?.abort(); disposeActiveBackends(); controller = new AbortController(); const signal = controller.signal;
  latest = undefined; failure = undefined; pageErrors.length = 0; setBusy(true);
  const asset = element<HTMLSelectElement>("asset").value;
  const fixture = asset === "procedural" ? createBenchmarkScene(instanceCount)
    : await createAssetBenchmarkScene(asset as ModelName, instanceCount, signal);
  let candidate: DeepBenchmarkBackend | undefined;
  let reference: ThreeWebGpuBenchmarkBackend | undefined;
  try {
    show(`正在准备 ${asset} · ${instanceCount.toLocaleString()} 实例的 Deep WebGPU…`);
    candidate = await DeepBenchmarkBackend.create(candidateCanvas, fixture, signal, profile);
    show("正在准备 Three.js 0.185.1 WebGPU 优化路径…");
    reference = await ThreeWebGpuBenchmarkBackend.create(referenceCanvas, fixture, signal, candidate.timestampSupported, profile);
    latest = await runCompetitiveBenchmark(fixture, candidate, reference, undefined, signal, progress, pageErrors);
    renderReport(latest);
    // Keep the two verified final surfaces alive until the next run so the advertised
    // frozen-frame comparison does not disappear when WebGPU contexts are unconfigured.
    activeBackends = Object.freeze({ candidate, reference }); candidate = undefined; reference = undefined;
    return latest;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    pageErrors.push(message); failure = Object.freeze({ schema: 1, status: "invalid", outcome: "withheld",
      caseId: fixture.id, profile, error: message });
    show(`基准无效：${message}`, true); output.textContent = JSON.stringify(failure, null, 2); throw error;
  } finally { reference?.dispose(); candidate?.dispose(); setBusy(false); }
}

function progress(value: CompetitiveBenchmarkProgress): void {
  const phase = { warmup: "预热", cpu: "CPU 采样", gpu: "GPU 时间戳", capture: "画面回读" }[value.phase];
  show(`第 ${value.round}/5 轮 · ${value.engine} · ${phase}`);
}

function renderReport(report: CompetitiveBenchmarkReport): void {
  const last = report.rounds.at(-1)!;
  element("candidate-cpu").textContent = `${last.candidate.cpuFrameP95Ms.toFixed(3)} ms`;
  element("reference-cpu").textContent = `${last.reference.cpuFrameP95Ms.toFixed(3)} ms`;
  element("similarity").textContent = last.visualSimilarity.toFixed(4);
  element("decision").textContent = `${report.evaluation.status} / ${report.evaluation.outcome}`;
  output.textContent = JSON.stringify(report, null, 2);
  const message = report.evaluation.status === "comparable"
    ? "采样完成，合同允许判断候选是否达到冻结标准。"
    : report.evaluation.issues.includes("visual fidelity gate failed")
      ? `采样完成；画面相似度未达到 ${report.visual.minimum.toFixed(2)}，排名已按合同抑制。`
      : "采样完成；质量配置或运行证据未等价，排名已按合同抑制。";
  show(message, report.evaluation.status === "invalid");
  saveButton.disabled = false;
}

async function save(): Promise<string> {
  if (!latest && !failure) throw new Error("尚无可保存的基准记录。");
  const manifest = await buildIdentity;
  const payload = { schema: 1, buildSha256: manifest.sha256,
    date: new Date().toISOString(), userAgent: navigator.userAgent,
    records: [latest ? { action: "competitive-benchmark", ...latest } : { action: "competitive-benchmark", ...failure }],
    errors: [...pageErrors] };
  const response = await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Benchmark report save failed (${response.status}).`);
  const saved = await response.json(); show(`记录已保存：${saved.file}`); return saved.file;
}

function setBusy(busy: boolean): void { runButton.disabled = busy; saveButton.disabled = busy || (!latest && !failure); }
function show(message: string, error = false): void { status.textContent = message; status.dataset.state = error ? "error" : "ready"; }
function disposeActiveBackends(): void {
  activeBackends?.reference.dispose(); activeBackends?.candidate.dispose(); activeBackends = undefined;
}

runButton.onclick = () => {
  const count = Number(element<HTMLSelectElement>("count").value);
  if (!BENCHMARK_COUNTS.includes(count as 1024 | 10000)) return;
  void run(count as 1024 | 10000).catch(() => {});
};
saveButton.onclick = () => { setBusy(true); void save().catch(error => show(String(error), true)).finally(() => setBusy(false)); };
window.addEventListener("pagehide", () => { controller?.abort(); disposeActiveBackends(); }, { once: true });

declare global {
  interface Window { __deepCompetitiveBenchmark?: { run(count: 1024 | 10000, profile?: BenchmarkProfile): Promise<CompetitiveBenchmarkReport>;
    latest(): CompetitiveBenchmarkReport | Readonly<Record<string, unknown>> | undefined; save(): Promise<string> } }
}
window.__deepCompetitiveBenchmark = { run, latest: () => latest ?? failure, save };
