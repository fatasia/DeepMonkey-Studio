import {
  SceneBehaviorScheduler,
  validateSceneCommand,
  type SceneBehaviorModule,
  type SceneBehaviorRuntimeSettings,
  type SceneBehaviorSchedulerDiagnostics,
  type SceneBehaviorWorkerRequest,
  type SceneBehaviorWorkerResponse,
  type SceneCommand,
  type SceneEvent,
  type SceneScriptLifecycle
} from "@bim-studio/scene-sdk";
import type { JsonValue } from "@bim-studio/contracts";

export interface SceneBehaviorWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SceneBehaviorWorkerRequest): void;
  terminate(): void;
}

export interface SceneBehaviorHostOptions {
  runtime?: Partial<SceneBehaviorRuntimeSettings>;
  executionBudgetMs?: number;
  initializationTimeoutMs?: number;
  maxPendingInvocations?: number;
  maxCommandsPerInvocation?: number;
  now?: () => number;
}

export interface SceneBehaviorHostDiagnostics {
  status: "idle" | "initializing" | "running" | "paused" | "disposing" | "disposed" | "error";
  moduleId?: string;
  pendingInvocations: number;
  completedInvocations: number;
  droppedInvocations: number;
  rejectedCommands: number;
  averageExecutionMs: number;
  lastExecutionMs: number;
  lastError?: string;
  scheduler: SceneBehaviorSchedulerDiagnostics;
}

interface PendingInvocation {
  lifecycle: SceneScriptLifecycle;
  startedAt: number;
  timeoutId: ReturnType<typeof setTimeout>;
}

const LIFECYCLES = new Set<SceneScriptLifecycle>(["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

export class SceneBehaviorHost {
  onCommands?: (commands: SceneCommand[]) => void;
  onLog?: (entry: Extract<SceneBehaviorWorkerResponse, { type: "behavior.log" }>) => void;
  onDiagnosticsChange?: (diagnostics: SceneBehaviorHostDiagnostics) => void;

  private readonly worker: SceneBehaviorWorkerPort;
  private readonly scheduler: SceneBehaviorScheduler;
  private readonly executionBudgetMs: number;
  private readonly initializationTimeoutMs: number;
  private readonly maxPendingInvocations: number;
  private readonly maxCommandsPerInvocation: number;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingInvocation>();
  private status: SceneBehaviorHostDiagnostics["status"] = "idle";
  private module: SceneBehaviorModule | undefined;
  private sceneId = "";
  private initTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private invocationSequence = 0;
  private completedInvocations = 0;
  private droppedInvocations = 0;
  private rejectedCommands = 0;
  private totalExecutionMs = 0;
  private lastExecutionMs = 0;
  private lastError: string | undefined;

  constructor(worker: SceneBehaviorWorkerPort, options: SceneBehaviorHostOptions = {}) {
    this.worker = worker;
    this.scheduler = new SceneBehaviorScheduler(options.runtime);
    this.executionBudgetMs = finiteOption(options.executionBudgetMs, 1, 10_000, 25);
    this.initializationTimeoutMs = finiteOption(options.initializationTimeoutMs, 10, 60_000, 2_000);
    this.maxPendingInvocations = Math.round(finiteOption(options.maxPendingInvocations, 1, 256, 8));
    this.maxCommandsPerInvocation = Math.round(finiteOption(options.maxCommandsPerInvocation, 1, 10_000, 256));
    this.now = options.now ?? (() => performance.now());
    worker.onmessage = (event) => this.handleMessage(event.data);
    worker.onerror = (event) => this.fail(`行为 Worker 异常：${event.message || "unknown error"}`);
  }

  start(module: SceneBehaviorModule, sceneId: string): void {
    if (this.status !== "idle") throw new Error(`行为运行时当前状态为 ${this.status}，不能重新启动`);
    if (!sceneId) throw new Error("行为运行时需要 sceneId");
    this.module = structuredClone(module);
    this.sceneId = sceneId;
    this.status = "initializing";
    this.lastError = undefined;
    this.scheduler.reset();
    this.worker.postMessage({ type: "behavior.initialize", module: this.module, sceneId });
    this.initTimeoutId = globalThis.setTimeout(() => this.fail(`行为“${module.name}”初始化超过 ${this.initializationTimeoutMs} ms`), this.initializationTimeoutMs);
    this.emitDiagnostics();
  }

  advance(deltaMs: number): void {
    if (this.status !== "running" || !this.module) return;
    for (const tick of this.scheduler.advance(deltaMs)) {
      if (this.module.lifecycle.includes(tick.lifecycle)) this.invoke(tick.lifecycle, tick.elapsedMs, { deltaMs: tick.deltaMs });
    }
  }

  dispatchEvent(event: SceneEvent): void {
    if (this.status === "running" && this.module?.lifecycle.includes("onEvent")) this.invoke("onEvent", this.scheduler.diagnostics().elapsedMs, { event });
  }

  dispatchData(data: JsonValue): void {
    if (this.status === "running" && this.module?.lifecycle.includes("onData")) this.invoke("onData", this.scheduler.diagnostics().elapsedMs, { data });
  }

  pause(): void {
    if (this.status !== "running") return;
    this.scheduler.pause();
    this.status = "paused";
    this.emitDiagnostics();
  }

  resume(): void {
    if (this.status !== "paused") return;
    this.scheduler.resume();
    this.status = "running";
    this.emitDiagnostics();
  }

  configure(patch: Partial<SceneBehaviorRuntimeSettings>): void {
    this.scheduler.configure(patch);
    this.emitDiagnostics();
  }

  stop(): void {
    if ((this.status === "running" || this.status === "paused") && this.module?.lifecycle.includes("onStop")) {
      this.invoke("onStop", this.scheduler.diagnostics().elapsedMs);
    }
    this.scheduler.pause();
    this.status = "paused";
    this.emitDiagnostics();
  }

  dispose(): void {
    if (this.status === "disposed" || this.status === "disposing") return;
    if (this.status === "idle" || this.status === "error") {
      this.clearInitializationTimeout();
      this.clearPending();
      this.scheduler.dispose();
      this.status = "disposed";
      this.emitDiagnostics();
      return;
    }
    this.clearInitializationTimeout();
    this.clearPending();
    this.status = "disposing";
    const invocationId = this.nextInvocationId("onDispose");
    this.pending.set(invocationId, {
      lifecycle: "onDispose",
      startedAt: this.now(),
      timeoutId: globalThis.setTimeout(() => this.finishDispose(), this.executionBudgetMs)
    });
    this.worker.postMessage({ type: "behavior.dispose", invocationId });
    this.emitDiagnostics();
  }

  diagnostics(): SceneBehaviorHostDiagnostics {
    return {
      status: this.status,
      ...(this.module ? { moduleId: this.module.id } : {}),
      pendingInvocations: this.pending.size,
      completedInvocations: this.completedInvocations,
      droppedInvocations: this.droppedInvocations,
      rejectedCommands: this.rejectedCommands,
      averageExecutionMs: this.completedInvocations > 0 ? this.totalExecutionMs / this.completedInvocations : 0,
      lastExecutionMs: this.lastExecutionMs,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      scheduler: this.scheduler.diagnostics()
    };
  }

  private invoke(lifecycle: SceneScriptLifecycle, elapsedMs: number, detail: { deltaMs?: number; event?: SceneEvent; data?: JsonValue } = {}): void {
    if (this.pending.size >= this.maxPendingInvocations) {
      this.droppedInvocations += 1;
      this.emitDiagnostics();
      return;
    }
    const invocationId = this.nextInvocationId(lifecycle);
    const timeoutId = globalThis.setTimeout(() => this.fail(`行为“${this.module?.name ?? "unknown"}”的 ${lifecycle} 超过 ${this.executionBudgetMs} ms`), this.executionBudgetMs);
    this.pending.set(invocationId, { lifecycle, startedAt: this.now(), timeoutId });
    this.worker.postMessage({
      type: "behavior.invoke",
      invocationId,
      lifecycle,
      elapsedMs,
      ...(detail.deltaMs !== undefined ? { deltaMs: detail.deltaMs } : {}),
      ...(detail.event ? { event: detail.event } : {}),
      ...(detail.data !== undefined ? { data: detail.data } : {})
    });
  }

  private handleMessage(value: unknown): void {
    if (!isWorkerResponse(value)) {
      this.fail("行为 Worker 返回了无效消息");
      return;
    }
    if (value.type === "behavior.ready") {
      if (this.status !== "initializing" || value.moduleId !== this.module?.id) return;
      this.clearInitializationTimeout();
      this.status = "running";
      if (this.module.lifecycle.includes("onStart")) this.invoke("onStart", 0);
      this.emitDiagnostics();
      return;
    }
    if (value.type === "behavior.log") {
      this.onLog?.(value);
      return;
    }
    if (value.type === "behavior.error") {
      this.fail(value.message);
      return;
    }
    const pending = this.pending.get(value.invocationId);
    if (!pending) return;
    globalThis.clearTimeout(pending.timeoutId);
    this.pending.delete(value.invocationId);
    this.lastExecutionMs = Math.max(0, value.durationMs);
    this.totalExecutionMs += this.lastExecutionMs;
    this.completedInvocations += 1;
    const commands: SceneCommand[] = [];
    for (const candidate of value.commands) {
      const validation = validateSceneCommand(candidate);
      if (validation.valid) commands.push(validation.command);
      else this.rejectedCommands += 1;
    }
    if (commands.length > this.maxCommandsPerInvocation) {
      this.rejectedCommands += commands.length - this.maxCommandsPerInvocation;
      commands.length = this.maxCommandsPerInvocation;
    }
    if (commands.length > 0) this.onCommands?.(commands);
    if (pending.lifecycle === "onDispose") this.finishDispose();
    else this.emitDiagnostics();
  }

  private fail(message: string): void {
    if (this.status === "disposed") return;
    this.lastError = message;
    this.status = "error";
    this.scheduler.pause();
    this.clearInitializationTimeout();
    this.clearPending();
    this.worker.terminate();
    this.emitDiagnostics();
  }

  private finishDispose(): void {
    this.clearPending();
    this.scheduler.dispose();
    this.worker.terminate();
    this.status = "disposed";
    this.emitDiagnostics();
  }

  private clearInitializationTimeout(): void {
    if (this.initTimeoutId !== undefined) globalThis.clearTimeout(this.initTimeoutId);
    this.initTimeoutId = undefined;
  }

  private clearPending(): void {
    for (const item of this.pending.values()) globalThis.clearTimeout(item.timeoutId);
    this.pending.clear();
  }

  private nextInvocationId(lifecycle: SceneScriptLifecycle): string {
    this.invocationSequence += 1;
    return `${this.module?.id ?? "behavior"}:${lifecycle}:${this.invocationSequence}`;
  }

  private emitDiagnostics(): void {
    this.onDiagnosticsChange?.(this.diagnostics());
  }
}

export function createSceneBehaviorWorker(): SceneBehaviorWorkerPort {
  return new Worker(new URL("../workers/sceneBehavior.worker.ts", import.meta.url), { type: "module", name: "bim-studio-scene-behavior" });
}

function isWorkerResponse(value: unknown): value is SceneBehaviorWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "behavior.ready") {
    return typeof message.moduleId === "string" && Array.isArray(message.lifecycle) && message.lifecycle.every((item) => LIFECYCLES.has(item as SceneScriptLifecycle));
  }
  if (message.type === "behavior.result") {
    return typeof message.invocationId === "string" && typeof message.durationMs === "number" && Number.isFinite(message.durationMs) && message.durationMs >= 0 && Array.isArray(message.commands);
  }
  if (message.type === "behavior.log") return typeof message.level === "string" && LOG_LEVELS.has(message.level) && typeof message.message === "string";
  if (message.type === "behavior.error") return typeof message.message === "string" && (message.invocationId === undefined || typeof message.invocationId === "string");
  return false;
}

function finiteOption(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
