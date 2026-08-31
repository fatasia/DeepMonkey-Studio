import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import * as ort from "onnxruntime-node";
import type {
  VisionDetection,
  VisionEvidenceFrame,
  VisionActiveExecutionProvider,
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
import { PRESETS } from "./visionPresets.js";
import { captureFrame, extractOnnxPayload, parseOutputs, prepareImage, remapDetections } from "./visionRuntime.js";
export { captureFrame, captureFrameArguments, extractOnnxPayload, parseOutputs, prepareImage, remapDetections } from "./visionRuntime.js";
import {
  cleanVisionFileName,
  inferVisionSourceProtocol,
  resolveVisionStream,
  validateVisionStreamUrl,
  visionSourceFilePath,
  visionUploadContentType,
} from "./visionSources.js";
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

export class VisionEngine {
  private readonly sessions = new Map<string, Promise<VisionSessionRuntime>>();
  private readonly runningTasks = new Set<string>();
  private readonly nextRunAt = new Map<string, number>();
  private readonly lastEventAt = new Map<string, number>();
  private readonly lastInferenceAt = new Map<string, number>();
  private readonly fileSeekSeconds = new Map<string, number>();
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

  presets(): VisionModelPreset[] {
    return structuredClone(PRESETS);
  }

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
    const installed = this.dependencies.store
      .listVisionModels(projectId)
      .find((model) => model.status === "ready" && model.manifest.sourceUrl === preset.manifest.sourceUrl && model.version === preset.manifest.version);
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
    const candidate: VisionModelRecord = {
      id,
      projectId,
      name: preset.name,
      version: preset.manifest.version,
      task: preset.manifest.task,
      manifest: structuredClone(preset.manifest),
      modelKey: this.modelKey(projectId, id),
      size: stats.size,
      status: "validating",
      message: "正在验证",
      createdAt: now,
      updatedAt: now,
    };
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
      updatedAt: now,
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
    const inputTensor =
      model.manifest.input.dataType === "uint8"
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
      ...(runtime.fallbackReason ? { executionFallbackReason: runtime.fallbackReason } : {}),
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
    runtime.queue = run.then(
      () => undefined,
      () => undefined,
    );
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
      const filePath = visionSourceFilePath(this.dependencies.dataDir, projectId, source);
      const frameInput = filePath ?? source.frameUrl ?? source.sourceUrl;
      const seekSeconds = filePath ? (this.fileSeekSeconds.get(task.id) ?? 0) : undefined;
      let buffer: Buffer;
      try {
        buffer = await captureFrame(frameInput, seekSeconds);
      } catch (error) {
        if (!filePath || !seekSeconds) throw error;
        // 文件到尾后从首帧继续，避免一个离线视频把任务永久置为错误。
        buffer = await captureFrame(frameInput, 0);
        this.fileSeekSeconds.set(task.id, 0);
      }
      if (filePath) this.fileSeekSeconds.set(task.id, (this.fileSeekSeconds.get(task.id) ?? 0) + 1 / Math.max(0.2, task.inferenceFps));
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
          updatedAt: now,
        });
      }
    } catch (error) {
      if (source.status !== "offline") await this.dependencies.store.saveVisionSource(projectId, { ...source, status: "offline", updatedAt: new Date().toISOString() });
      await this.dependencies.store.saveVisionTask(projectId, {
        ...task,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        lastRunAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
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
      id,
      projectId,
      taskId: task.id,
      sourceType: task.mode,
      ...(sourceId ? { sourceId } : {}),
      modelId: task.modelId,
      result: task.mode === "image" ? (ng ? "ng" : "ok") : "detected",
      detections: result.detections,
      imageUrl: `/assets/${objectKey}`,
      ...(task.binding.sceneId ? { sceneId: task.binding.sceneId } : {}),
      objectIds: task.binding.objectIds,
      status: "pending",
      inferenceMs: result.inferenceMs,
      executionProvider: result.executionProvider,
      ...(result.executionFallbackReason ? { executionFallbackReason: result.executionFallbackReason } : {}),
      createdAt: now,
      updatedAt: now,
    };
    return this.dependencies.store.saveVisionEvent(projectId, event);
  }
}

export async function registerVisionRoutes(app: FastifyInstance, engine: VisionEngine, dependencies: VisionDependencies): Promise<void> {
  const { store, objects, dataDir } = dependencies;
  app.get("/api/vision/presets", async () => engine.presets());
  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/vision/sources", async (request) => store.listVisionSources(request.params.projectId));
  app.post<{ Params: { projectId: string }; Body: Partial<VisionSourceRecord> }>("/api/projects/:projectId/vision/sources", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const name = request.body.name?.trim();
    const sourceUrl = request.body.sourceUrl?.trim();
    if (!name || !sourceUrl || request.body.kind !== "video") return reply.code(400).send({ message: "监控源名称、视频类型和地址不能为空" });
    let protocol: Exclude<VisionSourceProtocol, "upload">;
    try {
      protocol = request.body.protocol && request.body.protocol !== "upload" ? request.body.protocol : inferVisionSourceProtocol(sourceUrl);
      validateVisionStreamUrl(sourceUrl, protocol);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
    const playbackProtocol = request.body.playbackProtocol === "webrtc" ? "webrtc" : "hls";
    let resolved;
    try {
      resolved = await resolveVisionStream(sourceUrl, protocol, playbackProtocol, request.hostname || "127.0.0.1");
    } catch (error) {
      return reply.code(502).send({ message: error instanceof Error ? error.message : String(error) });
    }
    const now = new Date().toISOString();
    const source: VisionSourceRecord = {
      id: request.body.id || randomUUID(),
      projectId: request.params.projectId,
      name,
      kind: "video",
      protocol,
      sourceUrl,
      playbackUrl: resolved.playbackUrl,
      playbackProtocol: resolved.playbackProtocol,
      frameUrl: resolved.frameUrl,
      status: request.body.status ?? "unknown",
      createdAt: request.body.createdAt ?? now,
      updatedAt: now,
    };
    return reply.code(201).send(await store.saveVisionSource(request.params.projectId, source));
  });
  app.post<{ Params: { projectId: string }; Querystring: { name?: string } }>("/api/projects/:projectId/vision/sources/upload", async (request, reply) => {
    if (!store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const part = await request.file();
    if (!part) return reply.code(400).send({ message: "请选择图片或视频文件" });
    const media = visionUploadContentType(part.filename);
    if (!media) {
      part.file.resume();
      return reply.code(415).send({ message: "图片支持 JPG/PNG/WebP/BMP/TIFF；视频支持 MP4/WebM/OGV/MOV/MKV/AVI/M4V" });
    }
    const id = randomUUID();
    const fileName = cleanVisionFileName(part.filename);
    const directory = path.join(dataDir, "projects", request.params.projectId, "vision", "sources", id);
    const filePath = path.join(directory, fileName);
    await mkdir(directory, { recursive: true });
    await pipeline(part.file, createWriteStream(filePath, { flags: "wx" }));
    const objectKey = `projects/${request.params.projectId}/vision/sources/${id}/${fileName}`;
    await objects.putFile(objectKey, filePath);
    const now = new Date().toISOString();
    const source: VisionSourceRecord = {
      id,
      projectId: request.params.projectId,
      name: request.query.name?.trim().slice(0, 180) || fileName,
      kind: media.kind,
      protocol: "upload",
      sourceUrl: `/assets/${objectKey}`,
      assetId: id,
      playbackUrl: `/assets/${objectKey}`,
      playbackProtocol: "file",
      fileName,
      mimeType: media.mimeType,
      size: part.file.bytesRead,
      status: "online",
      createdAt: now,
      updatedAt: now,
    };
    return reply.code(201).send(await store.saveVisionSource(request.params.projectId, source));
  });
  app.delete<{ Params: { projectId: string; sourceId: string } }>("/api/projects/:projectId/vision/sources/:sourceId", async (request, reply) => {
    const source = store.listVisionSources(request.params.projectId).find((item) => item.id === request.params.sourceId);
    if (!source || !(await store.removeVisionSource(request.params.projectId, request.params.sourceId))) return reply.code(404).send({ message: "视觉源不存在" });
    if (source.protocol === "upload") {
      await objects.removePrefix(`projects/${request.params.projectId}/vision/sources/${source.id}`);
      await rm(path.join(dataDir, "projects", request.params.projectId, "vision", "sources", source.id), { recursive: true, force: true });
    }
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
    if (!receivedModel || !manifest) {
      await rm(directory, { recursive: true, force: true });
      return reply.code(400).send({ message: "必须同时提供ONNX模型和manifest.json" });
    }
    const now = new Date().toISOString();
    let model: VisionModelRecord = {
      id,
      projectId: request.params.projectId,
      name: manifest.name,
      version: manifest.version,
      task: manifest.task,
      manifest,
      modelKey: engine.modelKey(request.params.projectId, id),
      size,
      status: "validating",
      message: "正在验证",
      createdAt: now,
      updatedAt: now,
    };
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
    if (!(await store.removeVisionModel(request.params.projectId, request.params.modelId))) return reply.code(404).send({ message: "AI模型不存在" });
    await objects.removePrefix(`projects/${request.params.projectId}/vision/models/${request.params.modelId}`);
    await rm(path.join(dataDir, "projects", request.params.projectId, "vision", "models", request.params.modelId), { recursive: true, force: true });
    return reply.code(204).send();
  });

  app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/vision/tasks", async (request) => store.listVisionTasks(request.params.projectId).map(normalizeTask));
  app.post<{ Params: { projectId: string }; Body: Partial<VisionTaskRecord> }>("/api/projects/:projectId/vision/tasks", async (request, reply) => {
    if (!request.body.name?.trim() || !request.body.modelId || !request.body.mode) return reply.code(400).send({ message: "任务名称、模式和模型不能为空" });
    if (!store.getVisionModel(request.params.projectId, request.body.modelId)) return reply.code(404).send({ message: "AI模型不存在" });
    if (request.body.mode === "video" && !request.body.sourceId) return reply.code(400).send({ message: "实时视频任务必须选择视频源" });
    if (request.body.mode === "video" && !store.listVisionSources(request.params.projectId).some((item) => item.id === request.body.sourceId && item.kind === "video"))
      return reply.code(404).send({ message: "实时视频源不存在" });
    const now = new Date().toISOString();
    const task: VisionTaskRecord = normalizeTask({
      ...request.body,
      id: request.body.id || randomUUID(),
      projectId: request.params.projectId,
      createdAt: request.body.createdAt ?? now,
      updatedAt: now,
    } as VisionTaskRecord);
    return reply.code(201).send(await store.saveVisionTask(request.params.projectId, task));
  });
  app.patch<{ Params: { projectId: string; taskId: string }; Body: Partial<VisionTaskRecord> }>("/api/projects/:projectId/vision/tasks/:taskId", async (request, reply) => {
    const current = store.getVisionTask(request.params.projectId, request.params.taskId);
    if (!current) return reply.code(404).send({ message: "识别任务不存在" });
    return store.saveVisionTask(
      request.params.projectId,
      normalizeTask({ ...current, ...request.body, id: current.id, projectId: current.projectId, updatedAt: new Date().toISOString() }),
    );
  });
  app.delete<{ Params: { projectId: string; taskId: string } }>("/api/projects/:projectId/vision/tasks/:taskId", async (request, reply) => {
    if (!(await store.removeVisionTask(request.params.projectId, request.params.taskId))) return reply.code(404).send({ message: "识别任务不存在" });
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

  app.get<{ Params: { projectId: string }; Querystring: { limit?: string } }>("/api/projects/:projectId/vision/events", async (request) =>
    store.listVisionEvents(request.params.projectId, Number(request.query.limit ?? 200)),
  );
  app.patch<{ Params: { projectId: string; eventId: string }; Body: Pick<Partial<VisionEventRecord>, "status" | "note"> }>(
    "/api/projects/:projectId/vision/events/:eventId",
    async (request, reply) => {
      const current = store.getVisionEvent(request.params.projectId, request.params.eventId);
      if (!current) return reply.code(404).send({ message: "视觉事件不存在" });
      return store.saveVisionEvent(request.params.projectId, {
        ...current,
        ...(request.body.status ? { status: request.body.status } : {}),
        ...(request.body.note !== undefined ? { note: request.body.note } : {}),
        updatedAt: new Date().toISOString(),
      });
    },
  );
}

function validateManifest(manifest: VisionModelManifest): void {
  if (manifest.schemaVersion !== 1) throw new Error("仅支持视觉模型清单 schemaVersion=1");
  if (!manifest.name.trim() || !manifest.version.trim()) throw new Error("模型名称和版本不能为空");
  if (!Number.isFinite(manifest.input.width) || !Number.isFinite(manifest.input.height) || manifest.input.width < 16 || manifest.input.height < 16)
    throw new Error("模型输入尺寸无效");
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
      graphOptimizationLevel: "all",
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
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
    binding: {
      objectIds: task.binding?.objectIds ?? [],
      actions: task.binding?.actions ?? ["highlight", "message"],
      ...(task.binding?.sceneId ? { sceneId: task.binding.sceneId } : {}),
      ...(task.binding?.cameraViewId ? { cameraViewId: task.binding.cameraViewId } : {}),
    },
    status: task.enabled ? (task.status === "error" ? "error" : "running") : "stopped",
    message: task.message || (task.enabled ? "等待识别" : "已停止"),
  };
}

function imageExtension(name: string): string {
  const extension = path.extname(name).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"].includes(extension) ? extension : ".jpg";
}
