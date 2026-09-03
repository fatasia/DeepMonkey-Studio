import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ProjectRecord,
  SceneSnapshot,
  VisionEventRecord,
  VisionExecutionProvider,
  VisionInferenceResponse,
  VisionModelManifest,
  VisionModelPreset,
  VisionModelRecord,
  VisionSourceRecord,
  VisionSourceProtocol,
  VisionTaskRecord,
} from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { api } from "../api";

type Tab = "tasks" | "sources" | "events" | "models";

export function useVisionCenterController({
  locale,
  project,
  scenes,
  onBack,
}: {
  locale: AppLocale;
  project: ProjectRecord;
  scenes: SceneSnapshot[];
  onBack: () => void;
}) {
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
  const [editingTaskId, setEditingTaskId] = useState<string>();
  const [modelForm, setModelForm] = useState(false);
  const [sourceDraft, setSourceDraft] = useState({
    mode: "stream" as "stream" | "upload",
    name: "",
    sourceUrl: "",
    protocol: "rtsp" as Exclude<VisionSourceProtocol, "upload">,
    playbackProtocol: "hls" as "hls" | "webrtc",
  });
  const [sourceFile, setSourceFile] = useState<File>();
  const [previewSourceId, setPreviewSourceId] = useState("");
  const [taskDraft, setTaskDraft] = useState(emptyTaskDraft);
  const [manifest, setManifest] = useState<VisionModelManifest>();
  const [onnxFile, setOnnxFile] = useState<File>();
  const [selectedImageTaskId, setSelectedImageTaskId] = useState("");
  const [result, setResult] = useState<VisionInferenceResponse>();
  const [reviewEvent, setReviewEvent] = useState<VisionEventRecord>();
  const [reviewDraft, setReviewDraft] = useState({
    verdict: "confirmed" as "confirmed" | "false-positive" | "false-negative",
    groundTruthLabels: "ng",
    disposition: "reinspect" as
      | "reinspect"
      | "isolate"
      | "release"
      | "rework"
      | "scrap",
    reviewer: "质量工程师",
    note: "",
  });
  const imageInput = useRef<HTMLInputElement>(null);

  async function load() {
    const [nextSources, nextModels, nextTasks, nextEvents, nextPresets] =
      await Promise.all([
        api.listVisionSources(project.id),
        api.listVisionModels(project.id),
        api.listVisionTasks(project.id),
        api.listVisionEvents(project.id),
        api.listVisionPresets(),
      ]);
    setSources(nextSources);
    setModels(nextModels);
    setTasks(nextTasks);
    setEvents(nextEvents);
    setPresets(nextPresets);
    const imageTasks = nextTasks.filter((item) => item.mode === "image");
    setSelectedImageTaskId((current) =>
      imageTasks.some((item) => item.id === current)
        ? current
        : (imageTasks[0]?.id ?? ""),
    );
  }

  useEffect(() => {
    setError("");
    void load().catch(showError);
  }, [project.id]);
  useEffect(() => {
    const timer = window.setInterval(
      () =>
        void Promise.all([
          api.listVisionTasks(project.id),
          api.listVisionEvents(project.id, 100),
        ])
          .then(([nextTasks, nextEvents]) => {
            setTasks(nextTasks);
            setEvents(nextEvents);
          })
          .catch(() => undefined),
      3_000,
    );
    return () => window.clearInterval(timer);
  }, [project.id]);

  const readyModels = useMemo(
    () => models.filter((item) => item.status === "ready"),
    [models],
  );
  const videoSources = useMemo(
    () => sources.filter((item) => item.kind === "video"),
    [sources],
  );

  function showError(reason: unknown) {
    setError(reason instanceof Error ? reason.message : String(reason));
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function createSource() {
    await run(async () => {
      if (sourceDraft.mode === "upload") {
        if (!sourceFile) return;
        await api.uploadVisionSource(project.id, sourceFile, sourceDraft.name);
      } else {
        await api.createVisionSource(project.id, {
          name: sourceDraft.name,
          kind: "video",
          protocol: sourceDraft.protocol,
          sourceUrl: sourceDraft.sourceUrl,
          playbackProtocol: sourceDraft.playbackProtocol,
          status: "unknown",
        });
      }
      setSourceDraft({ mode: "stream", name: "", sourceUrl: "", protocol: "rtsp", playbackProtocol: "hls" });
      setSourceFile(undefined);
      setSourceForm(false);
      await load();
    });
  }

  function openNewTask() {
    setEditingTaskId(undefined);
    setTaskDraft(emptyTaskDraft());
    setTaskForm(true);
  }

  function openTaskEditor(task: VisionTaskRecord) {
    setEditingTaskId(task.id);
    setTaskDraft({
      name: task.name,
      mode: task.mode,
      sourceId: task.sourceId ?? "",
      modelId: task.modelId,
      alertLabels: task.alertLabels?.join(", ") ?? "",
      sceneId: task.binding.sceneId ?? "",
      objectIds: task.binding.objectIds.join(", "),
      stationId: task.qualityContext?.stationId ?? "",
      productId: task.qualityContext?.productId ?? "",
      batchId: task.qualityContext?.batchId ?? "",
      threshold: task.threshold,
      inferenceFps: task.inferenceFps,
      executionProvider: task.executionProvider,
      deviceId: task.deviceId,
    });
    setTaskForm(true);
  }

  async function saveTask() {
    await run(async () => {
      const configuration: Partial<VisionTaskRecord> = {
        name: taskDraft.name,
        mode: taskDraft.mode,
        ...(taskDraft.mode === "video" ? { sourceId: taskDraft.sourceId } : {}),
        modelId: taskDraft.modelId,
        inferenceFps: taskDraft.inferenceFps,
        threshold: taskDraft.threshold,
        iouThreshold: 0.45,
        durationMs: 0,
        cooldownMs: 10_000,
        executionProvider: taskDraft.executionProvider,
        deviceId: taskDraft.deviceId,
        alertLabels: taskDraft.alertLabels
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        binding: {
          ...(taskDraft.sceneId ? { sceneId: taskDraft.sceneId } : {}),
          objectIds: taskDraft.objectIds
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
          actions: ["highlight", "focus", "message"],
        },
        qualityContext: {
          ...(taskDraft.stationId.trim()
            ? { stationId: taskDraft.stationId.trim() }
            : {}),
          ...(taskDraft.productId.trim()
            ? { productId: taskDraft.productId.trim() }
            : {}),
          ...(taskDraft.batchId.trim()
            ? { batchId: taskDraft.batchId.trim() }
            : {}),
        },
      };
      if (editingTaskId) await api.updateVisionTask(project.id, editingTaskId, configuration);
      else await api.createVisionTask(project.id, { ...configuration, enabled: false, status: "stopped", message: "已停止" });
      setTaskDraft(emptyTaskDraft());
      setEditingTaskId(undefined);
      setTaskForm(false);
      await load();
    });
  }

  async function uploadModel() {
    if (!onnxFile || !manifest) return;
    await run(async () => {
      await api.uploadVisionModel(project.id, onnxFile, manifest);
      setOnnxFile(undefined);
      setManifest(undefined);
      setModelForm(false);
      await load();
    });
  }

  async function inferImage(file: File | undefined) {
    if (!file || !selectedImageTaskId) return;
    await run(async () => {
      setResult(
        await api.inferVisionImage(project.id, selectedImageTaskId, file),
      );
      await load();
    });
    if (imageInput.current) imageInput.current.value = "";
  }

  function downloadTemplate(preset: VisionModelPreset) {
    const blob = new Blob([JSON.stringify(preset.manifest, null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${preset.id}.manifest.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return {
    locale,
    project,
    scenes,
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
    previewSourceId,
    setPreviewSourceId,
    taskDraft,
    setTaskDraft,
    manifest,
    setManifest,
    onnxFile,
    setOnnxFile,
    selectedImageTaskId,
    setSelectedImageTaskId,
    result,
    setResult,
    reviewEvent,
    setReviewEvent,
    reviewDraft,
    setReviewDraft,
    imageInput,
    readyModels,
    videoSources,
    load,
    showError,
    run,
    createSource,
    openNewTask,
    openTaskEditor,
    saveTask,
    uploadModel,
    inferImage,
    downloadTemplate,
  };
}

export type VisionCenterController = ReturnType<
  typeof useVisionCenterController
>;

function emptyTaskDraft() {
  return {
    name: "",
    mode: "video" as "video" | "image",
    sourceId: "",
    modelId: "",
    alertLabels: "",
    sceneId: "",
    objectIds: "",
    stationId: "",
    productId: "",
    batchId: "",
    threshold: 0.6,
    inferenceFps: 2,
    executionProvider: "auto" as VisionExecutionProvider,
    deviceId: 0,
  };
}
