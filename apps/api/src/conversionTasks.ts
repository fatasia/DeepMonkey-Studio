import { randomUUID } from "node:crypto";
import { withConversionDeadline } from "./conversionExecutionDeadline.js";
import { sameConversionRequest } from "./conversionTaskIdempotency.js";
import { ConversionTaskError } from "./conversionTaskError.js";
import { isKeyWithinPrefix, normalizeFormat, validateManifest, validateSubmitRequest } from "./conversionTaskValidation.js";
export { ConversionTaskError } from "./conversionTaskError.js";
import {
  assertPathSafeResourceId,
  assertSourceBundleRecord,
  assertConversionQualityReport,
  type ConversionQualityReport,
  type SourceBundleRecord,
  type ConversionArtifact,
  type ConversionTaskRecord,
  type ConversionTaskStatus,
  type ConverterProviderProbe,
  type ConverterPluginDescriptor,
  type ConverterPluginManifest,
  type SubmitConversionTaskRequest
} from "@bim-studio/contracts";
import type { ModelRecord } from "@bim-studio/contracts";
import { ConversionLeaseSessions, type ConversionPersistence } from "./conversionLeaseSession.js";

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
  registerResourceExit?(exit: Promise<void>): void;
  outputPrefix: string;
  reportProgress(progress: number, message: string): void;
  publishArtifact(artifact: ConversionArtifact): void;
  stageModelUpdate(updates: Partial<ModelRecord>): void;
  reportSourceBundle(source: SourceBundleRecord): void;
  reportQuality(quality: ConversionQualityReport): void;
}

export interface ConverterPluginRegistration {
  manifest: ConverterPluginManifest;
  unavailableReason?: string;
  provider?: ConverterProviderProbe;
  execute?: (context: ConverterExecutionContext) => Promise<void>;
}

export function assertConversionTaskTransition(from: ConversionTaskStatus, to: ConversionTaskStatus): void {
  if (!allowedTransitions[from].has(to)) throw new ConversionTaskError(`转换任务不能从 ${from} 变为 ${to}`, "conflict");
}

export class ConversionTaskService {
  private readonly plugins = new Map<string, ConverterPluginRegistration>();
  private readonly tasks = new Map<string, ConversionTaskRecord>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly finalizing = new Set<string>();
  private activeExecutions = 0;
  private readonly durableQueued = new Set<string>();
  private readonly submissions = new Map<string, Promise<void>>();
  private readonly leases: ConversionLeaseSessions;

  constructor(
    registrations: ConverterPluginRegistration[] = [],
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = randomUUID,
    private readonly persistence?: ConversionPersistence,
  ) {
    this.leases = new ConversionLeaseSessions(persistence, (taskId, error) => {
      const controller = this.abortControllers.get(taskId);
      if (controller) controller.abort(error);
      else {
        const task = this.tasks.get(taskId);
        if (task?.status === "queued") this.transition(task, "failed", error.message);
        this.durableQueued.delete(taskId);
        void this.leases.close(taskId);
      }
    }, async taskId => {
      const task = this.tasks.get(taskId);
      if (!task || terminalStatuses.has(task.status) || this.finalizing.has(taskId)) return;
      if (task.status === "cancelling") { this.abortControllers.get(taskId)?.abort(); return; }
      const cancelled = this.cancel(task.projectId, taskId);
      await this.save(cancelled);
      if (terminalStatuses.has(cancelled.status)) await this.leases.close(taskId);
    });
    for (const registration of registrations) this.register(registration);
  }

  async initialize(): Promise<void> {
    const records = this.persistence?.refreshConversionTasks ? await this.persistence.refreshConversionTasks() : this.persistence?.listConversionTasks() ?? [];
    for (const record of records) {
      const task = await this.recoverInterrupted(record);
      this.tasks.set(task.id, task);
    }
  }

  private async recoverInterrupted(record: ConversionTaskRecord): Promise<ConversionTaskRecord> {
    const task = clone(record);
    if (!["queued", "running", "cancelling"].includes(task.status) || await this.persistence?.activeConversionTaskLease?.(task.id)) return task;
    // 先接管过期租约再记录中断；不复用旧 attempt 的输出目录继续执行。
    await this.leases.claim(task.id);
    try {
      const cancelled = task.status === "cancelling" || this.leases.token(task.id)?.cancelRequested;
      Object.assign(task, { status: cancelled ? "cancelled" : "failed", artifacts: [],
        message: cancelled ? "服务重启后完成取消" : "服务重启或租约到期中断了转换，请重新提交以创建新 attempt",
        updatedAt: this.now().toISOString(), finishedAt: this.now().toISOString() });
      await this.save(task);
      return task;
    } finally { await this.leases.close(task.id); }
  }

  register(registration: ConverterPluginRegistration): void {
    validateManifest(registration.manifest);
    if (this.plugins.has(registration.manifest.id)) throw new ConversionTaskError(`转换器 ${registration.manifest.id} 已注册`, "conflict");
    this.plugins.set(registration.manifest.id, {
      ...registration,
      manifest: clone(registration.manifest),
      ...(registration.provider ? { provider: clone(registration.provider) } : {}),
    });
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
    if (this.persistence) throw new ConversionTaskError("持久化转换任务必须使用 submitDurable", "conflict");
    const replay = this.findReplay(request);
    if (replay) return clone(replay);
    return this.createTask(request, true);
  }

  async submitDurable(request: SubmitConversionTaskRequest): Promise<ConversionTaskRecord> {
    if (!this.persistence) return this.submit(request);
    if (this.persistence.refreshConversionTasks) await this.refresh();
    const replay = this.findReplay(request);
    if (replay) {
      await this.submissions.get(replay.id);
      return clone(replay);
    }
    const task = this.createTask(request, false);
    const submission = (async () => {
      if (task.status === "queued" && this.persistence?.acquireConversionTaskLease) await this.leases.claim(task.id);
      await this.save(task);
    })();
    this.submissions.set(task.id, submission);
    try { await submission; }
    catch (error) { this.tasks.delete(task.id); await this.leases.close(task.id); throw error; }
    finally { this.submissions.delete(task.id); }
    this.durableQueued.add(task.id);
    const registration = this.plugins.get(task.pluginId)!;
    if (registration.execute) queueMicrotask(() => void this.run(task.id, registration));
    return task;
  }

  private findReplay(request: SubmitConversionTaskRequest): ConversionTaskRecord | undefined {
    validateSubmitRequest(request);
    if (!request.idempotencyKey) return undefined;
    const previous = [...this.tasks.values()].find(task => task.projectId === request.projectId && task.idempotencyKey === request.idempotencyKey);
    if (previous && !sameConversionRequest(previous, request)) throw new ConversionTaskError("幂等键已用于不同转换请求", "conflict");
    return previous;
  }

  private createTask(request: SubmitConversionTaskRequest, schedule: boolean): ConversionTaskRecord {
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
      ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      ...(request.modelId ? { modelId: request.modelId } : {}),
      pluginId: registration.manifest.id,
      pluginVersion: registration.manifest.version,
      input: { ...clone(request.input), format: normalizeFormat(request.input.format),
        ...(request.input.sha256 ? { sha256: request.input.sha256.toLowerCase() } : {}) },
      configuration: clone(request.configuration ?? {}),
      status: waiting ? "waiting_converter" : "queued",
      progress: 0,
      message: waiting ? registration.unavailableReason ?? "等待转换器执行程序" : "等待转换",
      artifacts: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    try { assertPathSafeResourceId(task.id, "taskId"); }
    catch { throw new ConversionTaskError("转换任务 ID 无效", "invalid_request"); }
    if (this.tasks.has(task.id)) throw new ConversionTaskError("转换任务 ID 已存在", "conflict");
    this.tasks.set(task.id, task);
    if (schedule) this.durableQueued.add(task.id);
    if (schedule && registration.execute) queueMicrotask(() => void this.run(task.id, registration));
    return clone(task);
  }

  get(projectId: string, taskId: string): ConversionTaskRecord | undefined {
    if (this.submissions.has(taskId)) return undefined;
    const task = this.tasks.get(taskId);
    return task?.projectId === projectId ? clone(task) : undefined;
  }

  async refresh(): Promise<void> {
    if (!this.persistence?.refreshConversionTasks) return;
    for (const record of await this.persistence.refreshConversionTasks()) {
      if (!this.submissions.has(record.id) && !this.leases.owns(record.id)) this.tasks.set(record.id, await this.recoverInterrupted(record));
    }
  }

  list(projectId: string): ConversionTaskRecord[] {
    return [...this.tasks.values()].filter((task) => task.projectId === projectId && !this.submissions.has(task.id)).map(clone);
  }

  cancel(projectId: string, taskId: string): ConversionTaskRecord {
    const task = this.tasks.get(taskId);
    if (!task || task.projectId !== projectId || this.submissions.has(taskId)) throw new ConversionTaskError("转换任务不存在", "not_found");
    if (terminalStatuses.has(task.status)) return clone(task);
    if (task.status !== "waiting_converter" && !this.leases.owns(task.id)) throw new ConversionTaskError("转换任务由另一执行器持有，请向原执行器取消", "conflict");
    if (this.finalizing.has(task.id)) throw new ConversionTaskError("转换结果正在原子提交，请稍后查询结果", "conflict");
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

  async cancelDurable(projectId: string, taskId: string): Promise<ConversionTaskRecord> {
    await this.refresh();
    const remote = this.get(projectId, taskId);
    if (remote && !terminalStatuses.has(remote.status) && remote.status !== "waiting_converter" && !this.leases.owns(taskId)
      && this.persistence?.requestConversionCancellation) {
      if (!await this.persistence.requestConversionCancellation(taskId)) throw new ConversionTaskError("执行器租约已变化，请刷新后重试取消", "conflict");
      return { ...remote, status: "cancelling", message: "取消请求已送达执行器，等待资源退出" };
    }
    const task = this.cancel(projectId, taskId);
    await this.save(task);
    if (terminalStatuses.has(task.status)) await this.leases.close(task.id);
    return this.get(projectId, taskId)!;
  }

  private async run(taskId: string, registration: ConverterPluginRegistration): Promise<void> {
    const task = this.tasks.get(taskId);
    const execute = registration.execute;
    if (!task || task.status !== "queued" || !execute || this.activeExecutions >= 1 || !this.durableQueued.has(task.id)) return;
    this.durableQueued.delete(task.id);
    this.activeExecutions++;
    const controller = new AbortController();
    this.abortControllers.set(task.id, controller);
    this.transition(task, "running", "正在转换", { startedAt: this.now().toISOString() });
    const staged = clone(task);
    let modelUpdates: Partial<ModelRecord> | undefined;
    const resourceExits: Promise<void>[] = [];
    try {
      await this.save(clone(task));
      await withConversionDeadline(() => execute({
        task: clone(task),
        signal: controller.signal,
        registerResourceExit: exit => { resourceExits.push(exit); },
        outputPrefix: outputPrefix(task),
        reportProgress: (progress, message) => this.reportProgress(task, progress, message),
        publishArtifact: (artifact) => {
          if (task.status !== "running" || controller.signal.aborted) throw new ConversionTaskError("任务不在运行中，不能发布产物", "conflict");
          this.publishArtifact(staged, registration.manifest, artifact);
        },
        stageModelUpdate: (updates) => {
          if (task.status !== "running" || controller.signal.aborted) throw new ConversionTaskError("任务不在运行中", "conflict");
          if (!task.modelId) throw new ConversionTaskError("任务未关联模型", "invalid_request");
          modelUpdates = { ...modelUpdates, ...clone(updates) };
        },
        reportSourceBundle: source => {
          if (task.status !== "running" || controller.signal.aborted) throw new ConversionTaskError("任务不在运行中", "conflict");
          assertSourceBundleRecord(source);
          if (source.contentHash !== task.input.sha256 || source.sourceName !== task.input.fileName) throw new ConversionTaskError("来源身份与已核验输入不一致", "invalid_request");
          staged.sourceBundle = clone(source);
        },
        reportQuality: quality => {
          if (task.status !== "running" || controller.signal.aborted) throw new ConversionTaskError("任务不在运行中", "conflict");
          assertConversionQualityReport(quality);
          if (quality.sourceHash !== staged.sourceBundle?.contentHash) throw new ConversionTaskError("质量报告必须绑定执行器核验的 SourceBundle", "invalid_request");
          staged.quality = clone(quality);
        },
      }), controller, registration.manifest.limits.timeoutMs, async () => { await Promise.all(resourceExits); });
      await this.leases.checkCancellation(task.id);
      controller.signal.throwIfAborted();
      if (this.statusOf(task.id) === "cancelling") await this.finish(task, "cancelled", "已取消");
      else {
        assertRequiredArtifacts(staged, registration.manifest);
        if (modelUpdates?.status === "ready" && staged.quality && ["inspect", "preview"].includes(staged.quality.tier)) throw new ConversionTaskError("inspect/preview 产物不能激活 ready 模型", "conflict");
        await this.finish(task, "succeeded", "转换完成", { progress: 100, artifacts: staged.artifacts,
          ...(staged.sourceBundle ? { sourceBundle: staged.sourceBundle } : {}), ...(staged.quality ? { quality: staged.quality } : {}) }, modelUpdates);
      }
    } catch (error) {
      try { await this.leases.checkCancellation(task.id); } catch { /* 失去租约的终态仍由数据库 fencing 拒绝。 */ }
      const cancelled = this.statusOf(task.id) === "cancelling";
      try { await this.finish(task, cancelled ? "cancelled" : "failed", cancelled ? "已取消" : error instanceof Error ? error.message : "转换失败", {
        ...(staged.sourceBundle ? { sourceBundle: staged.sourceBundle } : {}),
        ...(staged.quality ? { quality: staged.quality } : {}),
      }); }
      catch (persistenceError) {
        this.transition(task, "failed", `转换状态持久化失败：${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`);
      }
    } finally {
      await this.leases.close(task.id);
      this.abortControllers.delete(task.id);
      this.activeExecutions--;
      const next = [...this.tasks.values()].find(item => item.status === "queued" && this.durableQueued.has(item.id));
      const nextRegistration = next && this.plugins.get(next.pluginId);
      if (next && nextRegistration?.execute) queueMicrotask(() => void this.run(next.id, nextRegistration));
    }
  }

  private async finish(task: ConversionTaskRecord, status: ConversionTaskStatus, message: string, patch: Partial<ConversionTaskRecord> = {}, modelUpdates?: Partial<ModelRecord>): Promise<void> {
    this.finalizing.add(task.id);
    try {
      const candidate = clone(task);
      this.transition(candidate, status, message, patch);
      await this.save(candidate, modelUpdates);
      Object.assign(task, candidate);
    } finally { this.finalizing.delete(task.id); }
  }

  private reportProgress(task: ConversionTaskRecord, progress: number, message: string): void {
    if (task.status !== "running" || this.finalizing.has(task.id)) return;
    if (!Number.isFinite(progress)) throw new ConversionTaskError("转换进度必须为有限数值", "invalid_request");
    const normalized = Math.max(task.progress, Math.min(99, Math.round(progress)));
    Object.assign(task, { progress: normalized, message: message.slice(0, 500), updatedAt: this.now().toISOString() });
  }

  private publishArtifact(task: ConversionTaskRecord, manifest: ConverterPluginManifest, artifact: ConversionArtifact): void {
    if (task.status !== "running") throw new ConversionTaskError("任务不在运行中，不能发布产物", "conflict");
    const declaration = manifest.outputs.find((output) => output.kind === artifact.kind && output.format === artifact.format);
    if (!declaration) throw new ConversionTaskError(`转换器未声明 ${artifact.kind}/${artifact.format} 产物`, "invalid_request");
    if (!isKeyWithinPrefix(artifact.objectKey, outputPrefix(task))) throw new ConversionTaskError("转换产物必须写入任务输出目录", "invalid_request");
    if (!Number.isSafeInteger(artifact.size) || artifact.size < 0) throw new ConversionTaskError("转换产物大小无效", "invalid_request");
    if (task.artifacts.some((item) => item.objectKey.replaceAll("\\", "/") === artifact.objectKey.replaceAll("\\", "/"))) {
      throw new ConversionTaskError("转换产物对象路径重复", "conflict");
    }
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

  private save(task: ConversionTaskRecord, updates?: Partial<ModelRecord>): Promise<void> | undefined {
    return this.persistence?.saveConversionTask(task, updates, this.leases.token(task.id));
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
  if (task.modelId) return `projects/${task.projectId}/models/${task.modelId}/attempts/${task.id}/`;
  return `projects/${task.projectId}/conversions/${task.id}/output/`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
