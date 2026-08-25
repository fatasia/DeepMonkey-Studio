import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Activity, AlertTriangle, ArrowLeft, Box, Camera, CheckCircle2, Download, Eye, FileImage, ImagePlus, LoaderCircle, PackagePlus, Play, Plus, ScanSearch, ShieldCheck, Trash2, Upload, Video } from "lucide-react";
import type { ProjectRecord, SceneSnapshot, VisionEventRecord, VisionExecutionProvider, VisionInferenceResponse, VisionModelManifest, VisionModelPreset, VisionModelRecord, VisionSourceRecord, VisionTaskRecord } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import { api } from "../api";

type Tab = "tasks" | "sources" | "events" | "models";

export function VisionCenter({ locale, project, scenes, onBack }: { locale: AppLocale; project: ProjectRecord; scenes: SceneSnapshot[]; onBack: () => void }) {
  const [tab, setTab] = useState<Tab>("tasks");
  const [sources, setSources] = useState<VisionSourceRecord[]>([]);
  const [models, setModels] = useState<VisionModelRecord[]>([]);
  const [tasks, setTasks] = useState<VisionTaskRecord[]>([]);
  const [events, setEvents] = useState<VisionEventRecord[]>([]);
  const [presets, setPresets] = useState<VisionModelPreset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sourceForm, setSourceForm] = useState(false);
  const [taskForm, setTaskForm] = useState(false);
  const [modelForm, setModelForm] = useState(false);
  const [sourceDraft, setSourceDraft] = useState({ name: "", sourceUrl: "" });
  const [taskDraft, setTaskDraft] = useState({ name: "", mode: "video" as "video" | "image", sourceId: "", modelId: "", alertLabels: "", sceneId: "", objectIds: "", threshold: 0.6, inferenceFps: 2, executionProvider: "auto" as VisionExecutionProvider, deviceId: 0 });
  const [manifest, setManifest] = useState<VisionModelManifest>();
  const [onnxFile, setOnnxFile] = useState<File>();
  const [selectedImageTaskId, setSelectedImageTaskId] = useState("");
  const [result, setResult] = useState<VisionInferenceResponse>();
  const imageInput = useRef<HTMLInputElement>(null);

  async function load() {
    const [nextSources, nextModels, nextTasks, nextEvents, nextPresets] = await Promise.all([
      api.listVisionSources(project.id), api.listVisionModels(project.id), api.listVisionTasks(project.id), api.listVisionEvents(project.id), api.listVisionPresets()
    ]);
    setSources(nextSources); setModels(nextModels); setTasks(nextTasks); setEvents(nextEvents); setPresets(nextPresets);
    const imageTasks = nextTasks.filter((item) => item.mode === "image");
    setSelectedImageTaskId((current) => imageTasks.some((item) => item.id === current) ? current : imageTasks[0]?.id ?? "");
  }

  useEffect(() => { setError(""); void load().catch(showError); }, [project.id]);
  useEffect(() => {
    const timer = window.setInterval(() => void Promise.all([api.listVisionTasks(project.id), api.listVisionEvents(project.id, 100)]).then(([nextTasks, nextEvents]) => { setTasks(nextTasks); setEvents(nextEvents); }).catch(() => undefined), 3_000);
    return () => window.clearInterval(timer);
  }, [project.id]);

  const readyModels = useMemo(() => models.filter((item) => item.status === "ready"), [models]);
  const videoSources = useMemo(() => sources.filter((item) => item.kind === "video"), [sources]);

  function showError(reason: unknown) { setError(reason instanceof Error ? reason.message : String(reason)); }
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (reason) { showError(reason); } finally { setBusy(false); } }

  async function createSource() {
    await run(async () => {
      const resolved = await api.resolveLiveMonitor(sourceDraft.sourceUrl, "hls");
      await api.createVisionSource(project.id, { name: sourceDraft.name, kind: "video", sourceUrl: sourceDraft.sourceUrl, playbackUrl: resolved.hlsUrl, status: "unknown" });
      setSourceDraft({ name: "", sourceUrl: "" }); setSourceForm(false); await load();
    });
  }

  async function createTask() {
    await run(async () => {
      await api.createVisionTask(project.id, {
        name: taskDraft.name, mode: taskDraft.mode, ...(taskDraft.mode === "video" ? { sourceId: taskDraft.sourceId } : {}), modelId: taskDraft.modelId,
        enabled: false, inferenceFps: taskDraft.inferenceFps, threshold: taskDraft.threshold, iouThreshold: 0.45, durationMs: 0, cooldownMs: 10_000,
        executionProvider: taskDraft.executionProvider, deviceId: taskDraft.deviceId,
        alertLabels: taskDraft.alertLabels.split(",").map((item) => item.trim()).filter(Boolean),
        binding: { ...(taskDraft.sceneId ? { sceneId: taskDraft.sceneId } : {}), objectIds: taskDraft.objectIds.split(",").map((item) => item.trim()).filter(Boolean), actions: ["highlight", "focus", "message"] },
        status: "stopped", message: "已停止"
      });
      setTaskDraft({ name: "", mode: "video", sourceId: "", modelId: "", alertLabels: "", sceneId: "", objectIds: "", threshold: 0.6, inferenceFps: 2, executionProvider: "auto", deviceId: 0 });
      setTaskForm(false); await load();
    });
  }

  async function uploadModel() {
    if (!onnxFile || !manifest) return;
    await run(async () => { await api.uploadVisionModel(project.id, onnxFile, manifest); setOnnxFile(undefined); setManifest(undefined); setModelForm(false); await load(); });
  }

  async function inferImage(file: File | undefined) {
    if (!file || !selectedImageTaskId) return;
    await run(async () => { setResult(await api.inferVisionImage(project.id, selectedImageTaskId, file)); await load(); });
    if (imageInput.current) imageInput.current.value = "";
  }

  function downloadTemplate(preset: VisionModelPreset) {
    const blob = new Blob([JSON.stringify(preset.manifest, null, 2)], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${preset.id}.manifest.json`; link.click(); URL.revokeObjectURL(link.href);
  }

  return <main className="vision-page">
    <header className="vision-header secondary-page-header">
      <div className="secondary-page-heading-row"><button className="button ghost" onClick={onBack}><ArrowLeft size={16} />{tr(locale, "返回场景管理", "Back to scenes")}</button><div><span className="eyebrow">VISUAL AI OPERATIONS</span><h1>{tr(locale, "视觉中心", "Vision center")}</h1><p>{project.name} · {tr(locale, "实时视频与图片识别，结果直接联动三维场景", "Live video and image inference linked to 3D scenes")}</p></div></div>
      <div className="vision-summary"><span><Camera size={15} />{sources.length} {tr(locale, "视觉源", "sources")}</span><span><ScanSearch size={15} />{tasks.filter((item) => item.enabled).length} {tr(locale, "运行中", "running")}</span><span><AlertTriangle size={15} />{events.filter((item) => item.status === "pending").length} {tr(locale, "待处理", "pending")}</span></div>
    </header>
    <nav className="vision-tabs">
      {(["tasks", "sources", "events", "models"] as const).map((item) => <button key={item} className={tab === item ? "active" : ""} onClick={() => setTab(item)}>{item === "tasks" ? <><Activity size={15} />{tr(locale, "识别任务", "Tasks")}</> : item === "sources" ? <><Video size={15} />{tr(locale, "视觉源", "Sources")}</> : item === "events" ? <><AlertTriangle size={15} />{tr(locale, "识别记录", "Events")}</> : <><Box size={15} />{tr(locale, "AI模型", "Models")}</>}</button>)}
    </nav>
    {error && <div className="vision-error"><AlertTriangle size={15} /><span>{error}</span><button onClick={() => setError("")}>×</button></div>}

    <section className="vision-content">
      {tab === "tasks" && <div className="vision-task-layout">
        <section className="vision-panel">
          <header><div><strong>{tr(locale, "识别任务", "Inference tasks")}</strong><small>{tr(locale, "图片与视频共用模型、规则和三维绑定", "Images and video share models, rules and 3D bindings")}</small></div><button className="button primary" disabled={!readyModels.length} onClick={() => setTaskForm(true)}><Plus size={14} />{tr(locale, "新建任务", "New task")}</button></header>
          <div className="vision-card-list">{tasks.map((task) => <article className="vision-task-card" key={task.id}>
            <span className={`vision-task-icon ${task.status}`}>{task.mode === "video" ? <Video size={17} /> : <FileImage size={17} />}</span>
            <div><strong>{task.name}</strong><small>{models.find((item) => item.id === task.modelId)?.name ?? task.modelId}</small><div className="vision-runtime-metrics"><i className={task.activeExecutionProvider === "directml" ? "gpu" : "cpu"}>{providerLabel(task, locale)}</i>{task.lastInferenceMs !== undefined && <i>{task.lastInferenceMs} ms</i>}{task.actualInferenceFps !== undefined && <i>{task.actualInferenceFps} FPS</i>}</div><em title={task.executionFallbackReason}>{task.message}</em>{task.executionFallbackReason && <small className="vision-fallback-reason" title={task.executionFallbackReason}>{tr(locale, "GPU 回退：", "GPU fallback: ")}{task.executionFallbackReason}</small>}</div>
            <span className={`vision-state ${task.enabled ? "online" : ""}`}>{task.enabled ? tr(locale, "运行中", "Running") : tr(locale, "已停止", "Stopped")}</span>
            <button title={task.enabled ? tr(locale, "停止", "Stop") : tr(locale, "启动", "Start")} onClick={() => void run(async () => { await api.updateVisionTask(project.id, task.id, { enabled: !task.enabled, status: task.enabled ? "stopped" : "running", message: task.enabled ? "已停止" : "等待识别" }); await load(); })}>{task.enabled ? "■" : <Play size={13} />}</button>
            <button className="danger" title={tr(locale, "删除", "Delete")} onClick={() => void run(async () => { await api.deleteVisionTask(project.id, task.id); await load(); })}><Trash2 size={13} /></button>
          </article>)}</div>
          {!tasks.length && <Empty icon={<ScanSearch size={32} />} text={tr(locale, "安装或上传ONNX模型后，新建第一个识别任务", "Install or upload an ONNX model, then create the first task")} />}
        </section>
        <section className="vision-panel vision-image-test">
          <header><div><strong>{tr(locale, "图片快速识别", "Quick image inference")}</strong><small>{tr(locale, "用于质量图片、模型上线验证和单张复核", "For quality images, model validation and manual review")}</small></div></header>
          <label><span>{tr(locale, "图片任务", "Image task")}</span><select value={selectedImageTaskId} onChange={(event) => { setSelectedImageTaskId(event.target.value); setResult(undefined); }}><option value="">{tr(locale, "选择图片识别任务", "Select image task")}</option>{tasks.filter((item) => item.mode === "image").map((task) => <option key={task.id} value={task.id}>{task.name}</option>)}</select></label>
          <button className="vision-drop" disabled={!selectedImageTaskId || busy} onClick={() => imageInput.current?.click()}>{busy ? <LoaderCircle className="spin" size={24} /> : <ImagePlus size={25} />}<strong>{tr(locale, "上传图片并识别", "Upload image and infer")}</strong><small>JPG · PNG · WebP · BMP · TIFF</small></button>
          <input ref={imageInput} hidden type="file" accept=".jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff" onChange={(event) => void inferImage(event.target.files?.[0])} />
          {result && <InferenceResult result={result} locale={locale} />}
        </section>
      </div>}

      {tab === "sources" && <section className="vision-panel"><header><div><strong>{tr(locale, "实时视频源", "Live video sources")}</strong><small>RTSP · RTMP · SRT · HLS</small></div><button className="button primary" onClick={() => setSourceForm(true)}><Plus size={14} />{tr(locale, "添加视频源", "Add source")}</button></header><div className="vision-grid">{sources.map((source) => <article className="vision-source-card" key={source.id}><div><Video size={20} /><i className={source.status === "online" ? "online" : ""} /></div><span><strong>{source.name}</strong><small title={source.sourceUrl}>{source.sourceUrl}</small><em>{tasks.filter((task) => task.sourceId === source.id).length} {tr(locale, "个任务", "tasks")}</em></span><button className="danger" onClick={() => void run(async () => { await api.deleteVisionSource(project.id, source.id); await load(); })}><Trash2 size={13} /></button></article>)}</div>{!sources.length && <Empty icon={<Video size={32} />} text={tr(locale, "添加摄像头或实时流地址", "Add a camera or live stream URL")} />}</section>}

      {tab === "events" && <section className="vision-panel"><header><div><strong>{tr(locale, "识别记录", "Inference events")}</strong><small>{tr(locale, "只保存图片识别结果和满足告警规则的视频帧", "Only image results and video frames matching alert rules are stored")}</small></div></header><div className="vision-event-grid">{events.map((event) => <article className="vision-event-card" key={event.id}><div className="vision-event-image"><img src={event.imageUrl} alt="" /><span className={event.result}>{event.result.toUpperCase()}</span>{event.detections.filter((item) => item.bbox).slice(0, 20).map((item, index) => <i key={`${item.label}-${index}`} style={boxStyle(item.bbox!)}><b>{item.label} {Math.round(item.confidence * 100)}%</b></i>)}</div><div><strong>{tasks.find((task) => task.id === event.taskId)?.name ?? event.taskId}</strong><small>{new Date(event.createdAt).toLocaleString(locale)} · {event.inferenceMs} ms</small><p>{event.detections.slice(0, 4).map((item) => `${item.label} ${Math.round(item.confidence * 100)}%`).join(" · ") || tr(locale, "无结果", "No result")}</p><footer><span className={event.status}>{event.status === "pending" ? tr(locale, "待处理", "Pending") : event.status === "confirmed" ? tr(locale, "已确认", "Confirmed") : tr(locale, "已关闭", "Closed")}</span>{event.status !== "closed" && <button onClick={() => void run(async () => { await api.updateVisionEvent(project.id, event.id, { status: event.status === "pending" ? "confirmed" : "closed" }); await load(); })}><CheckCircle2 size={12} />{event.status === "pending" ? tr(locale, "确认", "Confirm") : tr(locale, "关闭", "Close")}</button>}</footer></div></article>)}</div>{!events.length && <Empty icon={<ShieldCheck size={32} />} text={tr(locale, "还没有图片结果或视频告警", "No image results or video alerts yet")} />}</section>}

      {tab === "models" && <div className="vision-model-layout"><section className="vision-panel"><header><div><strong>{tr(locale, "已安装模型", "Installed models")}</strong><small>{tr(locale, "模型只负责推理，训练在外部完成", "Models are trained externally and used here for inference")}</small></div><button className="button primary" onClick={() => setModelForm(true)}><Upload size={14} />{tr(locale, "上传ONNX", "Upload ONNX")}</button></header><div className="vision-card-list">{models.map((model) => <article className="vision-model-card" key={model.id}><span><Box size={18} /></span><div><strong>{model.name}</strong><small>{model.task} · v{model.version} · {formatBytes(model.size)}</small><em className={model.status}>{model.message}</em></div><button className="danger" onClick={() => void run(async () => { await api.deleteVisionModel(project.id, model.id); await load(); })}><Trash2 size={13} /></button></article>)}</div>{!models.length && <Empty icon={<Box size={32} />} text={tr(locale, "从右侧安装预设，或上传外部训练的ONNX模型包", "Install a preset or upload an externally trained ONNX model package")} />}</section><section className="vision-panel"><header><div><strong>{tr(locale, "默认预设", "Default presets")}</strong><small>{tr(locale, "许可证明确的基线模型和安全/质量接入模板", "Licensed baseline models and safety/quality templates")}</small></div></header><div className="vision-preset-list">{presets.map((preset) => { const installed = models.some((model) => model.status === "ready" && model.version === preset.manifest.version && model.manifest.sourceUrl === preset.manifest.sourceUrl); return <article key={preset.id}><span className={preset.category}>{preset.category === "safety" ? <ShieldCheck size={17} /> : preset.category === "quality" ? <ScanSearch size={17} /> : <Box size={17} />}</span><div><strong>{preset.name}</strong><small>{preset.description}</small><em>{preset.manifest.license ?? tr(locale, "自有模型", "Custom model")} · {preset.manifest.task}</em></div>{preset.readyToDownload ? <button disabled={busy || installed} onClick={() => void run(async () => { await api.installVisionPreset(project.id, preset.id); await load(); })}>{installed ? <CheckCircle2 size={13} /> : <PackagePlus size={13} />}{installed ? tr(locale, "已安装", "Installed") : tr(locale, "安装", "Install")}</button> : <button onClick={() => downloadTemplate(preset)}><Download size={13} />{tr(locale, "模板", "Template")}</button>}</article>; })}</div></section></div>}
    </section>

    {sourceForm && <Modal title={tr(locale, "添加实时视频源", "Add live video source")} onClose={() => setSourceForm(false)}><label><span>{tr(locale, "名称", "Name")}</span><input autoFocus value={sourceDraft.name} onChange={(event) => setSourceDraft({ ...sourceDraft, name: event.target.value })} placeholder={tr(locale, "例如：一号产线入口", "e.g. Line 1 entrance")} /></label><label><span>{tr(locale, "视频地址", "Stream URL")}</span><input value={sourceDraft.sourceUrl} onChange={(event) => setSourceDraft({ ...sourceDraft, sourceUrl: event.target.value })} placeholder="rtsp:// · rtmp:// · srt:// · https://" /></label><footer><button onClick={() => setSourceForm(false)}>{tr(locale, "取消", "Cancel")}</button><button className="primary" disabled={busy || !sourceDraft.name.trim() || !sourceDraft.sourceUrl.trim()} onClick={() => void createSource()}>{tr(locale, "保存并接入", "Save and connect")}</button></footer></Modal>}
    {taskForm && <Modal title={tr(locale, "新建识别任务", "New inference task")} onClose={() => setTaskForm(false)}>
      <div className="vision-form-pair"><label><span>{tr(locale, "任务名称", "Task name")}</span><input value={taskDraft.name} onChange={(event) => setTaskDraft({ ...taskDraft, name: event.target.value })} /></label><label><span>{tr(locale, "任务模式", "Mode")}</span><select value={taskDraft.mode} onChange={(event) => setTaskDraft({ ...taskDraft, mode: event.target.value as "video" | "image" })}><option value="video">{tr(locale, "实时视频", "Live video")}</option><option value="image">{tr(locale, "图片识别", "Image")}</option></select></label></div>
      <label><span>{tr(locale, "ONNX模型", "ONNX model")}</span><select value={taskDraft.modelId} onChange={(event) => setTaskDraft({ ...taskDraft, modelId: event.target.value })}><option value="">{tr(locale, "请选择", "Select")}</option>{readyModels.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>
      <div className="vision-form-pair"><label><span>{tr(locale, "推理设备", "Inference device")}</span><select value={taskDraft.executionProvider} onChange={(event) => setTaskDraft({ ...taskDraft, executionProvider: event.target.value as VisionExecutionProvider })}><option value="auto">{tr(locale, "自动（GPU优先）", "Auto (GPU first)")}</option><option value="directml">GPU · DirectML</option><option value="cpu">CPU</option></select><small>{tr(locale, "自动模式失败时回退 CPU", "Auto falls back to CPU on failure")}</small></label><label><span>{tr(locale, "GPU设备编号", "GPU device ID")}</span><input type="number" min="0" step="1" disabled={taskDraft.executionProvider === "cpu"} value={taskDraft.deviceId} onChange={(event) => setTaskDraft({ ...taskDraft, deviceId: Math.max(0, Math.floor(Number(event.target.value))) })} /><small>{tr(locale, "默认 0；多显卡按系统顺序选择", "Default 0; follows system adapter order")}</small></label></div>
      {taskDraft.mode === "video" && <label><span>{tr(locale, "视频源", "Video source")}</span><select value={taskDraft.sourceId} onChange={(event) => setTaskDraft({ ...taskDraft, sourceId: event.target.value })}><option value="">{tr(locale, "请选择", "Select")}</option>{videoSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>}
      <div className="vision-form-pair"><label><span>{tr(locale, "置信度", "Confidence")}</span><input type="number" min="0" max="1" step="0.05" value={taskDraft.threshold} onChange={(event) => setTaskDraft({ ...taskDraft, threshold: Number(event.target.value) })} /></label><label><span>{tr(locale, "推理FPS", "Inference FPS")}</span><input type="number" min="0.2" max="30" step="0.2" value={taskDraft.inferenceFps} onChange={(event) => setTaskDraft({ ...taskDraft, inferenceFps: Number(event.target.value) })} /></label></div>
      <label><span>{tr(locale, "告警类别", "Alert labels")}</span><input value={taskDraft.alertLabels} onChange={(event) => setTaskDraft({ ...taskDraft, alertLabels: event.target.value })} placeholder="no_helmet, no_vest, ng" /><small>{tr(locale, "逗号分隔；留空表示所有识别结果", "Comma separated; empty means all detections")}</small></label>
      <label><span>{tr(locale, "绑定场景", "Bind scene")}</span><select value={taskDraft.sceneId} onChange={(event) => setTaskDraft({ ...taskDraft, sceneId: event.target.value })}><option value="">{tr(locale, "不绑定", "No binding")}</option>{scenes.map((scene) => <option key={scene.id} value={scene.id}>{scene.name}</option>)}</select></label>
      <label><span>{tr(locale, "三维对象ID", "3D object IDs")}</span><input value={taskDraft.objectIds} onChange={(event) => setTaskDraft({ ...taskDraft, objectIds: event.target.value })} placeholder={tr(locale, "模型ID或构件ID，逗号分隔", "Model or component IDs, comma separated")} /></label>
      <footer><button onClick={() => setTaskForm(false)}>{tr(locale, "取消", "Cancel")}</button><button className="primary" disabled={busy || !taskDraft.name || !taskDraft.modelId || (taskDraft.mode === "video" && !taskDraft.sourceId)} onClick={() => void createTask()}>{tr(locale, "创建任务", "Create task")}</button></footer>
    </Modal>}
    {modelForm && <Modal title={tr(locale, "上传ONNX模型包", "Upload ONNX model package")} onClose={() => setModelForm(false)}><label className="vision-file-field"><span>model.onnx</span><input type="file" accept=".onnx" onChange={(event) => setOnnxFile(event.target.files?.[0])} /><small>{onnxFile?.name ?? tr(locale, "选择外部训练并导出的ONNX文件", "Select an externally trained ONNX file")}</small></label><label className="vision-file-field"><span>manifest.json</span><input type="file" accept=".json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void file.text().then((text) => setManifest(JSON.parse(text) as VisionModelManifest)).catch(showError); }} /><small>{manifest ? `${manifest.name} · ${manifest.task} · ${manifest.labels.length} labels` : tr(locale, "描述预处理、输出格式和类别", "Describes preprocessing, output format and labels")}</small></label><footer><button onClick={() => setModelForm(false)}>{tr(locale, "取消", "Cancel")}</button><button className="primary" disabled={busy || !onnxFile || !manifest} onClick={() => void uploadModel()}>{tr(locale, "上传并验证", "Upload and validate")}</button></footer></Modal>}
  </main>;
}

function InferenceResult({ result, locale }: { result: VisionInferenceResponse; locale: AppLocale }) {
  return <div className="vision-result"><div className="vision-result-image"><img src={result.event.imageUrl} alt="" />{result.event.detections.filter((item) => item.bbox).map((item, index) => <i key={`${item.label}-${index}`} style={boxStyle(item.bbox!)}><b>{item.label} {Math.round(item.confidence * 100)}%</b></i>)}</div><div className="vision-result-summary"><span className={result.event.result}>{result.event.result.toUpperCase()}</span><strong>{result.event.inferenceMs} ms</strong><small>{result.event.executionProvider === "directml" ? "GPU · DirectML" : "CPU"} · {result.imageWidth}×{result.imageHeight}</small></div>{result.event.executionFallbackReason && <p className="vision-result-fallback">{tr(locale, "GPU 回退：", "GPU fallback: ")}{result.event.executionFallbackReason}</p>}<ol>{result.event.detections.slice(0, 5).map((item, index) => <li key={`${item.label}-${index}`}><span>{item.label}</span><b>{(item.confidence * 100).toFixed(1)}%</b></li>)}</ol>{!result.event.detections.length && <p>{tr(locale, "未识别到超过阈值的目标", "No result exceeded the threshold")}</p>}</div>;
}

function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) { return <div className="dialog-backdrop" onMouseDown={onClose}><section className="vision-modal" onMouseDown={(event) => event.stopPropagation()}><header><strong>{title}</strong><button onClick={onClose}>×</button></header>{children}</section></div>; }
function Empty({ icon, text }: { icon: ReactNode; text: string }) { return <div className="vision-empty">{icon}<span>{text}</span></div>; }
function boxStyle(bbox: [number, number, number, number]): CSSProperties { return { left: `${bbox[0] * 100}%`, top: `${bbox[1] * 100}%`, width: `${Math.max(0, bbox[2] - bbox[0]) * 100}%`, height: `${Math.max(0, bbox[3] - bbox[1]) * 100}%` }; }
function formatBytes(value: number) { return value < 1024 * 1024 ? `${Math.max(1, Math.round(value / 1024))} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`; }
function providerLabel(task: VisionTaskRecord, locale: AppLocale) {
  if (task.activeExecutionProvider === "directml") return "GPU · DirectML";
  if (task.activeExecutionProvider === "cpu") return task.executionFallbackReason ? tr(locale, "CPU · 已回退", "CPU · fallback") : "CPU";
  if (task.executionProvider === "directml") return "GPU · DirectML";
  if (task.executionProvider === "cpu") return "CPU";
  return tr(locale, "自动 · GPU优先", "Auto · GPU first");
}
