import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  assertPathSafeResourceId,
  type ConversionArtifact,
  type ConversionTaskRecord,
  type ConversionTaskStatus,
  type ConverterProviderProbe,
  type ConverterPluginDescriptor,
  type ConverterPluginManifest,
  type SubmitConversionTaskRequest
} from "@bim-studio/contracts";

const terminalStatuses = new Set<ConversionTaskStatus>(["cancelled", "succeeded", "failed"]);

const allowedTransitions: Record<ConversionTaskStatus, ReadonlySet<ConversionTaskStatus>> = {
  queued: new Set(["waiting_converter", "running", "cancelled", "failed"]),
  waiting_converter: new Set(["queued", "cancelled"]),
  running: new Set(["cancelling", "succeeded", "failed"]),
  cancelling: new Set(["cancelled", "failed"]),
  cancelled: new Set(),
  succeeded: new Set(),
  failed: new Set()
};

export interface ConverterExecutionContext {
  task: Readonly<ConversionTaskRecord>;
  signal: AbortSignal;
  outputPrefix: string;
  reportProgress(progress: number, message: string): void;
  publishArtifact(artifact: ConversionArtifact): void;
}

export interface ConverterPluginRegistration {
  manifest: ConverterPluginManifest;
  unavailableReason?: string;
  provider?: ConverterProviderProbe;
  execute?: (context: ConverterExecutionContext) => Promise<void>;
}

export class ConversionTaskError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_request" | "not_found" | "conflict"
  ) {
    super(message);
  }
}

export function assertConversionTaskTransition(from: ConversionTaskStatus, to: ConversionTaskStatus): void {
  if (!allowedTransitions[from].has(to)) throw new ConversionTaskError(`转换任务不能从 ${from} 变为 ${to}`, "conflict");
}

export class ConversionTaskService {
  private readonly plugins = new Map<string, ConverterPluginRegistration>();
  private readonly tasks = new Map<string, ConversionTaskRecord>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    registrations: ConverterPluginRegistration[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID
  ) {
    for (const registration of registrations) this.register(registration);
  }

  register(registration: ConverterPluginRegistration): void {
    validateManifest(registration.manifest);
    if (this.plugins.has(registration.manifest.id)) throw new ConversionTaskError(`转换器 ${registration.manifest.id} 已注册`, "conflict");
    this.plugins.set(registration.manifest.id, registration);
  }

  listPlugins(): ConverterPluginDescriptor[] {
    return [...this.plugins.values()].map(({ manifest, execute, unavailableReason, provider }) => ({
      manifest: clone(manifest),
      available: Boolean(execute),
      ...(!execute ? { unavailableReason: unavailableReason ?? "转换器执行程序未安装" } : {}),
      ...(provider ? { provider: clone(provider) } : {})
    }));
  }

  submit(request: SubmitConversionTaskRequest): ConversionTaskRecord {
    validateSubmitRequest(request);
    const registration = this.plugins.get(request.pluginId);
    if (!registration) throw new ConversionTaskError(`转换器 ${request.pluginId} 不存在`, "not_found");
    if (!registration.manifest.inputFormats.includes(normalizeFormat(request.input.format))) {
      throw new ConversionTaskError(`转换器 ${request.pluginId} 不支持 ${request.input.format}`, "invalid_request");
    }
    if (request.input.size > registration.manifest.limits.maxInputBytes) {
      throw new ConversionTaskError(`输入文件超过转换器 ${registration.manifest.limits.maxInputBytes} 字节限制`, "invalid_request");
    }

    const timestamp = this.now().toISOString();
    const waiting = !registration.execute;
    const task: ConversionTaskRecord = {
      id: this.createId(),
      projectId: request.projectId,
      pluginId: registration.manifest.id,
      pluginVersion: registration.manifest.version,
      input: { ...clone(request.input), format: normalizeFormat(request.input.format) },
      configuration: clone(request.configuration ?? {}),
      status: waiting ? "waiting_converter" : "queued",
      progress: 0,
      message: waiting ? registration.unavailableReason ?? "等待转换器执行程序" : "等待转换",
      artifacts: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.tasks.set(task.id, task);
    if (registration.execute) queueMicrotask(() => void this.run(task.id, registration));
    return clone(task);
  }

  get(projectId: string, taskId: string): ConversionTaskRecord | undefined {
    const task = this.tasks.get(taskId);
    return task?.projectId === projectId ? clone(task) : undefined;
  }

  list(projectId: string): ConversionTaskRecord[] {
    return [...this.tasks.values()].filter((task) => task.projectId === projectId).map(clone);
  }

  cancel(projectId: string, taskId: string): ConversionTaskRecord {
    const task = this.tasks.get(taskId);
    if (!task || task.projectId !== projectId) throw new ConversionTaskError("转换任务不存在", "not_found");
    if (terminalStatuses.has(task.status)) return clone(task);
    if (task.status === "running") {
      this.transition(task, "cancelling", "正在取消");
      this.abortControllers.get(task.id)?.abort();
    } else if (task.status === "cancelling") {
      this.abortControllers.get(task.id)?.abort();
    } else {
      this.transition(task, "cancelled", "已取消");
    }
    return clone(task);
  }

  private async run(taskId: string, registration: ConverterPluginRegistration): Promise<void> {
    const task = this.tasks.get(taskId);
    const execute = registration.execute;
    if (!task || task.status !== "queued" || !execute) return;
    const controller = new AbortController();
    this.abortControllers.set(task.id, controller);
    this.transition(task, "running", "正在转换", { startedAt: this.now().toISOString() });
    try {
      await execute({
        task: clone(task),
        signal: controller.signal,
        outputPrefix: outputPrefix(task),
        reportProgress: (progress, message) => this.reportProgress(task, progress, message),
        publishArtifact: (artifact) => this.publishArtifact(task, registration.manifest, artifact)
      });
      if (this.statusOf(task.id) === "cancelling") this.transition(task, "cancelled", "已取消");
      else {
        assertRequiredArtifacts(task, registration.manifest);
        this.transition(task, "succeeded", "转换完成", { progress: 100 });
      }
    } catch (error) {
      if (this.statusOf(task.id) === "cancelling" || controller.signal.aborted) this.transition(task, "cancelled", "已取消");
      else this.transition(task, "failed", error instanceof Error ? error.message : "转换失败");
    } finally {
      this.abortControllers.delete(task.id);
    }
  }

  private reportProgress(task: ConversionTaskRecord, progress: number, message: string): void {
    if (task.status !== "running") return;
    const normalized = Math.max(task.progress, Math.min(99, Math.round(progress)));
    Object.assign(task, { progress: normalized, message: message.slice(0, 500), updatedAt: this.now().toISOString() });
  }

  private publishArtifact(task: ConversionTaskRecord, manifest: ConverterPluginManifest, artifact: ConversionArtifact): void {
    if (task.status !== "running") throw new ConversionTaskError("任务不在运行中，不能发布产物", "conflict");
    const declaration = manifest.outputs.find((output) => output.kind === artifact.kind && output.format === artifact.format);
    if (!declaration) throw new ConversionTaskError(`转换器未声明 ${artifact.kind}/${artifact.format} 产物`, "invalid_request");
    if (!isKeyWithinPrefix(artifact.objectKey, outputPrefix(task))) throw new ConversionTaskError("转换产物必须写入任务输出目录", "invalid_request");
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) throw new ConversionTaskError("转换产物大小无效", "invalid_request");
    const currentBytes = task.artifacts.reduce((sum, item) => sum + item.size, 0);
    if (currentBytes + artifact.size > manifest.limits.maxOutputBytes) throw new ConversionTaskError("转换产物超过大小限制", "invalid_request");
    if (!declaration.multiple && task.artifacts.some((item) => item.kind === artifact.kind && item.format === artifact.format)) {
      throw new ConversionTaskError(`转换器重复发布 ${artifact.kind}/${artifact.format} 产物`, "conflict");
    }
    task.artifacts.push(clone(artifact));
    task.updatedAt = this.now().toISOString();
  }

  private transition(task: ConversionTaskRecord, status: ConversionTaskStatus, message: string, patch: Partial<ConversionTaskRecord> = {}): void {
    assertConversionTaskTransition(task.status, status);
    const timestamp = this.now().toISOString();
    Object.assign(task, patch, { status, message, updatedAt: timestamp });
    if (terminalStatuses.has(status)) task.finishedAt = timestamp;
  }

  private statusOf(taskId: string): ConversionTaskStatus | undefined {
    return this.tasks.get(taskId)?.status;
  }
}

function validateManifest(manifest: ConverterPluginManifest): void {
  if (manifest.contractVersion !== 1) throw new ConversionTaskError("不支持的转换器合同版本", "invalid_request");
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(manifest.id)) throw new ConversionTaskError("转换器 ID 无效", "invalid_request");
  if (!manifest.version.trim() || manifest.inputFormats.length === 0 || manifest.outputs.length === 0) throw new ConversionTaskError("转换器清单不完整", "invalid_request");
  if (manifest.inputFormats.some((format) => format !== normalizeFormat(format))) throw new ConversionTaskError("转换器输入格式必须为小写扩展名", "invalid_request");
  for (const value of Object.values(manifest.limits)) {
    if (!Number.isFinite(value) || value <= 0) throw new ConversionTaskError("转换器资源限制必须大于零", "invalid_request");
  }
}

function validateSubmitRequest(request: SubmitConversionTaskRequest): void {
  try {
    assertPathSafeResourceId(request.projectId, "projectId");
  } catch (error) {
    throw new ConversionTaskError(error instanceof Error ? error.message : "projectId 无效", "invalid_request");
  }
  if (!request.pluginId?.trim()) throw new ConversionTaskError("pluginId 不能为空", "invalid_request");
  if (!request.input || path.basename(request.input.fileName) !== request.input.fileName || !request.input.fileName.trim()) {
    throw new ConversionTaskError("输入文件名无效", "invalid_request");
  }
  if (!isKeyWithinPrefix(request.input.objectKey, `projects/${request.projectId}/`)) throw new ConversionTaskError("输入对象必须位于当前项目", "invalid_request");
  if (!/^[a-z0-9][a-z0-9._+-]{0,31}$/.test(normalizeFormat(request.input.format))) throw new ConversionTaskError("输入格式无效", "invalid_request");
  if (!Number.isSafeInteger(request.input.size) || request.input.size < 0) throw new ConversionTaskError("输入文件大小无效", "invalid_request");
  if (request.input.sha256 && !/^[a-f0-9]{64}$/i.test(request.input.sha256)) throw new ConversionTaskError("输入 SHA-256 无效", "invalid_request");
  if (request.configuration && (!isPlainObject(request.configuration) || JSON.stringify(request.configuration).length > 64_000)) {
    throw new ConversionTaskError("转换配置无效或过大", "invalid_request");
  }
}

function assertRequiredArtifacts(task: ConversionTaskRecord, manifest: ConverterPluginManifest): void {
  for (const output of manifest.outputs) {
    if (output.required && !task.artifacts.some((artifact) => artifact.kind === output.kind && artifact.format === output.format)) {
      throw new ConversionTaskError(`转换器未生成必需产物 ${output.kind}/${output.format}`, "conflict");
    }
  }
}

function outputPrefix(task: ConversionTaskRecord): string {
  return `projects/${task.projectId}/conversions/${task.id}/output/`;
}

function isKeyWithinPrefix(key: string, prefix: string): boolean {
  const normalized = key.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !normalized.split("/").includes("..") && normalized.startsWith(prefix);
}

function normalizeFormat(format: string): string {
  return format.trim().replace(/^\./, "").toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
