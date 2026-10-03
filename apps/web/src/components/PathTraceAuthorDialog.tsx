import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, FileImage, Play, Square, Save, X } from "lucide-react";
import { DEFAULT_DISPLAY_CONTRACT, type ProjectRecord, type SceneSnapshot } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { downloadBlob, downloadTextFile } from "../browserDownload";
import { safeImageName } from "./dashboardPageImageExport";
import { browserImageDecoder } from "../delivery/browserImageDecoder";
import { normalizeStudioWasmModel } from "../viewer/studioWasmRuntimePackage";
import { buildSceneModelLoader } from "../delivery/probeGridBakeRunner";
import { preparePathTraceAuthor, pathTraceAuthorSourceHash,
  type PathTraceAuthorIllumination, type PathTraceAuthorPrepared } from "../delivery/pathTraceAuthorPreparation";
import { PathTraceParallelRender, type PathTraceParallelProgress } from "../delivery/pathTraceAuthorParallel";
import { PATH_TRACE_RESOLUTIONS, estimatePathTraceMemory, fitPathTraceWorkers, formatPathTraceMiB, pathTraceHeight,
  pathTraceMemoryBudgetBytes, pathTracePacketBytes, pathTraceTierState, pathTraceWorkerCap, recordPathTraceThroughput } from "../delivery/pathTraceAuthorBudget";
import { PATH_TRACE_DISPLAY_EXPOSURE } from "../delivery/pathTraceAuthorPreview";
import { encodePathTracePng, sha256Hex } from "../delivery/pathTraceAuthorPng";
import type { PathTraceBandWorker } from "../delivery/pathTraceAuthorWorkerTypes";
import { PathTraceResolutionPicker } from "./PathTraceResolutionPicker";
import { PathTraceStatusBar } from "./PathTraceStatusBar";
import "./PathTraceAuthorDialog.css";

interface Props { readonly locale: AppLocale; readonly models: ProjectRecord["models"]; readonly sourceKey: string;
  readonly getSnapshot: () => SceneSnapshot | undefined; readonly onClose: () => void }
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
function host() {
  const nav = typeof navigator === "undefined" ? undefined : navigator as Navigator & { deviceMemory?: number };
  return { cap: pathTraceWorkerCap(nav?.hardwareConcurrency), budget: pathTraceMemoryBudgetBytes(nav?.deviceMemory) };
}
const createWorker = (): PathTraceBandWorker =>
  new Worker(new URL("../delivery/pathTraceAuthorWorker.ts", import.meta.url), { type: "module" }) as unknown as PathTraceBandWorker;

export function PathTraceAuthorDialog(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const render = useRef<PathTraceParallelRender | undefined>(undefined), abort = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0), prepared = useRef<PathTraceAuthorPrepared | undefined>(undefined), latest = useRef(props);
  const previousSourceKey = useRef(props.sourceKey);
  latest.current = props;
  const [width, setWidth] = useState(320), [samples, setSamples] = useState(4096), [seed, setSeed] = useState(19);
  const [threads, setThreads] = useState(0), [packetBytes, setPacketBytes] = useState(0), [activeWorkers, setActiveWorkers] = useState(0);
  const [mode, setMode] = useState<PathTraceAuthorIllumination>("physical-scene-radiance");
  const [phase, setPhase] = useState("idle"), [error, setError] = useState(""), [progress, setProgress] = useState<PathTraceParallelProgress>();
  const { cap, budget } = host(), requested = threads === 0 ? cap : Math.min(threads, cap);
  const tiers = PATH_TRACE_RESOLUTIONS.map(value => pathTraceTierState(value, requested, packetBytes, budget));
  const tier = tiers[Math.max(0, PATH_TRACE_RESOLUTIONS.indexOf(width as never))]!;
  const busy = phase === "preparing" || phase === "accumulating" || phase === "exporting";
  const finished = phase === "ready" || phase === "noise-limited" || phase === "exported";
  function stop(next = "cancelled") {
    generation.current++; abort.current?.abort(); render.current?.cancel(); render.current = undefined;
    prepared.current = undefined; setProgress(undefined); setPhase(next);
  }
  function close() { stop(); latest.current.onClose(); }
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal();
    return () => { generation.current++; abort.current?.abort(); render.current?.cancel();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (previousSourceKey.current === props.sourceKey) return;
    previousSourceKey.current = props.sourceKey;
    stop(render.current && prepared.current ? "invalidated" : "idle"); setError("");
  }, [props.sourceKey]);
  useEffect(() => { stop("idle"); setError(""); }, [width, samples, seed, mode, threads]);
  useEffect(() => {
    if (!progress || !canvas.current) return;
    const image = progress.image, context = canvas.current.getContext("2d"); if (!context) return;
    canvas.current.width = image.width; canvas.current.height = image.height;
    context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  }, [progress]);
  function currentMatches(): boolean {
    try {
      const source = latest.current.getSnapshot();
      return !!source && !!prepared.current && pathTraceAuthorSourceHash(source) === prepared.current.sourceHash;
    } catch { return false; }
  }
  function fail(current: number, cause: unknown) { if (current === generation.current) { stop("failed"); setError(message(cause)); } }
  async function start() {
    stop("preparing"); setError("");
    const current = generation.current, source = latest.current.getSnapshot();
    if (!source) { setError(tr(props.locale, "场景尚未就绪。", "The scene is not ready.")); setPhase("failed"); return; }
    const controller = new AbortController(); abort.current = controller;
    try {
      const packet = await preparePathTraceAuthor(source, { width, height: pathTraceHeight(width), maxSamples: samples,
        minSamples: 64, varianceThreshold: .02, maxAccumulationBytes: estimatePathTraceMemory(width, 1, 0).accumulationBytes,
        sampleSeed: seed }, mode, { loadModel: buildSceneModelLoader(latest.current.models), imageDecoder: browserImageDecoder,
          normalizeModel: normalizeStudioWasmModel, signal: controller.signal });
      if (current !== generation.current) return;
      const bytes = pathTracePacketBytes(packet.packet), workers = fitPathTraceWorkers(width, requested, bytes, budget);
      setPacketBytes(bytes);
      if (workers < 1) throw new Error(tr(props.locale,
        `预估内存 ${formatPathTraceMiB(estimatePathTraceMemory(width, 1, bytes).totalBytes)} 超出预算 ${formatPathTraceMiB(budget)}，请降低分辨率。`,
        `Estimated ${formatPathTraceMiB(estimatePathTraceMemory(width, 1, bytes).totalBytes)} exceeds the ${formatPathTraceMiB(budget)} memory budget; lower the resolution.`));
      prepared.current = packet;
      if (!currentMatches()) { stop("invalidated"); return; }
      const run = new PathTraceParallelRender(packet, createWorker, { workers,
        crossOriginIsolated: typeof crossOriginIsolated === "boolean" && crossOriginIsolated });
      render.current = run; setActiveWorkers(run.workerCount); setPhase("accumulating");
      void run.run(controller.signal, next => {
        if (current !== generation.current) return;
        if (!currentMatches()) { stop("invalidated"); return; }
        setProgress(next); setPhase(next.done ? next.converged ? "ready" : "noise-limited" : "accumulating");
        if (next.done) recordPathTraceThroughput(width, run.workerCount, next.samples, next.elapsedMs);
      }).catch(cause => { if (!controller.signal.aborted) fail(current, cause); });
    } catch (cause) { fail(current, cause); }
  }
  async function exportHdr(preview: boolean) {
    const run = render.current, packet = prepared.current; if (!run || !packet) return;
    if (!currentMatches()) { stop("invalidated"); return; }
    const current = generation.current; setPhase("exporting");
    try {
      const output = await run.exportHdr(preview, packet.sourceHash), hash = await sha256Hex(output.bytes);
      if (current !== generation.current || !currentMatches()) { stop("invalidated"); return; }
      const name = `${safeImageName(packet.sceneName)}-${packet.illumination}-${preview ? "preview" : "final"}`;
      downloadBlob(new Blob([output.bytes as BlobPart], { type: "image/vnd.radiance" }), `${name}.hdr`);
      downloadTextFile(JSON.stringify({ ...output.receipt, hdrSha256: hash }, null, 2), `${name}.json`, "application/json");
      setPhase(preview ? output.receipt.converged ? "ready" : "noise-limited" : "exported");
    } catch (cause) { fail(current, cause); }
  }
  async function exportPng() {
    const run = render.current, packet = prepared.current; if (!run || !packet) return;
    if (!currentMatches()) { stop("invalidated"); return; }
    const current = generation.current, before = phase; setPhase("exporting");
    try {
      const frame = await run.frame(), png = await encodePathTracePng(frame), hash = await sha256Hex(png);
      if (current !== generation.current || !currentMatches()) { stop("invalidated"); return; }
      const preview = !frame.converged, name = `${safeImageName(packet.sceneName)}-${packet.illumination}-${preview ? "preview" : "final"}`;
      downloadBlob(new Blob([png as BlobPart], { type: "image/png" }), `${name}.png`);
      downloadTextFile(JSON.stringify({ ...run.describe(preview), format: "png-srgb", width: frame.width, height: frame.height,
        pngBytes: png.byteLength, pngSha256: hash, linearHdr: false, outputColorSpace: DEFAULT_DISPLAY_CONTRACT.outputColorSpace,
        toneMapping: { operator: DEFAULT_DISPLAY_CONTRACT.toneMapping.operator, exposure: PATH_TRACE_DISPLAY_EXPOSURE } },
        null, 2), `${name}-png.json`, "application/json");
      setPhase(before);
    } catch (cause) { fail(current, cause); }
  }
  const text = (zh: string, en: string) => tr(props.locale, zh, en);
  const status = phase === "preparing" ? text("编译场景", "Compiling scene") : phase === "accumulating" ? text("积累中", "Accumulating")
    : phase === "ready" ? text("已收敛", "Converged") : phase === "noise-limited" ? text("尚未收敛 · 可保存预览", "Noise gate not met · Preview available")
    : phase === "invalidated" ? text("场景已修改 · 积累已清空", "Scene changed · Accumulation cleared")
    : phase === "cancelled" ? text("已取消 · 内存已释放", "Cancelled · Memory released") : phase === "exported" ? text("HDR 已导出", "HDR exported")
    : phase === "exporting" ? text("正在导出", "Exporting") : phase === "failed" ? text("无法出图", "Render unavailable") : text("准备开始", "Ready to render");
  const noPreviewReason = text("累积结束或点击「停止并保留」后可保存预览", "Available when accumulation ends or after \u201CStop and keep\u201D");
  const noFinalReason = text("需先通过逐像素噪声门（2%）；未收敛时可保存预览", "Requires the per-pixel noise gate (2%); save a preview before convergence");
  return createPortal(<dialog ref={dialog} className="path-trace-dialog" aria-labelledby="path-trace-title"
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header><div><small>{text("静帧 · 线性 HDR / sRGB PNG", "Still image · Linear HDR / sRGB PNG")}</small><h2 id="path-trace-title">{text("物理光照出图", "Physical lighting render")}</h2></div>
      <button className="button icon ghost" aria-label={text("关闭", "Close")} onClick={close}><X size={18}/></button></header>
    <div className="path-trace-body"><div className="path-trace-preview">
      <div className="path-trace-stage" data-loading={phase === "preparing" || (phase === "accumulating" && !progress) || undefined}
        style={{ aspectRatio: `${width} / ${pathTraceHeight(width)}` }}>
        <canvas ref={canvas} hidden={!progress} aria-label={text("路径追踪预览", "Path traced preview")}/>
        {!progress && <p>{phase === "preparing" ? text("正在编译场景…", "Compiling the scene…") : phase === "accumulating"
          ? text(`正在启动 ${activeWorkers} 个渲染线程…`, `Starting ${activeWorkers} render threads…`)
          : text("累积后显示真实光照预览", "Physical lighting appears as samples accumulate")}</p>}
      </div>
      <small>{text("ACES 预览 · HDR 保留线性辐亮度 · PNG 为 sRGB", "ACES preview · HDR retains linear radiance · PNG is sRGB")}</small>
    </div><div className="path-trace-controls">
      <label>{text("照明模式", "Lighting mode")}<select value={mode} disabled={busy} onChange={event=>setMode(event.target.value as PathTraceAuthorIllumination)}>
        <option value="physical-scene-radiance">{text("物理光照 · 当前场景", "Physical lighting · Current scene")}</option>
        <option value="directional-reference">{text("方向光参考 · 环境关闭", "Directional reference · Environment off")}</option>
        <option value="white-furnace-reference">{text("白炉参考", "White furnace reference")}</option></select></label>
      <p>{text("实时 GI 增强不参与物理出图。辅助网格与屏幕效果不写入 HDR。", "Realtime GI enhancement is excluded. Editor grid and screen effects are excluded from HDR.")}</p>
      <PathTraceResolutionPicker locale={props.locale} width={width} disabled={busy} samples={samples} tiers={tiers} budgetBytes={budget}
        workers={tier.workers} onChange={setWidth}/>
      <label>{text("并行线程", "Parallel threads")}<select value={threads} disabled={busy} onChange={event=>setThreads(Number(event.target.value))}>
        <option value={0}>{text(`自动 · ${cap} 线程`, `Auto · ${cap} threads`)}</option>
        {Array.from({ length: cap }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>{text("样本上限", "Sample limit")}<select value={samples} disabled={busy} onChange={event=>setSamples(Number(event.target.value))}>
        {[256,1024,4096,16384,32768,65536].map(value=><option key={value} value={value}>{value}{value===65536?text(" · 长耗时"," · Long render"):""}</option>)}</select></label>
      <label>{text("种子", "Seed")}<input type="number" min={0} max={4294967295} step={1} value={seed} disabled={busy} onChange={event=>setSeed(Number(event.target.value))}/></label>
      <small>{text("场景默认视角 · CPU 多跳积分 · 同种子同线程数可复现 · 噪声门 2%", "Default scene camera · CPU path tracing · Same seed and threads reproduce · Noise gate 2%")}</small>
    </div></div>
    <PathTraceStatusBar locale={props.locale} status={status} phase={phase} progress={progress} samples={samples} workers={activeWorkers}/>
    {error && <p className="path-trace-error" role="alert">{error}</p>}
    <footer>{busy && phase !== "exporting" ? <div>
        <button className="button ghost" onClick={()=>stop()}><Square size={14}/>{text("取消","Cancel")}</button>
        {phase === "accumulating" && <button className="button ghost" disabled={!progress} title={progress ? "" : text("首帧出现后可用", "Available after the first frame")}
          onClick={()=>render.current?.requestStop()}>{text("停止并保留","Stop and keep")}</button>}</div>
      : <button className="button ghost" disabled={busy || !tier.available} title={tier.available ? "" : text("当前分辨率超出内存预算", "This resolution exceeds the memory budget")}
          onClick={()=>void start()}><Play size={14}/>{text("开始积累","Start accumulation")}</button>}
      <div><button className="button ghost" disabled={busy||!finished||phase==="exported"} title={finished ? "" : noPreviewReason} onClick={()=>void exportHdr(true)}><Save size={14}/>{text("保存预览","Save preview")}</button>
        <button className="button ghost" disabled={busy||!finished} title={finished ? "" : noPreviewReason} onClick={()=>void exportPng()}><FileImage size={14}/>{text("导出 PNG","Export PNG")}</button>
        <button className="button primary" disabled={phase!=="ready"} title={phase==="ready" ? "" : noFinalReason} onClick={()=>void exportHdr(false)}><Download size={14}/>{text("导出 HDR","Export HDR")}</button></div></footer>
  </dialog>, document.querySelector(".app-shell") ?? document.body);
}
