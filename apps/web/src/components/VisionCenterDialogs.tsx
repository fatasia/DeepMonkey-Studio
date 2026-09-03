import { Upload, Video } from "lucide-react";
import type {
  VisionExecutionProvider,
  VisionModelManifest,
} from "@bim-studio/contracts";
import { translate as tr } from "../i18n";
import { api } from "../api";
import type { VisionCenterController } from "./useVisionCenterController";
import { Modal } from "./VisionCenterPrimitives";
import { visionSceneOptionLabel } from "./VisionCenterPresentation";

export function VisionCenterDialogs({
  controller,
}: {
  controller: VisionCenterController;
}) {
  const {
    locale,
    project,
    scenes,
    sourceForm,
    setSourceForm,
    taskForm,
    setTaskForm,
    editingTaskId,
    modelForm,
    setModelForm,
    sourceDraft,
    setSourceDraft,
    sourceFile,
    setSourceFile,
    taskDraft,
    setTaskDraft,
    manifest,
    setManifest,
    onnxFile,
    setOnnxFile,
    reviewEvent,
    setReviewEvent,
    reviewDraft,
    setReviewDraft,
    readyModels,
    videoSources,
    busy,
    load,
    showError,
    run,
    createSource,
    saveTask,
    uploadModel,
  } = controller;
  const selectedScene = scenes.find((scene) => scene.id === taskDraft.sceneId);
  const selectedTargetIds = new Set(csvValues(taskDraft.objectIds));
  const selectedSceneTargets = selectedScene
    ? [...selectedScene.models, ...selectedScene.primitives].map((item) => ({ id: item.modelId, name: item.name }))
    : [];

  function toggleSceneTarget(targetId: string) {
    const next = new Set(selectedTargetIds);
    if (next.has(targetId)) next.delete(targetId);
    else next.add(targetId);
    setTaskDraft({ ...taskDraft, objectIds: [...next].join(", ") });
  }

  return (
    <>
      {sourceForm && (
        <Modal
          title={tr(locale, "添加实时视频源", "Add live video source")}
          onClose={() => setSourceForm(false)}
        >
          <div className="vision-form-pair">
            <label>
              <span>{tr(locale, "接入方式", "Source type")}</span>
              <select
                value={sourceDraft.mode}
                onChange={(event) =>
                  setSourceDraft({
                    ...sourceDraft,
                    mode: event.target.value as "stream" | "upload",
                  })
                }
              >
                <option value="stream">{tr(locale, "监控流", "Live stream")}</option>
                <option value="upload">{tr(locale, "图片 / 视频文件", "Image / video file")}</option>
              </select>
            </label>
            {sourceDraft.mode === "stream" && (
              <label>
                <span>{tr(locale, "输入协议", "Ingest protocol")}</span>
                <select
                  value={sourceDraft.protocol}
                  onChange={(event) =>
                    setSourceDraft({
                      ...sourceDraft,
                      protocol: event.target.value as typeof sourceDraft.protocol,
                    })
                  }
                >
                  <option value="rtsp">RTSP / RTSPS</option>
                  <option value="rtmp">RTMP / RTMPS</option>
                  <option value="srt">SRT</option>
                  <option value="hls">HLS</option>
                  <option value="webrtc">WebRTC / WHEP</option>
                </select>
              </label>
            )}
          </div>
          <label>
            <span>{tr(locale, "名称", "Name")}</span>
            <input
              autoFocus
              value={sourceDraft.name}
              onChange={(event) =>
                setSourceDraft({ ...sourceDraft, name: event.target.value })
              }
              placeholder={tr(
                locale,
                "例如：一号产线入口",
                "e.g. Line 1 entrance",
              )}
            />
          </label>
          {sourceDraft.mode === "stream" ? (
            <>
              <label>
                <span>{tr(locale, "监控源地址", "Stream URL")}</span>
                <input
                  value={sourceDraft.sourceUrl}
                  onChange={(event) => setSourceDraft({ ...sourceDraft, sourceUrl: event.target.value })}
                  placeholder={sourceDraft.protocol === "hls" ? "https://host/live/index.m3u8" : sourceDraft.protocol === "webrtc" ? "whep:// · wheps:// · https://WHEP" : `${sourceDraft.protocol}://`}
                />
              </label>
              <label>
                <span>{tr(locale, "浏览器播放", "Browser playback")}</span>
                <select
                  value={sourceDraft.playbackProtocol}
                  onChange={(event) => setSourceDraft({ ...sourceDraft, playbackProtocol: event.target.value as "hls" | "webrtc" })}
                >
                  <option value="hls">HLS</option>
                  <option value="webrtc">WebRTC</option>
                </select>
                <small>{tr(locale, "服务端抽帧统一使用原始流或媒体网关 HLS 出口", "Server frame extraction uses the original stream or the gateway HLS output")}</small>
              </label>
            </>
          ) : (
            <label className="vision-file-field">
              <span>{tr(locale, "图片或视频文件", "Image or video file")}</span>
              <input
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.bmp,.tif,.tiff,.mp4,.webm,.ogv,.mov,.mkv,.avi,.m4v"
                onChange={(event) => setSourceFile(event.target.files?.[0])}
              />
              <small>{sourceFile?.name ?? tr(locale, "图片可预览；视频可创建持续抽帧任务", "Images can be previewed; videos can feed frame inference tasks")}</small>
            </label>
          )}
          <footer>
            <button onClick={() => setSourceForm(false)}>
              {tr(locale, "取消", "Cancel")}
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !sourceDraft.name.trim() ||
                (sourceDraft.mode === "stream" ? !sourceDraft.sourceUrl.trim() : !sourceFile)
              }
              onClick={() => void createSource()}
            >
              {tr(locale, "保存并接入", "Save and connect")}
            </button>
          </footer>
        </Modal>
      )}
      {taskForm && (
        <Modal
          title={editingTaskId ? tr(locale, "编辑识别任务", "Edit inference task") : tr(locale, "新建识别任务", "New inference task")}
          onClose={() => setTaskForm(false)}
        >
          <div className="vision-form-pair">
            <label>
              <span>{tr(locale, "任务名称", "Task name")}</span>
              <input
                value={taskDraft.name}
                onChange={(event) =>
                  setTaskDraft({ ...taskDraft, name: event.target.value })
                }
              />
            </label>
            <label>
              <span>{tr(locale, "任务模式", "Mode")}</span>
              <select
                value={taskDraft.mode}
                onChange={(event) =>
                  setTaskDraft({
                    ...taskDraft,
                    mode: event.target.value as "video" | "image",
                  })
                }
              >
                <option value="video">
                  {tr(locale, "实时视频", "Live video")}
                </option>
                <option value="image">{tr(locale, "图片识别", "Image")}</option>
              </select>
            </label>
          </div>
          <label>
            <span>{tr(locale, "ONNX模型", "ONNX model")}</span>
            <select
              value={taskDraft.modelId}
              onChange={(event) =>
                setTaskDraft({ ...taskDraft, modelId: event.target.value })
              }
            >
              <option value="">{tr(locale, "请选择", "Select")}</option>
              {readyModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
          </label>
          <div className="vision-form-pair">
            <label>
              <span>{tr(locale, "推理设备", "Inference device")}</span>
              <select
                value={taskDraft.executionProvider}
                onChange={(event) =>
                  setTaskDraft({
                    ...taskDraft,
                    executionProvider: event.target
                      .value as VisionExecutionProvider,
                  })
                }
              >
                <option value="auto">
                  {tr(locale, "自动（GPU优先）", "Auto (GPU first)")}
                </option>
                <option value="directml">GPU · DirectML</option>
                <option value="cpu">CPU</option>
              </select>
              <small>
                {tr(
                  locale,
                  "自动模式失败时回退 CPU",
                  "Auto falls back to CPU on failure",
                )}
              </small>
            </label>
            <label>
              <span>{tr(locale, "GPU设备编号", "GPU device ID")}</span>
              <input
                type="number"
                min="0"
                step="1"
                disabled={taskDraft.executionProvider === "cpu"}
                value={taskDraft.deviceId}
                onChange={(event) =>
                  setTaskDraft({
                    ...taskDraft,
                    deviceId: Math.max(
                      0,
                      Math.floor(Number(event.target.value)),
                    ),
                  })
                }
              />
              <small>
                {tr(
                  locale,
                  "默认 0；多显卡按系统顺序选择",
                  "Default 0; follows system adapter order",
                )}
              </small>
            </label>
          </div>
          {taskDraft.mode === "video" && (
            <label>
              <span>{tr(locale, "视频源", "Video source")}</span>
              <select
                value={taskDraft.sourceId}
                onChange={(event) =>
                  setTaskDraft({ ...taskDraft, sourceId: event.target.value })
                }
              >
                <option value="">{tr(locale, "请选择", "Select")}</option>
                {videoSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="vision-form-pair">
            <label>
              <span>{tr(locale, "置信度", "Confidence")}</span>
              <input
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={taskDraft.threshold}
                onChange={(event) =>
                  setTaskDraft({
                    ...taskDraft,
                    threshold: Number(event.target.value),
                  })
                }
              />
            </label>
            <label>
              <span>{tr(locale, "推理FPS", "Inference FPS")}</span>
              <input
                type="number"
                min="0.2"
                max="30"
                step="0.2"
                value={taskDraft.inferenceFps}
                onChange={(event) =>
                  setTaskDraft({
                    ...taskDraft,
                    inferenceFps: Number(event.target.value),
                  })
                }
              />
            </label>
          </div>
          <label>
            <span>{tr(locale, "告警类别", "Alert labels")}</span>
            <input
              value={taskDraft.alertLabels}
              onChange={(event) =>
                setTaskDraft({ ...taskDraft, alertLabels: event.target.value })
              }
              placeholder="no_helmet, no_vest, ng"
            />
            <small>
              {tr(
                locale,
                "逗号分隔；留空表示所有识别结果",
                "Comma separated; empty means all detections",
              )}
            </small>
          </label>
          <div className="vision-form-pair">
            <label>
              <span>{tr(locale, "工位", "Station")}</span>
              <input
                value={taskDraft.stationId}
                onChange={(event) =>
                  setTaskDraft({ ...taskDraft, stationId: event.target.value })
                }
                placeholder={tr(locale, "例如：卷绕-02", "e.g. Winding-02")}
              />
            </label>
            <label>
              <span>{tr(locale, "产品 / 批次", "Product / batch")}</span>
              <input
                value={taskDraft.productId}
                onChange={(event) =>
                  setTaskDraft({ ...taskDraft, productId: event.target.value })
                }
                placeholder={tr(locale, "产品型号", "Product ID")}
              />
            </label>
          </div>
          <label>
            <span>{tr(locale, "生产批次", "Production batch")}</span>
            <input
              value={taskDraft.batchId}
              onChange={(event) =>
                setTaskDraft({ ...taskDraft, batchId: event.target.value })
              }
              placeholder={tr(
                locale,
                "可选；自动带入每条复检记录",
                "Optional; attached to each review",
              )}
            />
          </label>
          <label>
            <span>{tr(locale, "绑定场景", "Bind scene")}</span>
            <select
              value={taskDraft.sceneId}
              onChange={(event) =>
                setTaskDraft({ ...taskDraft, sceneId: event.target.value })
              }
            >
              <option value="">{tr(locale, "不绑定", "No binding")}</option>
              {scenes.map((scene) => (
                <option key={scene.id} value={scene.id}>
                  {visionSceneOptionLabel(scene, locale)}
                </option>
              ))}
            </select>
          </label>
          {selectedSceneTargets.length > 0 && (
            <section className="vision-object-picker">
              <header>
                <span>{tr(locale, "选择场景对象", "Select scene objects")}</span>
                <small>{tr(locale, `${selectedTargetIds.size} 个已选`, `${selectedTargetIds.size} selected`)}</small>
              </header>
              <div>
                {selectedSceneTargets.slice(0, 40).map((target) => (
                  <button
                    type="button"
                    className={selectedTargetIds.has(target.id) ? "active" : ""}
                    key={target.id}
                    onClick={() => toggleSceneTarget(target.id)}
                  >
                    <span>{target.name}</span>
                    <small>{target.id}</small>
                  </button>
                ))}
              </div>
              {selectedSceneTargets.length > 40 && <small>{tr(locale, `仅显示前 40 个对象；可在下方输入其余 ID。`, `Showing the first 40 objects; enter any additional IDs below.`)}</small>}
            </section>
          )}
          <label>
            <span>{tr(locale, "对象 ID（高级）", "Object IDs (advanced)")}</span>
            <input
              value={taskDraft.objectIds}
              onChange={(event) =>
                setTaskDraft({ ...taskDraft, objectIds: event.target.value })
              }
              placeholder={tr(
                locale,
                "模型ID或构件ID，逗号分隔",
                "Model or component IDs, comma separated",
              )}
            />
          </label>
          <footer>
            <button onClick={() => setTaskForm(false)}>
              {tr(locale, "取消", "Cancel")}
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !taskDraft.name ||
                !taskDraft.modelId ||
                (taskDraft.mode === "video" && !taskDraft.sourceId)
              }
              onClick={() => void saveTask()}
            >
              {editingTaskId ? tr(locale, "保存修改", "Save changes") : tr(locale, "创建任务", "Create task")}
            </button>
          </footer>
        </Modal>
      )}
      {modelForm && (
        <Modal
          title={tr(locale, "上传ONNX模型包", "Upload ONNX model package")}
          onClose={() => setModelForm(false)}
        >
          <label className="vision-file-field">
            <span>model.onnx</span>
            <input
              type="file"
              accept=".onnx"
              onChange={(event) => setOnnxFile(event.target.files?.[0])}
            />
            <small>
              {onnxFile?.name ??
                tr(
                  locale,
                  "选择外部训练并导出的ONNX文件",
                  "Select an externally trained ONNX file",
                )}
            </small>
          </label>
          <label className="vision-file-field">
            <span>manifest.json</span>
            <input
              type="file"
              accept=".json"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file)
                  void file
                    .text()
                    .then((text) =>
                      setManifest(JSON.parse(text) as VisionModelManifest),
                    )
                    .catch(showError);
              }}
            />
            <small>
              {manifest
                ? `${manifest.name} · ${manifest.task} · ${manifest.labels.length} labels`
                : tr(
                    locale,
                    "描述预处理、输出格式和类别",
                    "Describes preprocessing, output format and labels",
                  )}
            </small>
          </label>
          <footer>
            <button onClick={() => setModelForm(false)}>
              {tr(locale, "取消", "Cancel")}
            </button>
            <button
              className="primary"
              disabled={busy || !onnxFile || !manifest}
              onClick={() => void uploadModel()}
            >
              {tr(locale, "上传并验证", "Upload and validate")}
            </button>
          </footer>
        </Modal>
      )}
      {reviewEvent && (
        <Modal
          title={tr(locale, "质量复检", "Quality review")}
          onClose={() => setReviewEvent(undefined)}
        >
          <div className="vision-form-pair">
            <label>
              <span>{tr(locale, "复检结论", "Verdict")}</span>
              <select
                value={reviewDraft.verdict}
                onChange={(event) =>
                  setReviewDraft({
                    ...reviewDraft,
                    verdict: event.target.value as typeof reviewDraft.verdict,
                  })
                }
              >
                <option value="confirmed">
                  {tr(locale, "真缺陷", "Confirmed defect")}
                </option>
                <option value="false-positive">
                  {tr(locale, "误报", "False positive")}
                </option>
                <option value="false-negative">
                  {tr(locale, "漏检", "False negative")}
                </option>
              </select>
            </label>
            <label>
              <span>{tr(locale, "处置", "Disposition")}</span>
              <select
                value={reviewDraft.disposition}
                onChange={(event) =>
                  setReviewDraft({
                    ...reviewDraft,
                    disposition: event.target
                      .value as typeof reviewDraft.disposition,
                  })
                }
              >
                <option value="reinspect">
                  {tr(locale, "复检", "Reinspect")}
                </option>
                <option value="isolate">{tr(locale, "隔离", "Isolate")}</option>
                <option value="rework">{tr(locale, "返工", "Rework")}</option>
                <option value="release">{tr(locale, "放行", "Release")}</option>
                <option value="scrap">{tr(locale, "报废", "Scrap")}</option>
              </select>
            </label>
          </div>
          <label>
            <span>{tr(locale, "真实类别", "Ground-truth labels")}</span>
            <input
              value={reviewDraft.groundTruthLabels}
              onChange={(event) =>
                setReviewDraft({
                  ...reviewDraft,
                  groundTruthLabels: event.target.value,
                })
              }
              placeholder="scratch, ng"
            />
          </label>
          <label>
            <span>{tr(locale, "复检人", "Reviewer")}</span>
            <input
              value={reviewDraft.reviewer}
              onChange={(event) =>
                setReviewDraft({ ...reviewDraft, reviewer: event.target.value })
              }
            />
          </label>
          <label>
            <span>{tr(locale, "说明", "Note")}</span>
            <input
              value={reviewDraft.note}
              onChange={(event) =>
                setReviewDraft({ ...reviewDraft, note: event.target.value })
              }
              placeholder={tr(locale, "可选", "Optional")}
            />
          </label>
          <footer>
            <button onClick={() => setReviewEvent(undefined)}>
              {tr(locale, "取消", "Cancel")}
            </button>
            <button
              className="primary"
              disabled={
                busy ||
                !reviewDraft.reviewer.trim() ||
                !reviewDraft.groundTruthLabels.trim()
              }
              onClick={() =>
                void run(async () => {
                  await api.updateVisionEvent(project.id, reviewEvent.id, {
                    review: {
                      verdict: reviewDraft.verdict,
                      groundTruthLabels: reviewDraft.groundTruthLabels
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                      disposition: reviewDraft.disposition,
                      reviewer: reviewDraft.reviewer.trim(),
                      reviewedAt: new Date().toISOString(),
                      ...(reviewDraft.note.trim()
                        ? { note: reviewDraft.note.trim() }
                        : {}),
                    },
                  });
                  setReviewEvent(undefined);
                  await load();
                })
              }
            >
              {tr(locale, "提交复检", "Save review")}
            </button>
          </footer>
        </Modal>
      )}
    </>
  );
}

function csvValues(value: string) {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
