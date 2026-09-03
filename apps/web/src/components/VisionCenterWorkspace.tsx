import {
  Activity,
  AlertTriangle,
  Box,
  Camera,
  CheckCircle2,
  Download,
  FileImage,
  ImagePlus,
  LoaderCircle,
  PackagePlus,
  Pencil,
  Play,
  Plus,
  ScanSearch,
  ShieldCheck,
  Trash2,
  Upload,
  Video,
} from "lucide-react";
import { translate as tr } from "../i18n";
import { api } from "../api";
import { SecondaryPageBack } from "./SecondaryPageBack";
import type { VisionCenterController } from "./useVisionCenterController";
import {
  boxStyle,
  Empty,
  formatBytes,
  InferenceResult,
  providerLabel,
} from "./VisionCenterPrimitives";
import { VisionEventLocalizationBadge } from "./VisionEventLocalizationBadge";
import { VisionSourcePreview } from "./VisionSourcePreview";
import { VisionTaskDependencyFlow } from "./VisionTaskDependencyFlow";

export function VisionCenterWorkspace({
  controller,
}: {
  controller: VisionCenterController;
}) {
  const {
    locale,
    project,
    onBack,
    tab,
    setTab,
    sources,
    models,
    tasks,
    events,
    presets,
    busy,
    error,
    setError,
    setSourceForm,
    openNewTask,
    openTaskEditor,
    setModelForm,
    selectedImageTaskId,
    setSelectedImageTaskId,
    result,
    setResult,
    setReviewEvent,
    setReviewDraft,
    imageInput,
    readyModels,
    previewSourceId,
    setPreviewSourceId,
    load,
    run,
    inferImage,
    downloadTemplate,
  } = controller;

  return (
    <>
      <header className="vision-header secondary-page-header">
        <SecondaryPageBack locale={locale} onBack={onBack} />
        <div className="secondary-page-heading-row">
          <div>
            <span className="eyebrow">VISUAL AI OPERATIONS</span>
            <h1>{tr(locale, "视觉中心", "Vision center")}</h1>
            <p>
              {project.name} ·{" "}
              {tr(
                locale,
                "实时视频与图片识别，结果直接联动三维场景",
                "Live video and image inference linked to 3D scenes",
              )}
            </p>
          </div>
        </div>
        <div className="vision-summary">
          <span>
            <Camera size={15} />
            {sources.length} {tr(locale, "视觉源", "sources")}
          </span>
          <span>
            <ScanSearch size={15} />
            {tasks.filter((item) => item.enabled).length}{" "}
            {tr(locale, "运行中", "running")}
          </span>
          <span>
            <AlertTriangle size={15} />
            {events.filter((item) => item.status === "pending").length}{" "}
            {tr(locale, "待处理", "pending")}
          </span>
        </div>
      </header>
      <nav className="vision-tabs">
        {(["tasks", "sources", "events", "models"] as const).map((item) => (
          <button
            key={item}
            className={tab === item ? "active" : ""}
            onClick={() => setTab(item)}
          >
            {item === "tasks" ? (
              <>
                <Activity size={15} />
                {tr(locale, "识别任务", "Tasks")}
              </>
            ) : item === "sources" ? (
              <>
                <Video size={15} />
                {tr(locale, "视觉源", "Sources")}
              </>
            ) : item === "events" ? (
              <>
                <AlertTriangle size={15} />
                {tr(locale, "识别记录", "Events")}
              </>
            ) : (
              <>
                <Box size={15} />
                {tr(locale, "AI模型", "Models")}
              </>
            )}
          </button>
        ))}
      </nav>
      {error && (
        <div className="vision-error">
          <AlertTriangle size={15} />
          <span>{error}</span>
          <button onClick={() => setError("")}>×</button>
        </div>
      )}

      <section className="vision-content">
        {tab === "tasks" && (
          <div className="vision-task-layout">
            <section className="vision-panel">
              <header>
                <div>
                  <strong>{tr(locale, "识别任务", "Inference tasks")}</strong>
                  <small>
                    {tr(
                      locale,
                      "图片与视频共用模型、规则和三维绑定",
                      "Images and video share models, rules and 3D bindings",
                    )}
                  </small>
                </div>
                <button
                  className="button primary"
                  disabled={!readyModels.length}
                  onClick={openNewTask}
                >
                  <Plus size={14} />
                  {tr(locale, "新建任务", "New task")}
                </button>
              </header>
              <div className="vision-card-list">
                {tasks.map((task) => (
                  <article className="vision-task-card" key={task.id}>
                    <span className={`vision-task-icon ${task.status}`}>
                      {task.mode === "video" ? (
                        <Video size={17} />
                      ) : (
                        <FileImage size={17} />
                      )}
                    </span>
                    <div>
                      <strong>{task.name}</strong>
                      <small>
                        {models.find((item) => item.id === task.modelId)
                          ?.name ?? task.modelId}
                      </small>
                      <div className="vision-runtime-metrics">
                        <i
                          className={
                            task.activeExecutionProvider === "directml"
                              ? "gpu"
                              : "cpu"
                          }
                        >
                          {providerLabel(task, locale)}
                        </i>
                        {task.lastInferenceMs !== undefined && (
                          <i>{task.lastInferenceMs} ms</i>
                        )}
                        {task.actualInferenceFps !== undefined && (
                          <i>{task.actualInferenceFps} FPS</i>
                        )}
                      </div>
                      <VisionTaskDependencyFlow
                        task={task}
                        sources={sources}
                        models={models}
                        locale={locale}
                      />
                      <em title={task.executionFallbackReason}>
                        {task.message}
                      </em>
                      {task.executionFallbackReason && (
                        <small
                          className="vision-fallback-reason"
                          title={task.executionFallbackReason}
                        >
                          {tr(locale, "GPU 回退：", "GPU fallback: ")}
                          {task.executionFallbackReason}
                        </small>
                      )}
                    </div>
                    <span
                      className={`vision-state ${task.enabled ? "online" : ""}`}
                    >
                      {task.enabled
                        ? tr(locale, "运行中", "Running")
                        : tr(locale, "已停止", "Stopped")}
                    </span>
                    <button
                      aria-label={
                        task.enabled
                          ? tr(locale, `停止任务“${task.name}”`, `Stop task “${task.name}”`)
                          : tr(locale, `启动任务“${task.name}”`, `Start task “${task.name}”`)
                      }
                      title={
                        task.enabled
                          ? tr(locale, "停止", "Stop")
                          : tr(locale, "启动", "Start")
                      }
                      onClick={() =>
                        void run(async () => {
                          await api.updateVisionTask(project.id, task.id, {
                            enabled: !task.enabled,
                            status: task.enabled ? "stopped" : "running",
                            message: task.enabled ? "已停止" : "等待识别",
                          });
                          await load();
                        })
                      }
                    >
                      {task.enabled ? "■" : <Play size={13} />}
                    </button>
                    <button
                      aria-label={tr(locale, `编辑任务“${task.name}”`, `Edit task “${task.name}”`)}
                      title={tr(locale, "编辑", "Edit")}
                      onClick={() => openTaskEditor(task)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="danger"
                      title={tr(locale, "删除", "Delete")}
                      onClick={() =>
                        void run(async () => {
                          await api.deleteVisionTask(project.id, task.id);
                          await load();
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </article>
                ))}
              </div>
              {!tasks.length && (
                <Empty
                  icon={<ScanSearch size={32} />}
                  text={tr(
                    locale,
                    "安装或上传ONNX模型后，新建第一个识别任务",
                    "Install or upload an ONNX model, then create the first task",
                  )}
                />
              )}
            </section>
            <section className="vision-panel vision-image-test">
              <header>
                <div>
                  <strong>
                    {tr(locale, "图片快速识别", "Quick image inference")}
                  </strong>
                  <small>
                    {tr(
                      locale,
                      "用于质量图片、模型上线验证和单张复核",
                      "For quality images, model validation and manual review",
                    )}
                  </small>
                </div>
              </header>
              <label>
                <span>{tr(locale, "图片任务", "Image task")}</span>
                <select
                  value={selectedImageTaskId}
                  onChange={(event) => {
                    setSelectedImageTaskId(event.target.value);
                    setResult(undefined);
                  }}
                >
                  <option value="">
                    {tr(locale, "选择图片识别任务", "Select image task")}
                  </option>
                  {tasks
                    .filter((item) => item.mode === "image")
                    .map((task) => (
                      <option key={task.id} value={task.id}>
                        {task.name}
                      </option>
                    ))}
                </select>
              </label>
              <button
                className="vision-drop"
                disabled={!selectedImageTaskId || busy}
                onClick={() => imageInput.current?.click()}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={24} />
                ) : (
                  <ImagePlus size={25} />
                )}
                <strong>
                  {tr(locale, "上传图片并识别", "Upload image and infer")}
                </strong>
                <small>JPG · PNG · WebP · BMP · TIFF</small>
              </button>
              <input
                ref={imageInput}
                hidden
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff"
                onChange={(event) => void inferImage(event.target.files?.[0])}
              />
              {result && <InferenceResult result={result} locale={locale} />}
            </section>
          </div>
        )}

        {tab === "sources" && (
          <section className="vision-panel">
            <header>
              <div>
                <strong>
                  {tr(locale, "视觉文件与监控源", "Visual files and live sources")}
                </strong>
                <small>{tr(locale, "图片 · 视频文件 · RTSP · RTMP · SRT · HLS · WebRTC", "Images · video files · RTSP · RTMP · SRT · HLS · WebRTC")}</small>
              </div>
              <button
                className="button primary"
                onClick={() => setSourceForm(true)}
              >
                <Plus size={14} />
                {tr(locale, "添加视频源", "Add source")}
              </button>
            </header>
            <div className="vision-grid">
              {sources.map((source) => (
                <article className="vision-source-card" key={source.id}>
                  <div>
                    {source.kind === "image" ? <FileImage size={20} /> : <Video size={20} />}
                    <i className={source.status === "online" ? "online" : ""} />
                  </div>
                  <span>
                    <strong>{source.name}</strong>
                    <small title={source.sourceUrl}>{source.sourceUrl}</small>
                    <em>
                      {source.protocol?.toUpperCase() ?? source.kind.toUpperCase()} ·{" "}
                      {
                        tasks.filter((task) => task.sourceId === source.id)
                          .length
                      }{" "}
                      {tr(locale, "个任务", "tasks")}
                    </em>
                  </span>
                  <button
                    title={tr(locale, "预览播放", "Preview")}
                    onClick={() => setPreviewSourceId(source.id)}
                  >
                    <Play size={13} />
                  </button>
                  <button
                    className="danger"
                    onClick={() =>
                      void run(async () => {
                        await api.deleteVisionSource(project.id, source.id);
                        if (previewSourceId === source.id) setPreviewSourceId("");
                        await load();
                      })
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </article>
              ))}
            </div>
            {sources.find((source) => source.id === previewSourceId) && (
              <VisionSourcePreview
                source={sources.find((source) => source.id === previewSourceId)!}
                locale={locale}
                onClose={() => setPreviewSourceId("")}
              />
            )}
            {!sources.length && (
              <Empty
                icon={<Video size={32} />}
                text={tr(
                  locale,
                  "添加摄像头或实时流地址",
                  "Add a camera or live stream URL",
                )}
              />
            )}
          </section>
        )}

        {tab === "events" && (
          <section className="vision-panel">
            <header>
              <div>
                <strong>{tr(locale, "识别记录", "Inference events")}</strong>
                <small>
                  {tr(
                    locale,
                    "连续帧自动合并；人工复检将结果回写质量闭环",
                    "Consecutive frames are merged; review completes the quality loop",
                  )}
                </small>
              </div>
            </header>
            <div className="vision-event-grid">
              {events.map((event) => (
                <article className="vision-event-card" key={event.id}>
                  <div className="vision-event-image">
                    <img src={event.imageUrl} alt="" />
                    <span className={event.result}>
                      {event.result.toUpperCase()}
                    </span>
                    {event.detections
                      .filter((item) => item.bbox)
                      .slice(0, 20)
                      .map((item, index) => (
                        <i
                          key={`${item.label}-${index}`}
                          style={boxStyle(item.bbox!)}
                        >
                          <b>
                            {item.label} {Math.round(item.confidence * 100)}%
                          </b>
                        </i>
                      ))}
                  </div>
                  <div>
                    <strong>
                      {tasks.find((task) => task.id === event.taskId)?.name ??
                        event.taskId}
                    </strong>
                    <small>
                      {new Date(event.createdAt).toLocaleString(locale)} ·{" "}
                      {event.inferenceMs} ms
                      {event.aggregation &&
                        ` · ${event.aggregation.hits}/${event.aggregation.frames} 帧确认`}
                    </small>
                    {event.qualityContext && (
                      <small>
                        {[
                          event.qualityContext.stationId,
                          event.qualityContext.productId,
                          event.qualityContext.batchId,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    )}
                    <VisionEventLocalizationBadge event={event} scenes={controller.scenes} locale={locale} />
                    <p>
                      {event.detections
                        .slice(0, 4)
                        .map(
                          (item) =>
                            `${item.label} ${Math.round(item.confidence * 100)}%`,
                        )
                        .join(" · ") || tr(locale, "无结果", "No result")}
                    </p>
                    <footer>
                      <span className={event.status}>
                        {event.review
                          ? event.review.verdict === "confirmed"
                            ? tr(locale, "真缺陷", "Confirmed defect")
                            : tr(locale, "误报/漏检", "Review complete")
                          : event.status === "pending"
                            ? tr(locale, "待复检", "Pending review")
                            : event.status === "confirmed"
                              ? tr(locale, "已确认", "Confirmed")
                              : tr(locale, "已关闭", "Closed")}
                      </span>
                      <button
                        onClick={() => {
                          setReviewEvent(event);
                          setReviewDraft({
                            verdict: event.review?.verdict ?? "confirmed",
                            groundTruthLabels:
                              event.review?.groundTruthLabels.join(", ") ||
                              event.detections
                                .map((item) => item.label)
                                .join(", ") ||
                              "ng",
                            disposition:
                              event.review?.disposition ?? "reinspect",
                            reviewer: event.review?.reviewer ?? "质量工程师",
                            note: event.review?.note ?? event.note ?? "",
                          });
                        }}
                      >
                        <CheckCircle2 size={12} />
                        {tr(locale, "复检", "Review")}
                      </button>
                    </footer>
                  </div>
                </article>
              ))}
            </div>
            {!events.length && (
              <Empty
                icon={<ShieldCheck size={32} />}
                text={tr(
                  locale,
                  "还没有图片结果或视频告警",
                  "No image results or video alerts yet",
                )}
              />
            )}
          </section>
        )}

        {tab === "models" && (
          <div className="vision-model-layout">
            <section className="vision-panel">
              <header>
                <div>
                  <strong>
                    {tr(locale, "已安装模型", "Installed models")}
                  </strong>
                  <small>
                    {tr(
                      locale,
                      "模型只负责推理，训练在外部完成",
                      "Models are trained externally and used here for inference",
                    )}
                  </small>
                </div>
                <button
                  className="button primary"
                  onClick={() => setModelForm(true)}
                >
                  <Upload size={14} />
                  {tr(locale, "上传ONNX", "Upload ONNX")}
                </button>
              </header>
              <div className="vision-card-list">
                {models.map((model) => (
                  <article className="vision-model-card" key={model.id}>
                    <span>
                      <Box size={18} />
                    </span>
                    <div>
                      <strong>{model.name}</strong>
                      <small>
                        {model.task} · v{model.version} ·{" "}
                        {formatBytes(model.size)}
                      </small>
                      <em className={model.status}>{model.message}</em>
                    </div>
                    <button
                      className="danger"
                      onClick={() =>
                        void run(async () => {
                          await api.deleteVisionModel(project.id, model.id);
                          await load();
                        })
                      }
                    >
                      <Trash2 size={13} />
                    </button>
                  </article>
                ))}
              </div>
              {!models.length && (
                <Empty
                  icon={<Box size={32} />}
                  text={tr(
                    locale,
                    "从右侧安装预设，或上传外部训练的ONNX模型包",
                    "Install a preset or upload an externally trained ONNX model package",
                  )}
                />
              )}
            </section>
            <section className="vision-panel">
              <header>
                <div>
                  <strong>{tr(locale, "默认预设", "Default presets")}</strong>
                  <small>
                    {tr(
                      locale,
                      "许可证明确的基线模型和安全/质量接入模板",
                      "Licensed baseline models and safety/quality templates",
                    )}
                  </small>
                </div>
              </header>
              <div className="vision-preset-list">
                {presets.map((preset) => {
                  const installed = models.some(
                    (model) =>
                      model.status === "ready" &&
                      model.version === preset.manifest.version &&
                      model.manifest.sourceUrl === preset.manifest.sourceUrl,
                  );
                  return (
                    <article key={preset.id}>
                      <span className={preset.category}>
                        {preset.category === "safety" ? (
                          <ShieldCheck size={17} />
                        ) : preset.category === "quality" ? (
                          <ScanSearch size={17} />
                        ) : (
                          <Box size={17} />
                        )}
                      </span>
                      <div>
                        <strong>{preset.name}</strong>
                        <small>{preset.description}</small>
                        <em>
                          {preset.manifest.license ??
                            tr(locale, "自有模型", "Custom model")}{" "}
                          · {preset.manifest.task}
                        </em>
                      </div>
                      {preset.readyToDownload ? (
                        <button
                          disabled={busy || installed}
                          onClick={() =>
                            void run(async () => {
                              await api.installVisionPreset(
                                project.id,
                                preset.id,
                              );
                              await load();
                            })
                          }
                        >
                          {installed ? (
                            <CheckCircle2 size={13} />
                          ) : (
                            <PackagePlus size={13} />
                          )}
                          {installed
                            ? tr(locale, "已安装", "Installed")
                            : tr(locale, "安装", "Install")}
                        </button>
                      ) : (
                        <button onClick={() => downloadTemplate(preset)}>
                          <Download size={13} />
                          {tr(locale, "模板", "Template")}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </section>
    </>
  );
}
