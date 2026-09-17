import { PbrRenderer, type FrameMetrics, type RenderPacket } from "@bim-studio/deep-engine/webgpu";
import { element, instances, percentile, tokenColor, view, type FixtureState } from "./fixture.js";
import { mixedPacket } from "./scenePacket.js";
import { loadModelPacket } from "./modelPacket.js";
import { verifyPacketRollback } from "./packetChecks.js";
import { instanceMotionUpdate } from "./instanceMotion.js";
import { initShaderWorkbench } from "./shaderWorkbench.js";
import { runEngineCapabilityProbeSuite } from "./engineCapabilityProbeSuite.js";
import { verifyDefaultPbrIntegration } from "./defaultPbrIntegrationProbe.js";
import { createProbeRunner } from "./probeExecution.js";

const canvas = element<HTMLCanvasElement>("canvas");
const shell = element("shell");
const state: FixtureState = { count: 49, angle: 0.3, exposure: 1, roughness: 1, motion: false };
const records: unknown[] = [];
const errors: string[] = [];
const buildIdentity = fetch("/manifest.json").then((response) => {
  if (!response.ok) throw new Error("Build manifest is unavailable.");
  return response.json() as Promise<{ sha256: string }>;
});
void buildIdentity.catch((error: unknown) => fail(error));
let background = tokenColor("--bg-0"), floor = tokenColor("--surface-2");
let renderer: PbrRenderer | undefined;
const shaderWorkbench = initShaderWorkbench(() => renderer?.session.device, (record) => records.push(record));
let preparing: AbortController | undefined;
let closed = false, busy = false, dirty = true, lastTime = 0, lastDisplay = 0;
let latestFrame: FrameMetrics | undefined;
let geometryMode = "spheres";
let motionPacket: RenderPacket | undefined, instanceMotion = false, instanceTime = 0, instanceFrames = 0;
interface Sampling { cpu: number[]; projection: number[]; intervals: number[]; previous: number; warmup: number; signature: string; firstFrame: number; lastFrame: number; shadowUpdates: number }
let sampling: Sampling | undefined;
let raf = 0;

function status(message: string, error = false): void {
  const node = element("status"); node.textContent = message; node.dataset.state = error ? "error" : "ready";
}
function diagnostics(): void {
  element("diagnostics").textContent = JSON.stringify({ errors, device: renderer?.session.diagnostics ?? [], records }, null, 2);
}
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  errors.push(message); status(`验证失败：${message}。可点击“重建设备”重试。`, true); diagnostics();
}
window.addEventListener("error", (event) => fail(event.message));
window.addEventListener("unhandledrejection", (event) => fail(event.reason));

function currentView() {
  const modelDetail = state.count === 1 && geometryMode !== "spheres" && geometryMode !== "mixed";
  return view(canvas, state, background, floor, modelDetail ? "single-model-detail" : "benchmark");
}
async function updateScene(owner = renderer, signal?: AbortSignal): Promise<void> {
  if (!owner) throw new Error("设备未就绪，请重建设备。");
  if (geometryMode === "mixed") {
    const packet = mixedPacket(state.count); await owner.setPacketValidated(packet, signal); motionPacket = packet;
  }
  else if (geometryMode === "Box" || geometryMode === "BoxInterleaved" || geometryMode === "BoxTextured"
    || geometryMode === "NormalTangentTest" || geometryMode === "TextureEncodingTest" || geometryMode === "AlphaBlendModeTest"
    || geometryMode === "MaterialModes" || geometryMode === "UvSets") {
    await owner.setPacketValidated(await loadModelPacket(geometryMode, state.count, signal), signal);
  }
  else await owner.setInstancesValidated(instances(state.count), signal);
}
async function refreshScene(message: string): Promise<void> {
  await updateScene();
  const frame = await renderer!.validateFrame(currentView());
  latestFrame = frame; display(frame); dirty = false;
  records.push({ action: "scene-update", geometryMode, instances: state.count, frame });
  status(message); diagnostics();
}
function sampleSignature(): string {
  return JSON.stringify({ ...state, geometryMode, instanceMotion, angle: state.motion ? 0 : state.angle, width: canvas.width, height: canvas.height, theme: document.documentElement.dataset.theme });
}
function cancelSampling(): void {
  sampling = undefined;
  if (renderer) renderer.gpuTimer.enabled = false;
}
function display(frame: FrameMetrics): void {
  element("draws").textContent = String(frame.drawCalls);
  element("cpu").textContent = `${frame.cpuSubmitMs.toFixed(2)} ms`;
  element("resources").textContent = String(frame.resources);
  element("resolution").textContent = `${frame.width.toLocaleString()} × ${frame.height.toLocaleString()} px`;
}
function setBusy(value: boolean): void {
  busy = value;
  for (const id of ["count", "geometry", "roughness", "exposure", "motion", "sample", "rebuild", "loss", "rollback", "theme"]) {
    const control = element<HTMLButtonElement>(id);
    control.disabled = value;
    control.title = value ? "设备验证进行中" : "";
  }
  const objects = element<HTMLButtonElement>("objects");
  objects.disabled = value || geometryMode !== "mixed";
  objects.title = geometryMode !== "mixed" ? "在混合网格场景中验证实例动画" : value ? "设备验证进行中" : "";
}

async function recreate(): Promise<void> {
  preparing?.abort();
  const controller = new AbortController(); preparing = controller;
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const previous = renderer; renderer = undefined;
  previous?.dispose();
  if (previous) records.push({ action: "dispose", resources: previous.session.resourceCount, state: previous.session.state });
  const started = performance.now();
  let candidate: PbrRenderer | undefined, stage = "create";
  const probe = createProbeRunner(controller.signal);
  try {
    candidate = await PbrRenderer.create(canvas, navigator.gpu, controller.signal);
    if (controller.signal.aborted || closed) throw new Error("Preparation cancelled.");
    stage = "initial-packet";
    await updateScene(candidate, controller.signal);
    stage = "initial-frame";
    const frame = await probe(stage, () => candidate!.validateFrame(currentView()));
    stage = "capability-probes";
    const capabilityProbes = await runEngineCapabilityProbeSuite(candidate, canvas, controller.signal,
      name => status(`正在验证：${name}…`));
    stage = "default-integration";
    const defaultIntegration = await probe(stage, () => verifyDefaultPbrIntegration(candidate!, currentView(), async () => {
      await updateScene(candidate!, controller.signal);
      await candidate!.validateFrame(currentView());
    }));
    if (controller.signal.aborted || closed) throw new Error("Preparation cancelled.");
    renderer = candidate; latestFrame = frame; display(frame); dirty = false;
    void shaderWorkbench.compile();
    records.push(...capabilityProbes.records, defaultIntegration);
    records.push({ action: "first-frame", readyMs: performance.now() - started, instances: state.count, geometryMode, frame, timestampSupported: candidate.gpuTimer.supported, errors: candidate.session.diagnostics });
    status(capabilityProbes.passed && defaultIntegration.success
      ? "✓ 首帧、Shader 热重载、五槽 PBR、Forward+ PBR、级联阴影、GLB 动画/GPU 蒙皮与 Morph、GPU LOD、OIT/GTAO/TAA、实例/Meshlet 剔除与间接绘制、Hi-Z、压缩纹理与 GPU 驻留事务真机验证通过 · 按需渲染"
      : "首帧通过 · Shader 热重载、纹理材质、光照阴影、动画蒙皮、GPU 剔除、Hi-Z、压缩纹理或 GPU 驻留事务探针失败（验证记录可追踪）", !capabilityProbes.passed || !defaultIntegration.success);
    diagnostics();
  } catch (error) {
    const details = candidate?.session.diagnostics ?? [];
    candidate?.dispose();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${stage}: ${message}${details.length ? ` [device: ${details.map(item => item.message).join("; ")}]` : ""}`);
  }
  finally { clearTimeout(timeout); }
}

async function action(run: () => Promise<void>, label: string): Promise<void> {
  if (busy) return;
  setBusy(true); status(label); cancelSampling();
  try { await run(); } catch (error) { fail(error); }
  finally { setBusy(false); }
}

function tick(time: number): void {
  if (closed) return;
  const narrow = String(shell.clientWidth < 850);
  if (shell.dataset.narrow !== narrow) shell.dataset.narrow = narrow;
  const delta = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0; lastTime = time;
  try {
    if (renderer?.session.state === "lost") {
      status("设备已丢失，可点击“重建设备”恢复。", true);
      cancelSampling(); diagnostics();
    } else if (!busy && renderer && (dirty || state.motion || instanceMotion || sampling)) {
      if (state.motion && !document.hidden) state.angle += delta * 0.12;
      let projectionMs = 0;
      if (instanceMotion && motionPacket && !document.hidden) {
        const started = performance.now();
        instanceTime += delta; renderer.updateInstances(instanceMotionUpdate(motionPacket, instanceTime)); instanceFrames++;
        projectionMs = performance.now() - started;
      }
      const frame = renderer.render(currentView());
      if (frame) {
        latestFrame = frame; dirty = false;
        if (time - lastDisplay > 150 || !state.motion) { display(frame); lastDisplay = time; }
        collectSample(time, frame, projectionMs);
      }
    }
  } catch (error) { cancelSampling(); renderer?.dispose(); renderer = undefined; fail(error); }
  raf = requestAnimationFrame(tick);
}

function collectSample(time: number, frame: FrameMetrics, projectionMs: number): void {
  if (!sampling) return;
  if (sampling.signature !== sampleSignature()) { cancelSampling(); status("采样已取消：场景或视口发生变化。"); return; }
  if (document.hidden) { cancelSampling(); status("采样已取消：页面进入后台。", true); return; }
  if (sampling.warmup > 0) sampling.warmup--;
  else {
    if (!sampling.firstFrame) sampling.firstFrame = frame.frame;
    sampling.lastFrame = frame.frame; sampling.shadowUpdates += Number(frame.shadowUpdated);
    sampling.cpu.push(frame.cpuSubmitMs); sampling.projection.push(projectionMs); sampling.intervals.push(time - sampling.previous);
  }
  sampling.previous = time;
  if (sampling.cpu.length < 120) return;
  const completed = sampling, owner = renderer!;
  void action(() => finishSample(completed, owner, frame), "正在读取 GPU 计时…");
}

async function finishSample(sample: Sampling, owner: PbrRenderer, frame: FrameMetrics): Promise<void> {
  const times = await owner.gpuTimer.collect(sample.firstFrame, sample.lastFrame);
  if (owner.session.state !== "ready") throw new Error("GPU device was lost during measurement.");
  const gpuMs = times.map((value) => value.milliseconds);
  const result = { action: "sample", frames: 120, instances: state.count, geometryMode, width: frame.width, height: frame.height,
    cpuSubmitP50Ms: percentile(sample.cpu, 0.5), cpuSubmitP95Ms: percentile(sample.cpu, 0.95),
    cpuProjectionP50Ms: percentile(sample.projection, 0.5), cpuProjectionP95Ms: percentile(sample.projection, 0.95),
    rafIntervalP50Ms: percentile(sample.intervals, 0.5), rafIntervalP95Ms: percentile(sample.intervals, 0.95),
    gpuP50Ms: gpuMs.length ? percentile(gpuMs, 0.5) : null, gpuP95Ms: gpuMs.length ? percentile(gpuMs, 0.95) : null,
    gpuSampleCount: gpuMs.length, gpuErrors: owner.gpuTimer.diagnostics, drawCalls: frame.drawCalls, shadowUpdates: sample.shadowUpdates,
    transientTextures: owner.transientTextureStats,
    exposure: state.exposure, roughness: state.roughness, motion: state.motion, instanceMotion, errors: owner.session.diagnostics };
  records.push(result);
  const gpuText = result.gpuP95Ms === null ? "设备未提供 GPU 计时" : `GPU P95 ${result.gpuP95Ms.toFixed(2)} ms（${gpuMs.length}/120 帧）`;
  element("result").textContent = `120 帧：CPU 提交 P95 ${result.cpuSubmitP95Ms.toFixed(2)} ms；实例准备 P95 ${result.cpuProjectionP95Ms.toFixed(2)} ms；${gpuText}；帧间隔 P95 ${result.rafIntervalP95Ms.toFixed(2)} ms。仅代表此固定场景，不作引擎排名。`;
  status("✓ 采样完成"); diagnostics();
}

element("rebuild").onclick = () => void action(recreate, "正在重建设备…");
element("rollback").onclick = () => void action(async () => {
  if (!renderer) throw new Error("设备未就绪。");
  const record = await verifyPacketRollback(renderer, currentView());
  records.push(record); latestFrame = record.after; display(record.after);
  status("✓ 上传失败已回滚 · 原场景继续渲染"); diagnostics();
}, "正在验证 GPU 上传失败回滚…");
element("loss").onclick = () => void action(async () => {
  if (!renderer) throw new Error("No renderer to test.");
  const previous = renderer;
  previous.session.device.destroy();
  await previous.session.device.lost;
  await Promise.resolve();
  const stopped = previous.render(currentView()) === undefined;
  records.push({ action: "device-loss", stopped, state: previous.session.state, diagnostics: previous.session.diagnostics });
  if (!stopped || previous.session.state !== "lost") throw new Error("Lost device continued rendering.");
  await recreate();
  status("✓ 设备丢失与重建首帧通过");
}, "正在测试设备丢失与恢复…");
element("sample").onclick = () => {
  if (!renderer || busy) return;
  renderer.gpuTimer.enabled = true;
  sampling = { cpu: [], projection: [], intervals: [], previous: 0, warmup: 20, signature: sampleSignature(), firstFrame: 0, lastFrame: 0, shadowUpdates: 0 }; status("正在预热并采样 120 帧…");
};
function setInstanceMotion(value: boolean): void {
  instanceMotion = value;
  element("objects").setAttribute("aria-pressed", String(instanceMotion));
  element("objects").textContent = instanceMotion ? "停止实例运动" : "开始实例运动";
  records.push({ action: "instance-motion", enabled: instanceMotion, frames: instanceFrames, resources: renderer?.session.resourceCount });
  dirty = true; status(instanceMotion ? "实例运动中 · 共享几何增量更新" : "✓ 实例运动已停止"); diagnostics();
}
element("objects").onclick = () => setInstanceMotion(!instanceMotion);
element("motion").onclick = () => {
  state.motion = !state.motion;
  element("motion").setAttribute("aria-pressed", String(state.motion));
  element("motion").textContent = state.motion ? "停止环绕" : "开始环绕";
  dirty = true; status(state.motion ? "相机环绕中" : "✓ 环绕已停止 · 按需渲染");
};
element<HTMLSelectElement>("count").onchange = () => void action(async () => {
  const previous = state.count;
  state.count = Number(element<HTMLSelectElement>("count").value);
  try { await refreshScene(`✓ 已切换至 ${state.count} 个实例`); }
  catch (error) { state.count = previous; element<HTMLSelectElement>("count").value = String(previous); throw error; }
}, "正在更新实例…");
element<HTMLSelectElement>("geometry").onchange = () => void action(async () => {
  const previous = geometryMode;
  if (instanceMotion) setInstanceMotion(false);
  geometryMode = element<HTMLSelectElement>("geometry").value;
  try { await refreshScene("✓ 几何切换与 GPU 首帧通过"); }
  catch (error) { geometryMode = previous; element<HTMLSelectElement>("geometry").value = previous; throw error; }
}, "正在载入并校验几何…");
for (const name of ["exposure", "roughness"] as const) {
  element<HTMLInputElement>(name).oninput = () => {
    state[name] = Number(element<HTMLInputElement>(name).value);
    element(`${name}-value`).textContent = state[name].toFixed(2); dirty = true;
  };
}
element("theme").onclick = () => void action(async () => {
  const light = document.documentElement.dataset.theme !== "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  element("theme").textContent = light ? "深色主题" : "浅色主题";
  background = tokenColor("--bg-0"); floor = tokenColor("--surface-2");
  await refreshScene("✓ 主题已切换");
}, "正在切换主题…");
element<HTMLSelectElement>("width").onchange = () => {
  const width = Number(element<HTMLSelectElement>("width").value);
  shell.style.width = width ? `min(100%, ${width}px)` : "100%";
};
element("export").onclick = () => void action(async () => {
  const report = { schema: 1, buildSha256: (await buildIdentity).sha256, date: new Date().toISOString(), userAgent: navigator.userAgent, adapter: renderer?.session.adapterInfo ?? null, state: { ...state, geometryMode, instanceMotion }, latestFrame, records, errors,
    diagnostics: renderer?.session.diagnostics ?? [], viewport: { shellWidth: shell.clientWidth, canvasWidth: canvas.clientWidth, canvasHeight: canvas.clientHeight, overflow: document.documentElement.scrollWidth > innerWidth } };
  const response = await fetch("/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) });
  if (!response.ok) throw new Error(`Report save failed (${response.status}).`);
  const saved = await response.json(); status(`✓ 验证记录已保存：${saved.file}`);
}, "正在保存验证记录…");

const observer = new ResizeObserver(() => { dirty = true; });
observer.observe(shell); observer.observe(canvas);
window.addEventListener("pagehide", () => {
  closed = true; cancelAnimationFrame(raf); observer.disconnect(); preparing?.abort(); renderer?.dispose();
}, { once: true });
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
motionPreference.addEventListener("change", () => {
  if (motionPreference.matches && state.motion) element<HTMLButtonElement>("motion").click();
  if (motionPreference.matches && instanceMotion) setInstanceMotion(false);
});
raf = requestAnimationFrame(tick);
void action(recreate, "正在编译 WebGPU 管线…");
