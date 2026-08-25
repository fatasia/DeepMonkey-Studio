import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import * as ort from "onnxruntime-node";
import sharp from "sharp";
import type {
  VisionDetection,
  VisionActiveExecutionProvider,
  VisionEventRecord,
  VisionExecutionProvider,
  VisionInferenceResponse,
  VisionModelManifest,
  VisionModelPreset,
  VisionModelRecord,
  VisionSourceRecord,
  VisionTaskRecord
} from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import type { ObjectStore } from "./objects.js";

interface VisionDependencies {
  store: MetadataStore;
  objects: ObjectStore;
  dataDir: string;
}

interface InferenceResult {
  detections: VisionDetection[];
  imageWidth: number;
  imageHeight: number;
  inferenceMs: number;
  executionProvider: VisionActiveExecutionProvider;
  executionFallbackReason?: string;
}

interface VisionSessionRuntime {
  session: ort.InferenceSession;
  provider: VisionActiveExecutionProvider;
  fallbackReason?: string;
  queue: Promise<void>;
}

const COCO_LABELS = [
  "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
  "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
  "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
  "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
  "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich", "orange",
  "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch", "potted plant", "bed",
  "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard", "cell phone", "microwave", "oven",
  "toaster", "sink", "refrigerator", "book", "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush"
];

const PRESETS: VisionModelPreset[] = [
  {
    id: "ssd-mobilenet-v1-coco",
    name: "SSD MobileNet V1 · 人员车辆检测",
    description: "轻量通用目标检测，可作为人员、车辆和现场目标识别基线。",
    category: "general",
    downloadUrl: "https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12/resolve/main/ssd_mobilenet_v1_12.onnx?download=true",
    readyToDownload: true,
    manifest: {
      schemaVersion: 1, name: "SSD MobileNet V1 · COCO", version: "12", task: "detection",
      input: { width: 1200, height: 1200, channels: 3, layout: "NHWC", color: "RGB", resize: "stretch", dataType: "uint8", scale: 1 },
      output: { format: "ssd", coordinates: "normalized", nmsIncluded: true }, labels: COCO_LABELS,
      threshold: 0.55, iouThreshold: 0.45, license: "Apache-2.0", sourceUrl: "https://huggingface.co/onnxmodelzoo/ssd_mobilenet_v1_12"
    }
  },
  {
    id: "mobilenet-v2-imagenet",
    name: "MobileNet V2 · 图片分类验证",
    description: "轻量图片分类预设，用于验证图片上传、ONNX推理和结果回传链路。",
    category: "quality",
    downloadUrl: "https://huggingface.co/onnxmodelzoo/mobilenetv2-12/resolve/main/mobilenetv2-12.onnx?download=true",
    readyToDownload: true,
    manifest: {
      schemaVersion: 1, name: "MobileNet V2 · ImageNet", version: "12", task: "classification",
      input: { width: 224, height: 224, channels: 3, layout: "NCHW", color: "RGB", resize: "center-crop", scale: 1 / 255, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
      output: { format: "classification-logits" }, labels: Array.from({ length: 1000 }, (_, index) => `class-${index}`),
      threshold: 0, license: "Apache-2.0", sourceUrl: "https://huggingface.co/onnxmodelzoo/mobilenetv2-12"
    }
  },
  {
    id: "yolox-nano-coco",
    name: "YOLOX-Nano · COCO 实时检测",
    description: "约 3.5 MB 的官方轻量 YOLO ONNX，适合验证人员、车辆和实时视频检测链路。",
    category: "general",
    downloadUrl: "https://github.com/Megvii-BaseDetection/YOLOX/releases/download/0.1.1rc0/yolox_nano.onnx",
    readyToDownload: true,
    manifest: {
      schemaVersion: 1, name: "YOLOX-Nano · COCO", version: "0.1.1rc0", task: "detection",
      input: { width: 416, height: 416, channels: 3, layout: "NCHW", color: "BGR", resize: "letterbox", letterboxPosition: "top-left", padding: [114, 114, 114], scale: 1 },
      output: { format: "yolox", coordinates: "input-pixels", nmsIncluded: false }, labels: COCO_LABELS,
      threshold: 0.4, iouThreshold: 0.45, license: "Apache-2.0", sourceUrl: "https://github.com/Megvii-BaseDetection/YOLOX"
    }
  },
  {
    id: "pyronear-smoke-yolo11s",
    name: "Pyronear · 早期烟雾检测",
    description: "Apache-2.0 的早期野外烟雾 ONNX；适合打通烟雾告警链路，室内工厂必须用现场样本复核或再训练。",
    category: "safety",
    downloadUrl: "https://huggingface.co/pyronear/yolo11s_sensitive-detector/resolve/main/onnx_cpu.tar.gz?download=true",
    readyToDownload: true,
    manifest: {
      schemaVersion: 1, name: "Pyronear Early Smoke", version: "1.0.0", task: "detection",
      input: { width: 1024, height: 1024, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: ["smoke"],
      threshold: 0.2, iouThreshold: 0.1, license: "Apache-2.0", sourceUrl: "https://huggingface.co/pyronear/yolo11s_sensitive-detector"
    }
  },
  {
    id: "yolo-coco-template",
    name: "YOLOv5–v11 · 通用检测模板",
    description: "兼容 YOLOv5/v7 的 5+C、YOLOv8/v10/v11 的 4+C，以及已执行 NMS 的 Nx6 输出。",
    category: "general",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "YOLO Detection", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: COCO_LABELS,
      threshold: 0.5, iouThreshold: 0.45
    }
  },
  {
    id: "ppe-detection-template",
    name: "安全帽与反光衣检测 · 接入模板",
    description: "给算法供应商的PPE模型包模板；上传已训练ONNX后即可创建视频任务。",
    category: "safety",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "PPE Detection", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: ["person", "helmet", "no_helmet", "vest", "no_vest"],
      threshold: 0.6, iouThreshold: 0.45
    }
  },
  {
    id: "quality-ng-template",
    name: "产线OK/NG分类 · 接入模板",
    description: "适用于外部训练的产品合格/不合格分类模型。",
    category: "quality",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Quality OK NG", version: "1.0.0", task: "classification",
      input: { width: 224, height: 224, channels: 3, layout: "NCHW", color: "RGB", resize: "center-crop", scale: 1 / 255 },
      output: { format: "classification-logits" }, labels: ["ok", "ng"], threshold: 0.5
    }
  },
  {
    id: "industrial-defect-template",
    name: "工业表面缺陷检测 · 接入模板",
    description: "适配划伤、凹坑、裂纹、毛刺、脏污、缺件和错件等现场 YOLO ONNX；标签应按真实产线数据修改。",
    category: "quality",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Industrial Surface Defect", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false },
      labels: ["scratch", "dent", "crack", "burr", "contamination", "missing_part", "wrong_part"],
      threshold: 0.45, iouThreshold: 0.4
    }
  },
  {
    id: "industrial-anomaly-template",
    name: "工业异常 OK/NG · 接入模板",
    description: "适配 Anomalib、PaddleX 等导出的二分类 ONNX；用于产品整体异常初筛，定位型热力图需后续专用适配器。",
    category: "quality",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Industrial Anomaly OK NG", version: "1.0.0", task: "classification",
      input: { width: 256, height: 256, channels: 3, layout: "NCHW", color: "RGB", resize: "center-crop", scale: 1 / 255 },
      output: { format: "classification-logits" }, labels: ["normal", "anomaly"], threshold: 0.5
    }
  },
  {
    id: "fire-smoke-template",
    name: "火焰与烟雾检测 · 接入模板",
    description: "适配现场训练的火焰/烟雾 YOLO ONNX；建议结合连续帧、温感或烟感信号降低误报。",
    category: "safety",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Fire Smoke Detection", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: ["fire", "smoke"],
      threshold: 0.5, iouThreshold: 0.4
    }
  },
  {
    id: "smoking-template",
    name: "吸烟行为检测 · 接入模板",
    description: "适配人员、香烟和吸烟状态检测 ONNX；生产使用应增加人员跟踪与连续帧确认。",
    category: "safety",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Smoking Detection", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: ["person", "cigarette", "smoking"],
      threshold: 0.55, iouThreshold: 0.4
    }
  },
  {
    id: "unsafe-behavior-template",
    name: "打架、睡岗与跌倒 · 接入模板",
    description: "行为识别模板；单帧只做候选筛查，可靠告警需要连续帧、人员跟踪或姿态/视频时序模型确认。",
    category: "safety",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "Unsafe Human Behavior", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false }, labels: ["person", "fighting", "sleeping", "falling", "phone_call"],
      threshold: 0.6, iouThreshold: 0.4
    }
  },
  {
    id: "sop-operation-template",
    name: "SOP 工序与操作规范 · 接入模板",
    description: "识别人、手、工具、工件、工装、缺件和错件；平台按检测结果与顺序规则组合成步骤完成、漏步和逆序告警。",
    category: "quality",
    readyToDownload: false,
    manifest: {
      schemaVersion: 1, name: "SOP Operation Detection", version: "1.0.0", task: "detection",
      input: { width: 640, height: 640, channels: 3, layout: "NCHW", color: "RGB", resize: "letterbox", scale: 1 / 255 },
      output: { format: "yolo", coordinates: "input-pixels", nmsIncluded: false },
      labels: ["operator", "hand", "tool", "workpiece", "fixture", "missing_part", "wrong_part", "unsafe_action"],
      threshold: 0.55, iouThreshold: 0.4
    }
  }
];

export class VisionEngine {
  private readonly sessions = new Map<string, Promise<VisionSessionRuntime>>();
  private readonly runningTasks = new Set<string>();
  private readonly nextRunAt = new Map<string, number>();
  private readonly lastEventAt = new Map<string, number>();
  private readonly lastInferenceAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly dependencies: VisionDependencies) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 500);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  presets(): VisionModelPreset[] { return structuredClone(PRESETS); }

  async validateModel(projectId: string, model: VisionModelRecord): Promise<VisionModelRecord> {
    try {
      validateManifest(model.manifest);
      const session = await ort.InferenceSession.create(this.modelPath(projectId, model.id), visionSessionOptions("cpu", 0));
      const inputName = model.manifest.input.inputName ?? session.inputNames[0];
      if (!inputName || !session.inputNames.includes(inputName)) throw new Error(`输入节点不存在：${inputName ?? "未提供"}`);
      this.sessions.set(this.sessionKey(projectId, model.id, "cpu", 0), Promise.resolve({ session, provider: "cpu", queue: Promise.resolve() }));
      return { ...model, status: "ready", message: `验证通过 · 输入 ${inputName} · 输出 ${session.outputNames.join(", ")}`, updatedAt: new Date().toISOString() };
    } catch (error) {
      return { ...model, status: "failed", message: error instanceof Error ? error.message : String(error), updatedAt: new Date().toISOString() };
    }
  }

  async installPreset(projectId: string, presetId: string): Promise<VisionModelRecord> {
    const preset = PRESETS.find((item) => item.id === presetId);
    if (!preset?.downloadUrl) throw new Error("该预设是接入模板，不包含可下载权重");
    const installed = this.dependencies.store.listVisionModels(projectId).find((model) =>
      model.status === "ready" && model.manifest.sourceUrl === preset.manifest.sourceUrl && model.version === preset.manifest.version
    );
    if (installed) return installed;
    const id = randomUUID();
    const directory = path.dirname(this.modelPath(projectId, id));
    await mkdir(directory, { recursive: true });
    const response = await fetch(preset.downloadUrl, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error(`预设下载失败：HTTP ${response.status}`);
    const payload = Buffer.from(await response.arrayBuffer());
    await writeFile(this.modelPath(projectId, id), extractOnnxPayload(payload));
    const stats = await stat(this.modelPath(projectId, id));
    const now = new Date().toISOString();
    const candidate: VisionModelRecord = { id, projectId, name: preset.name, version: preset.manifest.version, task: preset.manifest.task, manifest: structuredClone(preset.manifest), modelKey: this.modelKey(projectId, id), size: stats.size, status: "validating", message: "正在验证", createdAt: now, updatedAt: now };
    await this.dependencies.objects.putFile(candidate.modelKey, this.modelPath(projectId, id));
    return this.validateModel(projectId, candidate);
  }

  async runImage(projectId: string, taskId: string, buffer: Buffer, originalName = "image.jpg", sourceId?: string): Promise<VisionInferenceResponse> {
    const task = this.requireTask(projectId, taskId);
    const result = await this.infer(projectId, task, buffer);
    const now = new Date().toISOString();
    const taskWithoutFallback = { ...task };
    delete taskWithoutFallback.executionFallbackReason;
    await this.dependencies.store.saveVisionTask(projectId, {
      ...taskWithoutFallback,
      activeExecutionProvider: result.executionProvider,
      ...(result.executionFallbackReason ? { executionFallbackReason: result.executionFallbackReason } : {}),
      lastInferenceMs: result.inferenceMs,
      actualInferenceFps: roundMetric(1000 / Math.max(1, result.inferenceMs)),
      message: runtimeMessage(result),
      lastRunAt: now,
      updatedAt: now
    });
    return { event: await this.saveEvent(projectId, task, buffer, originalName, result, sourceId), imageWidth: result.imageWidth, imageHeight: result.imageHeight };
  }

  async infer(projectId: string, task: VisionTaskRecord, buffer: Buffer): Promise<InferenceResult> {
    const model = this.dependencies.store.getVisionModel(projectId, task.modelId);
    if (!model || model.status !== "ready") throw new Error("识别任务的ONNX模型尚未就绪");
    let runtime = await this.session(projectId, model, task.executionProvider, task.deviceId);
    const prepared = await prepareImage(buffer, model.manifest);
    const inputName = model.manifest.input.inputName ?? runtime.session.inputNames[0];
    if (!inputName) throw new Error("ONNX模型没有输入节点");
    const started = performance.now();
    const inputTensor = model.manifest.input.dataType === "uint8"
      ? new ort.Tensor("uint8", prepared.data as Uint8Array, prepared.dims)
      : new ort.Tensor("float32", prepared.data as Float32Array, prepared.dims);
    let outputs: ort.InferenceSession.OnnxValueMapType;
    try {
      outputs = await this.runSession(runtime, { [inputName]: inputTensor });
    } catch (error) {
      if (task.executionProvider !== "auto" || runtime.provider !== "directml") throw error;
      const fallbackReason = compactProviderError(error);
      runtime = await this.replaceAutoSessionWithCpu(projectId, model, task.deviceId, fallbackReason);
      outputs = await this.runSession(runtime, { [inputName]: inputTensor });
    }
    const detections = remapDetections(parseOutputs(outputs, model.manifest, task.threshold, task.iouThreshold), model.manifest, prepared.originalWidth, prepared.originalHeight);
    return {
      detections,
      imageWidth: prepared.originalWidth,
      imageHeight: prepared.originalHeight,
      inferenceMs: Math.round(performance.now() - started),
      executionProvider: runtime.provider,
      ...(runtime.fallbackReason ? { executionFallbackReason: runtime.fallbackReason } : {})
    };
  }

  modelPath(projectId: string, modelId: string): string {
    return path.join(this.dependencies.dataDir, "projects", projectId, "vision", "models", modelId, "model.onnx");
  }

  modelKey(projectId: string, modelId: string): string {
    return `projects/${projectId}/vision/models/${modelId}/model.onnx`;
  }

  private async session(projectId: string, model: VisionModelRecord, provider: VisionExecutionProvider, deviceId: number): Promise<VisionSessionRuntime> {
    const key = this.sessionKey(projectId, model.id, provider, deviceId);
    let session = this.sessions.get(key);
    if (!session) {
      session = this.createSessionRuntime(projectId, model.id, provider, deviceId);
      this.sessions.set(key, session);
    }
    return session;
  }

  private async createSessionRuntime(projectId: string, modelId: string, provider: VisionExecutionProvider, deviceId: number): Promise<VisionSessionRuntime> {
    const modelPath = this.modelPath(projectId, modelId);
    if (provider === "cpu") {
      const session = await ort.InferenceSession.create(modelPath, visionSessionOptions("cpu", deviceId));
      return { session, provider: "cpu", queue: Promise.resolve() };
    }
    try {
      const session = await ort.InferenceSession.create(modelPath, visionSessionOptions("directml", deviceId));
      return { session, provider: "directml", queue: Promise.resolve() };
    } catch (error) {
      if (provider === "directml") throw new Error(`DirectML GPU 初始化失败：${compactProviderError(error)}`);
      const fallbackReason = compactProviderError(error);
      const session = await ort.InferenceSession.create(modelPath, visionSessionOptions("cpu", deviceId));
      return { session, provider: "cpu", fallbackReason, queue: Promise.resolve() };
    }
  }

  private async replaceAutoSessionWithCpu(projectId: string, model: VisionModelRecord, deviceId: number, fallbackReason: string): Promise<VisionSessionRuntime> {
    const key = this.sessionKey(projectId, model.id, "auto", deviceId);
    const session = await ort.InferenceSession.create(this.modelPath(projectId, model.id), visionSessionOptions("cpu", deviceId));
    const runtime: VisionSessionRuntime = { session, provider: "cpu", fallbackReason, queue: Promise.resolve() };
    this.sessions.set(key, Promise.resolve(runtime));
    return runtime;
  }

  private async runSession(runtime: VisionSessionRuntime, feeds: ort.InferenceSession.OnnxValueMapType): Promise<ort.InferenceSession.OnnxValueMapType> {
    if (runtime.provider === "cpu") return runtime.session.run(feeds);
    const run = runtime.queue.then(() => runtime.session.run(feeds));
    runtime.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private sessionKey(projectId: string, modelId: string, provider: VisionExecutionProvider, deviceId: number): string {
    return `${projectId}:${modelId}:${provider}:${deviceId}`;
  }

  private requireTask(projectId: string, taskId: string): VisionTaskRecord {
    const task = this.dependencies.store.getVisionTask(projectId, taskId);
    if (!task) throw new Error("视觉识别任务不存在");
    return normalizeTask(task);
  }

  private async tick(): Promise<void> {
    for (const project of this.dependencies.store.listProjects()) {
      for (const storedTask of this.dependencies.store.listVisionTasks(project.id)) {
        const task = normalizeTask(storedTask);
        if (!task.enabled || task.mode !== "video" || this.runningTasks.has(task.id) || (this.nextRunAt.get(task.id) ?? 0) > Date.now()) continue;
        const source = this.dependencies.store.listVisionSources(project.id).find((item) => item.id === task.sourceId);
        if (!source?.sourceUrl) continue;
        this.runningTasks.add(task.id);
        this.nextRunAt.set(task.id, Date.now() + Math.max(250, 1000 / Math.max(0.2, task.inferenceFps)));
        void this.runVideoFrame(project.id, task, source).finally(() => this.runningTasks.delete(task.id));
      }
    }
  }

  private async runVideoFrame(projectId: string, task: VisionTaskRecord, source: VisionSourceRecord): Promise<void> {
    try {
      const buffer = await captureFrame(source.sourceUrl);
      const result = await this.infer(projectId, task, buffer);
      const inferenceAt = Date.now();
      const previousInferenceAt = this.lastInferenceAt.get(task.id);
      this.lastInferenceAt.set(task.id, inferenceAt);
      const actualInferenceFps = roundMetric(previousInferenceAt ? 1000 / Math.max(1, inferenceAt - previousInferenceAt) : 1000 / Math.max(1, result.inferenceMs));
      if (source.status !== "online") await this.dependencies.store.saveVisionSource(projectId, { ...source, status: "online", updatedAt: new Date().toISOString() });
      const alertDetections = task.alertLabels?.length ? result.detections.filter((item) => task.alertLabels?.includes(item.label)) : result.detections;
      const shouldAlert = alertDetections.length > 0 && Date.now() - (this.lastEventAt.get(task.id) ?? 0) >= task.cooldownMs;
      if (shouldAlert) {
        this.lastEventAt.set(task.id, Date.now());
        await this.saveEvent(projectId, task, buffer, `${source.name}.jpg`, { ...result, detections: alertDetections }, source.id);
      }
      if (task.status !== "running" || !task.lastRunAt || Date.now() - Date.parse(task.lastRunAt) > 3_000) {
        const now = new Date().toISOString();
        const taskWithoutFallback = { ...task };
        delete taskWithoutFallback.executionFallbackReason;
        await this.dependencies.store.saveVisionTask(projectId, {
          ...taskWithoutFallback,
          status: "running",
          activeExecutionProvider: result.executionProvider,
          ...(result.executionFallbackReason ? { executionFallbackReason: result.executionFallbackReason } : {}),
          lastInferenceMs: result.inferenceMs,
          actualInferenceFps,
          message: `${runtimeMessage(result)} · ${result.detections.length} 个结果`,
          lastRunAt: now,
          updatedAt: now
        });
      }
    } catch (error) {
      if (source.status !== "offline") await this.dependencies.store.saveVisionSource(projectId, { ...source, status: "offline", updatedAt: new Date().toISOString() });
      await this.dependencies.store.saveVisionTask(projectId, { ...task, status: "error", message: error instanceof Error ? error.message : String(error), lastRunAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    }
  }

  private async saveEvent(projectId: string, task: VisionTaskRecord, buffer: Buffer, originalName: string, result: InferenceResult, sourceId?: string): Promise<VisionEventRecord> {
    const id = randomUUID();
    const extension = imageExtension(originalName);
    const fileName = `source${extension}`;
    const directory = path.join(this.dependencies.dataDir, "projects", projectId, "vision", "events", id);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, fileName);
    await writeFile(filePath, buffer);
    const objectKey = `projects/${projectId}/vision/events/${id}/${fileName}`;
    await this.dependencies.objects.putFile(objectKey, filePath);
    const now = new Date().toISOString();
    const ng = result.detections.some((item) => /(^|[_-])(ng|defect|fail|no[_-]|smoke|fire)/i.test(item.label));
    const event: VisionEventRecord = {
      id, projectId, taskId: task.id, sourceType: task.mode, ...(sourceId ? { sourceId } : {}), modelId: task.modelId,
      result: task.mode === "image" ? (ng ? "ng" : "ok") : "detected",
      detections: result.detections, imageUrl: `/assets/${objectKey}`,
      ...(task.binding.sceneId ? { sceneId: task.binding.sceneId } : {}), objectIds: task.binding.objectIds,
      status: "pending", inferenceMs: result.inferenceMs, executionProvider: result.executionProvider,
      ...(result.executionFallbackReason ? { executionFallbackReason: result.executionFallbackReason } : {}),
      createdAt: now, updatedAt: now
    };
    return this.dependencies.store.saveVisionEvent(projectId, event);
  }
}

export async function registerVisionRoutes(app: FastifyInstance, engine: VisionEngine, dependencies: VisionDependencies): Promise<void> {
  const { store, objects, dataDir } = dependencies;
  app.get("/api/vision/presets", async () => engine.presets());
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/vision/sources", async (request) => store.listVisionSources(request.params.projectId));
  app.post<{ Params: { projectId: string }; Body: Partial<VisionSourceRecord> }>("/api/projects/:projectId/vision/sources", async (request, reply) => {
    const name = request.body.name?.trim();
    const sourceUrl = request.body.sourceUrl?.trim();
    if (!name || !sourceUrl || !request.body.kind) return reply.code(400).send({ message: "视觉源名称、类型和地址不能为空" });
    const now = new Date().toISOString();
    const source: VisionSourceRecord = { id: request.body.id || randomUUID(), projectId: request.params.projectId, name, kind: request.body.kind, sourceUrl, ...(request.body.assetId ? { assetId: request.body.assetId } : {}), ...(request.body.playbackUrl ? { playbackUrl: request.body.playbackUrl } : {}), status: request.body.status ?? "unknown", createdAt: request.body.createdAt ?? now, updatedAt: now };
    return reply.code(201).send(await store.saveVisionSource(request.params.projectId, source));
  });
  app.delete<{ Params: { projectId: string; sourceId: string } }>("/api/projects/:projectId/vision/sources/:sourceId", async (request, reply) => {
    if (!await store.removeVisionSource(request.params.projectId, request.params.sourceId)) return reply.code(404).send({ message: "视觉源不存在" });
    return reply.code(204).send();
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/vision/models", async (request) => store.listVisionModels(request.params.projectId));
  app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/vision/models", async (request, reply) => {
    const id = randomUUID();
    const directory = path.dirname(engine.modelPath(request.params.projectId, id));
    await mkdir(directory, { recursive: true });
    let manifest: VisionModelManifest | undefined;
    let size = 0;
    let receivedModel = false;
    for await (const part of request.parts()) {
      if (part.type === "field" && part.fieldname === "manifest") manifest = parseManifest(String(part.value));
      if (part.type === "file" && part.fieldname === "model") {
        if (!part.filename.toLowerCase().endsWith(".onnx")) return reply.code(415).send({ message: "模型文件必须是 .onnx" });
        await pipeline(part.file, createWriteStream(engine.modelPath(request.params.projectId, id)));
        size = part.file.bytesRead;
        receivedModel = true;
      }
    }
    if (!receivedModel || !manifest) { await rm(directory, { recursive: true, force: true }); return reply.code(400).send({ message: "必须同时提供ONNX模型和manifest.json" }); }
    const now = new Date().toISOString();
    let model: VisionModelRecord = { id, projectId: request.params.projectId, name: manifest.name, version: manifest.version, task: manifest.task, manifest, modelKey: engine.modelKey(request.params.projectId, id), size, status: "validating", message: "正在验证", createdAt: now, updatedAt: now };
    await objects.putFile(model.modelKey, engine.modelPath(request.params.projectId, id));
    model = await engine.validateModel(request.params.projectId, model);
    await store.saveVisionModel(request.params.projectId, model);
    return reply.code(model.status === "ready" ? 201 : 422).send(model);
  });
  app.post<{ Params: { projectId: string }; Body: { presetId?: string } }>("/api/projects/:projectId/vision/models/install-preset", async (request, reply) => {
    if (!request.body.presetId) return reply.code(400).send({ message: "请选择模型预设" });
    const model = await engine.installPreset(request.params.projectId, request.body.presetId);
    await store.saveVisionModel(request.params.projectId, model);
    return reply.code(model.status === "ready" ? 201 : 422).send(model);
  });
  app.delete<{ Params: { projectId: string; modelId: string } }>("/api/projects/:projectId/vision/models/:modelId", async (request, reply) => {
    if (!await store.removeVisionModel(request.params.projectId, request.params.modelId)) return reply.code(404).send({ message: "AI模型不存在" });
    await objects.removePrefix(`projects/${request.params.projectId}/vision/models/${request.params.modelId}`);
    await rm(path.join(dataDir, "projects", request.params.projectId, "vision", "models", request.params.modelId), { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/vision/tasks", async (request) => store.listVisionTasks(request.params.projectId).map(normalizeTask));
  app.post<{ Params: { projectId: string }; Body: Partial<VisionTaskRecord> }>("/api/projects/:projectId/vision/tasks", async (request, reply) => {
    if (!request.body.name?.trim() || !request.body.modelId || !request.body.mode) return reply.code(400).send({ message: "任务名称、模式和模型不能为空" });
    if (!store.getVisionModel(request.params.projectId, request.body.modelId)) return reply.code(404).send({ message: "AI模型不存在" });
    if (request.body.mode === "video" && !request.body.sourceId) return reply.code(400).send({ message: "实时视频任务必须选择视频源" });
    if (request.body.mode === "video" && !store.listVisionSources(request.params.projectId).some((item) => item.id === request.body.sourceId)) return reply.code(404).send({ message: "实时视频源不存在" });
    const now = new Date().toISOString();
    const task: VisionTaskRecord = normalizeTask({ ...request.body, id: request.body.id || randomUUID(), projectId: request.params.projectId, createdAt: request.body.createdAt ?? now, updatedAt: now } as VisionTaskRecord);
    return reply.code(201).send(await store.saveVisionTask(request.params.projectId, task));
  });
  app.patch<{ Params: { projectId: string; taskId: string }; Body: Partial<VisionTaskRecord> }>("/api/projects/:projectId/vision/tasks/:taskId", async (request, reply) => {
    const current = store.getVisionTask(request.params.projectId, request.params.taskId);
    if (!current) return reply.code(404).send({ message: "识别任务不存在" });
    return store.saveVisionTask(request.params.projectId, normalizeTask({ ...current, ...request.body, id: current.id, projectId: current.projectId, updatedAt: new Date().toISOString() }));
  });
  app.delete<{ Params: { projectId: string; taskId: string } }>("/api/projects/:projectId/vision/tasks/:taskId", async (request, reply) => {
    if (!await store.removeVisionTask(request.params.projectId, request.params.taskId)) return reply.code(404).send({ message: "识别任务不存在" });
    return reply.code(204).send();
  });
  app.post<{ Params: { projectId: string; taskId: string } }>("/api/projects/:projectId/vision/tasks/:taskId/infer-image", async (request, reply) => {
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请选择图片" });
    if (!/^image\//i.test(part.mimetype) && !/\.(jpe?g|png|webp|bmp|tiff?)$/i.test(part.filename)) return reply.code(415).send({ message: "支持JPG、PNG、WebP、BMP和TIFF" });
    const chunks: Buffer[] = [];
    for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
    return engine.runImage(request.params.projectId, request.params.taskId, Buffer.concat(chunks), part.filename);
  });

  app.get<{ Params: { projectId: string }; Querystring: { limit?: string } }>("/api/projects/:projectId/vision/events", async (request) => store.listVisionEvents(request.params.projectId, Number(request.query.limit ?? 200)));
  app.patch<{ Params: { projectId: string; eventId: string }; Body: Pick<Partial<VisionEventRecord>, "status" | "note"> }>("/api/projects/:projectId/vision/events/:eventId", async (request, reply) => {
    const current = store.getVisionEvent(request.params.projectId, request.params.eventId);
    if (!current) return reply.code(404).send({ message: "视觉事件不存在" });
    return store.saveVisionEvent(request.params.projectId, { ...current, ...(request.body.status ? { status: request.body.status } : {}), ...(request.body.note !== undefined ? { note: request.body.note } : {}), updatedAt: new Date().toISOString() });
  });
}

function validateManifest(manifest: VisionModelManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("仅支持视觉模型清单 schemaVersion=1");
  if (!manifest.name.trim() || !manifest.version.trim()) throw new Error("模型名称和版本不能为空");
  if (!Number.isFinite(manifest.input.width) || !Number.isFinite(manifest.input.height) || manifest.input.width < 16 || manifest.input.height < 16) throw new Error("模型输入尺寸无效");
  if (!manifest.labels.length) throw new Error("模型类别列表不能为空");
}

function parseManifest(value: string): VisionModelManifest {
  const parsed = JSON.parse(value) as VisionModelManifest;
  validateManifest(parsed);
  return parsed;
}

export function visionSessionOptions(provider: VisionActiveExecutionProvider, deviceId: number): ort.InferenceSession.SessionOptions {
  if (provider === "directml") {
    return {
      executionProviders: [{ name: "dml", deviceId: Math.max(0, Math.floor(deviceId)) }],
      executionMode: "sequential",
      enableMemPattern: false,
      graphOptimizationLevel: "all"
    };
  }
  return { executionProviders: ["cpu"], graphOptimizationLevel: "all" };
}

function compactProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 240) || "未知错误";
}

function runtimeMessage(result: InferenceResult): string {
  const provider = result.executionProvider === "directml" ? "GPU · DirectML" : result.executionFallbackReason ? "CPU · GPU已回退" : "CPU";
  return `${provider} · ${result.inferenceMs} ms`;
}

function roundMetric(value: number): number {
  return Math.round(Math.max(0, value) * 10) / 10;
}

function normalizeTask(task: VisionTaskRecord): VisionTaskRecord {
  return {
    ...task,
    enabled: task.enabled === true,
    inferenceFps: clamp(Number(task.inferenceFps || 2), 0.2, 30),
    threshold: clamp(Number(task.threshold ?? 0.6), 0, 1),
    iouThreshold: clamp(Number(task.iouThreshold ?? 0.45), 0.05, 0.95),
    executionProvider: task.executionProvider === "cpu" || task.executionProvider === "directml" ? task.executionProvider : "auto",
    deviceId: Math.max(0, Math.floor(Number(task.deviceId ?? 0))),
    durationMs: Math.max(0, Number(task.durationMs ?? 0)),
    cooldownMs: Math.max(0, Number(task.cooldownMs ?? 10_000)),
    alertLabels: (task.alertLabels ?? []).map((item) => item.trim()).filter(Boolean),
    binding: { objectIds: task.binding?.objectIds ?? [], actions: task.binding?.actions ?? ["highlight", "message"], ...(task.binding?.sceneId ? { sceneId: task.binding.sceneId } : {}), ...(task.binding?.cameraViewId ? { cameraViewId: task.binding.cameraViewId } : {}) },
    status: task.enabled ? (task.status === "error" ? "error" : "running") : "stopped",
    message: task.message || (task.enabled ? "等待识别" : "已停止")
  };
}

export async function prepareImage(buffer: Buffer, manifest: VisionModelManifest): Promise<{ data: Float32Array | Uint8Array; dims: number[]; originalWidth: number; originalHeight: number }> {
  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  const originalWidth = metadata.width ?? manifest.input.width;
  const originalHeight = metadata.height ?? manifest.input.height;
  const fit = manifest.input.resize === "letterbox" ? "contain" : manifest.input.resize === "center-crop" ? "cover" : "fill";
  const padding = manifest.input.padding ?? [0, 0, 0];
  let pipelineImage = sharp(buffer, { failOn: "error" }).resize(manifest.input.width, manifest.input.height, { fit, position: manifest.input.letterboxPosition === "top-left" ? "northwest" : "centre", background: { r: padding[0] ?? 0, g: padding[1] ?? padding[0] ?? 0, b: padding[2] ?? padding[0] ?? 0, alpha: 1 } });
  pipelineImage = manifest.input.channels === 1 ? pipelineImage.greyscale() : pipelineImage.removeAlpha().toColourspace("srgb");
  const raw = await pipelineImage.raw().toBuffer();
  const { width, height, channels } = { width: manifest.input.width, height: manifest.input.height, channels: manifest.input.channels };
  const data = manifest.input.dataType === "uint8" ? new Uint8Array(width * height * channels) : new Float32Array(width * height * channels);
  const mean = manifest.input.mean ?? Array(channels).fill(0);
  const std = manifest.input.std ?? Array(channels).fill(1);
  const channelIndex = (channel: number) => manifest.input.color === "BGR" && channels === 3 ? 2 - channel : channel;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) for (let c = 0; c < channels; c += 1) {
    const value = (raw[(y * width + x) * channels + channelIndex(c)] ?? 0) * manifest.input.scale;
    const normalized = manifest.input.dataType === "uint8" ? clamp(Math.round(value), 0, 255) : (value - (mean[c] ?? 0)) / (std[c] || 1);
    const index = manifest.input.layout === "NCHW" ? c * width * height + y * width + x : (y * width + x) * channels + c;
    data[index] = normalized;
  }
  return { data, dims: manifest.input.layout === "NCHW" ? [1, channels, height, width] : [1, height, width, channels], originalWidth, originalHeight };
}

export function parseOutputs(outputs: ort.InferenceSession.OnnxValueMapType, manifest: VisionModelManifest, threshold: number, iouThreshold: number): VisionDetection[] {
  const tensors = Object.entries(outputs).filter((entry): entry is [string, ort.Tensor] => entry[1] instanceof ort.Tensor);
  if (!tensors.length) return [];
  const firstTensor = tensors[0]?.[1];
  if (!firstTensor) return [];
  if (manifest.output.format === "classification-logits") {
    const values = toNumbers(firstTensor.data);
    const probabilities = softmax(values);
    return probabilities.map((confidence, classId) => ({ label: manifest.labels[classId] ?? `class-${classId}`, classId, confidence })).sort((a, b) => b.confidence - a.confidence).slice(0, 5);
  }
  if (manifest.output.format === "ssd") return parseSsd(tensors, manifest, threshold);
  if (manifest.output.format === "boxes-scores-labels") return parseBoxesScoresLabels(tensors, manifest, threshold);
  if (manifest.output.format === "yolo-nms") return parseYoloNms(firstTensor, manifest, threshold);
  if (manifest.output.format === "yolo") return nonMaximumSuppression(parseYolo(firstTensor, manifest, threshold), iouThreshold);
  return nonMaximumSuppression(parseYolox(firstTensor, manifest, threshold), iouThreshold);
}

function parseSsd(tensors: Array<[string, ort.Tensor]>, manifest: VisionModelManifest, threshold: number): VisionDetection[] {
  const byName = (pattern: RegExp) => tensors.find(([name]) => pattern.test(name))?.[1];
  const boxes = byName(/box/i) ?? tensors.find(([, tensor]) => tensor.dims.at(-1) === 4)?.[1];
  const scores = byName(/score/i) ?? tensors.find(([, tensor]) => tensor !== boxes && tensor.type.includes("float"))?.[1];
  const labels = byName(/class|label/i) ?? tensors.find(([, tensor]) => tensor.type.includes("int"))?.[1];
  if (!boxes || !scores || !labels) throw new Error(`SSD输出无法识别：${tensors.map(([name]) => name).join(", ")}`);
  const boxValues = toNumbers(boxes.data), scoreValues = toNumbers(scores.data), labelValues = toNumbers(labels.data);
  const detections: VisionDetection[] = [];
  for (let index = 0; index < Math.min(scoreValues.length, labelValues.length, Math.floor(boxValues.length / 4)); index += 1) {
    const confidence = scoreValues[index] ?? 0;
    if (confidence < threshold) continue;
    const classId = Math.max(0, Math.round(labelValues[index] ?? 0) - 1);
    const y1 = boxValues[index * 4] ?? 0, x1 = boxValues[index * 4 + 1] ?? 0, y2 = boxValues[index * 4 + 2] ?? 0, x2 = boxValues[index * 4 + 3] ?? 0;
    detections.push({ label: manifest.labels[classId] ?? `class-${classId}`, classId, confidence, bbox: [clamp(x1, 0, 1), clamp(y1, 0, 1), clamp(x2, 0, 1), clamp(y2, 0, 1)] });
  }
  return detections;
}

function parseBoxesScoresLabels(tensors: Array<[string, ort.Tensor]>, manifest: VisionModelManifest, threshold: number): VisionDetection[] {
  const boxes = tensors.find(([name, tensor]) => /box/i.test(name) || tensor.dims.at(-1) === 4)?.[1];
  const scores = tensors.find(([name]) => /score/i.test(name))?.[1];
  const labels = tensors.find(([name]) => /class|label/i.test(name))?.[1];
  if (!boxes || !scores || !labels) throw new Error("boxes-scores-labels输出缺少boxes、scores或labels");
  const boxValues = toNumbers(boxes.data), scoreValues = toNumbers(scores.data), labelValues = toNumbers(labels.data);
  return scoreValues.flatMap((confidence, index) => {
    if (confidence < threshold || index * 4 + 3 >= boxValues.length) return [];
    const classId = Math.round(labelValues[index] ?? 0);
    let x1 = boxValues[index * 4] ?? 0, y1 = boxValues[index * 4 + 1] ?? 0, x2 = boxValues[index * 4 + 2] ?? 0, y2 = boxValues[index * 4 + 3] ?? 0;
    if (manifest.output.coordinates !== "normalized") { x1 /= manifest.input.width; x2 /= manifest.input.width; y1 /= manifest.input.height; y2 /= manifest.input.height; }
    return [{ label: manifest.labels[classId] ?? `class-${classId}`, classId, confidence, bbox: [clamp(x1, 0, 1), clamp(y1, 0, 1), clamp(x2, 0, 1), clamp(y2, 0, 1)] as [number, number, number, number] }];
  });
}

function parseYolox(tensor: ort.Tensor, manifest: VisionModelManifest, threshold: number): VisionDetection[] {
  const values = toNumbers(tensor.data);
  const stride = manifest.labels.length + 5;
  const rows = Math.floor(values.length / stride);
  const grid = yoloxGrid(manifest.input.width, manifest.input.height, rows);
  const detections: VisionDetection[] = [];
  for (let row = 0; row < rows; row += 1) {
    const offset = row * stride;
    const objectness = values[offset + 4] ?? 0;
    let classId = 0, classScore = 0;
    for (let index = 0; index < manifest.labels.length; index += 1) {
      const score = values[offset + 5 + index] ?? 0;
      if (score > classScore) { classScore = score; classId = index; }
    }
    const confidence = objectness * classScore;
    if (confidence < threshold) continue;
    const cell = grid[row];
    if (!cell) continue;
    const cx = ((values[offset] ?? 0) + cell.x) * cell.stride;
    const cy = ((values[offset + 1] ?? 0) + cell.y) * cell.stride;
    const width = Math.exp(values[offset + 2] ?? 0) * cell.stride;
    const height = Math.exp(values[offset + 3] ?? 0) * cell.stride;
    const scaleX = manifest.output.coordinates === "normalized" ? 1 : manifest.input.width;
    const scaleY = manifest.output.coordinates === "normalized" ? 1 : manifest.input.height;
    detections.push({ label: manifest.labels[classId] ?? `class-${classId}`, classId, confidence, bbox: [clamp((cx - width / 2) / scaleX, 0, 1), clamp((cy - height / 2) / scaleY, 0, 1), clamp((cx + width / 2) / scaleX, 0, 1), clamp((cy + height / 2) / scaleY, 0, 1)] });
  }
  return detections;
}

function yoloxGrid(width: number, height: number, rows: number): Array<{ x: number; y: number; stride: number }> {
  for (const strides of [[8, 16, 32], [8, 16, 32, 64]]) {
    const expected = strides.reduce((sum, stride) => sum + Math.floor(width / stride) * Math.floor(height / stride), 0);
    if (expected !== rows) continue;
    return strides.flatMap((stride) => Array.from({ length: Math.floor(height / stride) * Math.floor(width / stride) }, (_, index) => ({ x: index % Math.floor(width / stride), y: Math.floor(index / Math.floor(width / stride)), stride })));
  }
  throw new Error(`YOLOX输出数量与输入尺寸不匹配：${rows} predictions @ ${width}×${height}`);
}

function parseYolo(tensor: ort.Tensor, manifest: VisionModelManifest, threshold: number): VisionDetection[] {
  const values = toNumbers(tensor.data);
  const dimensions = tensor.dims.map(Number);
  const optionWithoutObjectness = manifest.labels.length + 4;
  const optionWithObjectness = manifest.labels.length + 5;
  const last = dimensions.at(-1) ?? 0;
  const previous = dimensions.at(-2) ?? 0;
  const featuresFirst = (previous === optionWithoutObjectness || previous === optionWithObjectness) && last !== previous;
  const featureCount = featuresFirst ? previous : last;
  const predictionCount = featuresFirst ? last : previous;
  if (![optionWithoutObjectness, optionWithObjectness].includes(featureCount) || predictionCount <= 0) throw new Error(`YOLO输出维度与类别不匹配：${dimensions.join("×")}，类别 ${manifest.labels.length}`);
  const valueAt = (prediction: number, feature: number) => featuresFirst ? (values[feature * predictionCount + prediction] ?? 0) : (values[prediction * featureCount + feature] ?? 0);
  const hasObjectness = featureCount === optionWithObjectness;
  const classOffset = hasObjectness ? 5 : 4;
  const detections: VisionDetection[] = [];
  for (let prediction = 0; prediction < predictionCount; prediction += 1) {
    const objectness = hasObjectness ? valueAt(prediction, 4) : 1;
    let classId = 0, classScore = 0;
    for (let index = 0; index < manifest.labels.length; index += 1) {
      const score = valueAt(prediction, classOffset + index);
      if (score > classScore) { classScore = score; classId = index; }
    }
    const confidence = objectness * classScore;
    if (confidence < threshold) continue;
    const cx = valueAt(prediction, 0), cy = valueAt(prediction, 1), width = valueAt(prediction, 2), height = valueAt(prediction, 3);
    const scaleX = manifest.output.coordinates === "normalized" ? 1 : manifest.input.width;
    const scaleY = manifest.output.coordinates === "normalized" ? 1 : manifest.input.height;
    detections.push({ label: manifest.labels[classId] ?? `class-${classId}`, classId, confidence, bbox: [clamp((cx - width / 2) / scaleX, 0, 1), clamp((cy - height / 2) / scaleY, 0, 1), clamp((cx + width / 2) / scaleX, 0, 1), clamp((cy + height / 2) / scaleY, 0, 1)] });
  }
  return detections;
}

function parseYoloNms(tensor: ort.Tensor, manifest: VisionModelManifest, threshold: number): VisionDetection[] {
  const values = toNumbers(tensor.data);
  const columns = tensor.dims.at(-1) ? Number(tensor.dims.at(-1)) : 6;
  if (columns < 6) throw new Error(`YOLO NMS输出至少需要6列，实际为 ${columns}`);
  const detections: VisionDetection[] = [];
  for (let row = 0; row < Math.floor(values.length / columns); row += 1) {
    const offset = row * columns;
    const confidence = values[offset + 4] ?? 0;
    if (confidence < threshold) continue;
    const classId = Math.round(values[offset + 5] ?? 0);
    let x1 = values[offset] ?? 0, y1 = values[offset + 1] ?? 0, x2 = values[offset + 2] ?? 0, y2 = values[offset + 3] ?? 0;
    if (manifest.output.coordinates !== "normalized") { x1 /= manifest.input.width; x2 /= manifest.input.width; y1 /= manifest.input.height; y2 /= manifest.input.height; }
    detections.push({ label: manifest.labels[classId] ?? `class-${classId}`, classId, confidence, bbox: [clamp(x1, 0, 1), clamp(y1, 0, 1), clamp(x2, 0, 1), clamp(y2, 0, 1)] });
  }
  return detections;
}

function nonMaximumSuppression(items: VisionDetection[], threshold: number): VisionDetection[] {
  const output: VisionDetection[] = [];
  for (const item of [...items].sort((a, b) => b.confidence - a.confidence)) {
    if (!item.bbox || output.every((kept) => !kept.bbox || kept.classId !== item.classId || intersectionOverUnion(item.bbox!, kept.bbox) < threshold)) output.push(item);
  }
  return output;
}

function remapDetections(items: VisionDetection[], manifest: VisionModelManifest, originalWidth: number, originalHeight: number): VisionDetection[] {
  if (manifest.input.resize === "stretch" || originalWidth <= 0 || originalHeight <= 0) return items;
  const inputWidth = manifest.input.width, inputHeight = manifest.input.height;
  const contain = manifest.input.resize === "letterbox";
  const scale = contain ? Math.min(inputWidth / originalWidth, inputHeight / originalHeight) : Math.max(inputWidth / originalWidth, inputHeight / originalHeight);
  const topLeft = contain && manifest.input.letterboxPosition === "top-left";
  const offsetX = topLeft ? 0 : (inputWidth - originalWidth * scale) / 2;
  const offsetY = topLeft ? 0 : (inputHeight - originalHeight * scale) / 2;
  const mapX = (value: number) => clamp((value * inputWidth - offsetX) / scale / originalWidth, 0, 1);
  const mapY = (value: number) => clamp((value * inputHeight - offsetY) / scale / originalHeight, 0, 1);
  return items.map((item) => item.bbox ? { ...item, bbox: [mapX(item.bbox[0]), mapY(item.bbox[1]), mapX(item.bbox[2]), mapY(item.bbox[3])] } : item);
}

function intersectionOverUnion(a: [number, number, number, number], b: [number, number, number, number]): number {
  const width = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const height = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const intersection = width * height;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  return intersection / Math.max(1e-9, areaA + areaB - intersection);
}

function softmax(values: number[]): number[] {
  const max = Math.max(...values);
  const exponential = values.map((value) => Math.exp(value - max));
  const total = exponential.reduce((sum, value) => sum + value, 0) || 1;
  return exponential.map((value) => value / total);
}

function toNumbers(data: ort.Tensor["data"]): number[] { return Array.from(data as ArrayLike<number>, Number); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function imageExtension(name: string): string { const extension = path.extname(name).toLowerCase(); return [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"].includes(extension) ? extension : ".jpg"; }

export function extractOnnxPayload(payload: Buffer): Buffer {
  if (payload[0] !== 0x1f || payload[1] !== 0x8b) return payload;
  const archive = gunzipSync(payload);
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error(`模型压缩包条目无效：${name || "unknown"}`);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > archive.length) throw new Error(`模型压缩包内容不完整：${name || "unknown"}`);
    if (name.toLowerCase().endsWith(".onnx")) return Buffer.from(archive.subarray(contentStart, contentEnd));
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new Error("模型压缩包中没有找到 ONNX 文件");
}

function captureFrame(sourceUrl: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = [...(/^rtsps?:/i.test(sourceUrl) ? ["-rtsp_transport", "tcp"] : []), "-i", sourceUrl, "-frames:v", "1", "-an", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"];
    const child = spawn(process.env.FFMPEG_PATH ?? "ffmpeg", args, { windowsHide: true, shell: false });
    const chunks: Buffer[] = [];
    let stderr = "";
    const timeout = setTimeout(() => { child.kill(); reject(new Error("读取实时视频帧超时")); }, 12_000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr += chunk.toString());
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      const buffer = Buffer.concat(chunks);
      if (code === 0 && buffer.length > 0) resolve(buffer);
      else reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || `FFmpeg读取失败：${String(code)}`));
    });
  });
}
