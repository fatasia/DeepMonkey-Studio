import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Play, Square, X } from "lucide-react";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { downloadBlob, downloadTextFile } from "../browserDownload";
import { safeImageName } from "./dashboardPageImageExport";
import { browserImageDecoder } from "../delivery/browserImageDecoder";
import { normalizeStudioWasmModel } from "../viewer/studioWasmRuntimePackage";
import { buildSceneModelLoader } from "../delivery/probeGridBakeRunner";
import { preparePathTraceAuthor, pathTraceAuthorSourceHash,
  type PathTraceAuthorIllumination, type PathTraceAuthorPrepared } from "../delivery/pathTraceAuthorPreparation";
import type { PathTraceAuthorWorkerInput, PathTraceAuthorWorkerOutput } from "../delivery/pathTraceAuthorWorkerTypes";
import "./PathTraceAuthorDialog.css";

interface Props { readonly locale: AppLocale; readonly models: ProjectRecord["models"]; readonly sourceKey: string;
  readonly getSnapshot: () => SceneSnapshot | undefined; readonly onClose: () => void }
type Progress = Extract<PathTraceAuthorWorkerOutput, { kind: "progress" }>;
export function PathTraceAuthorDialog(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const worker = useRef<Worker | undefined>(undefined), abort = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0), prepared = useRef<PathTraceAuthorPrepared | undefined>(undefined), latest = useRef(props);
  const previousSourceKey = useRef(props.sourceKey);
  latest.current = props;
  const [width, setWidth] = useState(320), [samples, setSamples] = useState(4096), [seed, setSeed] = useState(19);
  const [mode, setMode] = useState<PathTraceAuthorIllumination>("physical-scene-radiance");
  const [phase, setPhase] = useState("idle"), [error, setError] = useState(""), [progress, setProgress] = useState<Progress>();
  const busy = phase === "preparing" || phase === "accumulating" || phase === "exporting";
  function stop(next = "cancelled") {
    generation.current++; abort.current?.abort(); worker.current?.terminate(); worker.current = undefined;
    prepared.current = undefined; setProgress(undefined); setPhase(next);
  }
  function close() { stop(); latest.current.onClose(); }
  useEffect(() => {
    const previous = document.activeElement; dialog.current?.showModal();
    return () => { generation.current++; abort.current?.abort(); worker.current?.terminate();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    if (previousSourceKey.current === props.sourceKey) return;
    previousSourceKey.current = props.sourceKey;
    stop(worker.current && prepared.current ? "invalidated" : "idle"); setError("");
  }, [props.sourceKey]);
  useEffect(() => { stop("idle"); setError(""); }, [width, samples, seed, mode]);
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
  async function start() {
    stop("preparing"); setError("");
    const currentGeneration = generation.current, source = latest.current.getSnapshot();
    if (!source) { setError(tr(props.locale, "场景尚未就绪。", "The scene is not ready.")); setPhase("failed"); return; }
    const controller = new AbortController(); abort.current = controller;
    try {
      const packet = await preparePathTraceAuthor(source, { width, height: Math.round(width * 9 / 16), maxSamples: samples,
        minSamples: 64, varianceThreshold: .02, maxAccumulationBytes: 64 * 1024 * 1024, sampleSeed: seed }, mode,
        { loadModel: buildSceneModelLoader(latest.current.models), imageDecoder: browserImageDecoder,
          normalizeModel: normalizeStudioWasmModel, signal: controller.signal });
      if (currentGeneration !== generation.current) return;
      prepared.current = packet;
      if (!currentMatches()) { stop("invalidated"); return; }
      const task = new Worker(new URL("../delivery/pathTraceAuthorWorker.ts", import.meta.url), { type: "module" });
      worker.current = task;
      task.onerror = event => { if (currentGeneration === generation.current) { stop("failed"); setError(event.message); } };
      task.onmessage = async (event: MessageEvent<PathTraceAuthorWorkerOutput>) => {
        try {
        if (currentGeneration !== generation.current) return;
        if (!currentMatches()) { stop("invalidated"); return; }
        const message = event.data;
        if (message.kind === "progress") { setProgress(message); setPhase(message.done ? message.converged ? "ready" : "noise-limited" : "accumulating"); }
        else if (message.kind === "failed") { stop("failed"); setError(message.message); }
        else {
          const bytes = new Uint8Array(message.output.bytes);
          const digest = await crypto.subtle.digest("SHA-256", bytes);
          if (currentGeneration !== generation.current || !currentMatches()) { stop("invalidated"); return; }
          const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
          const suffix = message.output.receipt.preview ? "preview" : "final";
          const name = `${safeImageName(packet.sceneName)}-${packet.illumination}-${suffix}`;
          downloadBlob(new Blob([bytes], { type: "image/vnd.radiance" }), `${name}.hdr`);
          downloadTextFile(JSON.stringify({ ...message.output.receipt, hdrSha256: hash }, null, 2), `${name}.json`, "application/json");
          setPhase(message.output.receipt.preview ? message.output.receipt.converged ? "ready" : "noise-limited" : "exported");
          if (!message.output.receipt.preview) { task.terminate(); worker.current = undefined; }
        }
        } catch (cause) { if (currentGeneration === generation.current) { stop("failed"); setError(cause instanceof Error ? cause.message : String(cause)); } }
      };
      const command: PathTraceAuthorWorkerInput = { kind: "start", prepared: packet };
      task.postMessage(command); setPhase("accumulating");
    } catch (cause) { if (currentGeneration === generation.current) { stop("failed"); setError(cause instanceof Error ? cause.message : String(cause)); } }
  }
  function exportImage(preview: boolean) {
    if (!currentMatches()) { stop("invalidated"); return; }
    const command: PathTraceAuthorWorkerInput = { kind: "export", preview, sourceHash: prepared.current!.sourceHash };
    worker.current?.postMessage(command); setPhase("exporting");
  }
  const status = phase === "preparing" ? tr(props.locale, "编译场景", "Compiling scene") : phase === "accumulating" ? tr(props.locale, "积累中", "Accumulating")
    : phase === "ready" ? tr(props.locale, "已收敛", "Converged") : phase === "noise-limited" ? tr(props.locale, "尚未收敛 · 可保存预览", "Noise gate not met · Preview available")
    : phase === "invalidated" ? tr(props.locale, "场景已修改 · 积累已清空", "Scene changed · Accumulation cleared")
    : phase === "cancelled" ? tr(props.locale, "已取消 · 内存已释放", "Cancelled · Memory released") : phase === "exported" ? tr(props.locale, "HDR 已导出", "HDR exported")
    : phase === "failed" ? tr(props.locale, "无法出图", "Render unavailable") : tr(props.locale, "准备开始", "Ready to render");
  return createPortal(<dialog ref={dialog} className="path-trace-dialog" aria-labelledby="path-trace-title"
    onCancel={event => { event.preventDefault(); close(); }} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <header><div><small>{tr(props.locale, "静帧 · 线性 HDR", "Still image · Linear HDR")}</small><h2 id="path-trace-title">{tr(props.locale, "物理光照出图", "Physical lighting render")}</h2></div>
      <button className="button icon ghost" aria-label={tr(props.locale, "关闭", "Close")} onClick={close}><X size={18}/></button></header>
    <div className="path-trace-body"><div className="path-trace-preview">
      <canvas ref={canvas} hidden={!progress} aria-label={tr(props.locale, "路径追踪预览", "Path traced preview")}/>
      {!progress && <p>{tr(props.locale, "累积后显示真实光照预览", "Physical lighting appears as samples accumulate")}</p>}
      <small>{tr(props.locale, "ACES 预览 · HDR 保留线性辐亮度", "ACES preview · HDR retains linear radiance")}</small>
    </div><div className="path-trace-controls">
      <label>{tr(props.locale, "照明模式", "Lighting mode")}<select value={mode} disabled={busy} onChange={event=>setMode(event.target.value as PathTraceAuthorIllumination)}>
        <option value="physical-scene-radiance">{tr(props.locale, "物理光照 · 当前场景", "Physical lighting · Current scene")}</option>
        <option value="directional-reference">{tr(props.locale, "方向光参考 · 环境关闭", "Directional reference · Environment off")}</option>
        <option value="white-furnace-reference">{tr(props.locale, "白炉参考", "White furnace reference")}</option></select></label>
      <p>{tr(props.locale, "实时 GI 增强不参与物理出图。辅助网格与屏幕效果不写入 HDR。", "Realtime GI enhancement is excluded. Editor grid and screen effects are excluded from HDR.")}</p>
      <label>{tr(props.locale, "分辨率", "Resolution")}<select value={width} disabled={busy} onChange={event=>setWidth(Number(event.target.value))}>
        {[160,320,640].map(value=><option key={value} value={value}>{value} × {Math.round(value*9/16)}</option>)}</select></label>
      <label>{tr(props.locale, "样本上限", "Sample limit")}<select value={samples} disabled={busy} onChange={event=>setSamples(Number(event.target.value))}>
        {[256,1024,4096,16384,32768,65536].map(value=><option key={value} value={value}>{value}{value===65536?tr(props.locale," · 长耗时"," · Long render"):""}</option>)}</select></label>
      <label>{tr(props.locale, "种子", "Seed")}<input type="number" min={0} max={4294967295} step={1} value={seed} disabled={busy} onChange={event=>setSeed(Number(event.target.value))}/></label>
      <small>{tr(props.locale, "场景默认视角 · CPU 多跳积分 · 逐像素噪声门 2%", "Default scene camera · CPU path tracing · Per-pixel noise gate 2%")}</small>
    </div></div>
    <div className="path-trace-status" role="status"><strong>{status}</strong><span>{progress ? `${progress.samples} spp · ${Number.isFinite(progress.noise)?(progress.noise*100).toFixed(2):"—"}%` : ""}</span></div>
    {error && <p className="path-trace-error" role="alert">{error}</p>}
    <footer>{busy ? <button className="button ghost" onClick={()=>stop()}><Square size={14}/>{tr(props.locale,"取消","Cancel")}</button>
      : <button className="button ghost" onClick={()=>void start()}><Play size={14}/>{tr(props.locale,"开始积累","Start accumulation")}</button>}
      <div><button className="button ghost" disabled={busy||!progress||phase==="exported"} onClick={()=>exportImage(true)}>{tr(props.locale,"保存预览","Save preview")}</button>
        <button className="button primary" disabled={phase!=="ready"} onClick={()=>exportImage(false)}><Download size={14}/>{tr(props.locale,"导出 HDR","Export HDR")}</button></div></footer>
  </dialog>, document.querySelector(".app-shell") ?? document.body);
}
