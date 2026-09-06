import {
  SceneBehaviorScheduler,
  validateSceneCommand,
  type SceneBehaviorCapabilityRequest,
  type SceneBehaviorModule,
  type SceneBehaviorNetworkRequest,
  type SceneBehaviorNetworkResult,
  type SceneBehaviorRuntimeSettings,
  type SceneBehaviorSchedulerDiagnostics,
  type SceneBehaviorWorkerRequest,
  type SceneBehaviorWorkerResponse,
  type SceneCommand,
  type SceneEvent,
  type SceneScriptLifecycle
} from "@bim-studio/scene-sdk";
import type { JsonValue } from "@bim-studio/contracts";
import { behaviorScriptSource } from "./behaviorScriptSource";

export interface SceneBehaviorWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: SceneBehaviorWorkerRequest): void;
  terminate(): void;
}

export interface SceneBehaviorHostOptions {
  /** Only explicit, disposable author sessions may suspend execution watchdogs. */
  authorDebug?: boolean;
  runtime?: Partial<SceneBehaviorRuntimeSettings>;
  executionBudgetMs?: number;
  initializationTimeoutMs?: number;
  maxPendingInvocations?: number;
  maxCommandsPerInvocation?: number;
  networkTimeoutMs?: number;
  executeNetworkRequest?: (request: Omit<SceneBehaviorNetworkRequest, "requestId" | "invocationId">) => Promise<SceneBehaviorNetworkResult>;
  capabilityTimeoutMs?: number;
  executeCapabilityRequest?: (request: Omit<SceneBehaviorCapabilityRequest, "requestId" | "invocationId">) => Promise<JsonValue>;
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
  lastErrorLocation?: { line: number; column: number };
  scheduler: SceneBehaviorSchedulerDiagnostics;
  authorDebug?: { sourceUrl: string; lineOffset: number; awaitingStart: boolean };
}

interface PendingInvocation {
  lifecycle: SceneScriptLifecycle;
  startedAt: number;
  timeoutId: ReturnType<typeof setTimeout> | undefined;
}

const LIFECYCLES = new Set<SceneScriptLifecycle>(["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"]);
const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

export class SceneBehaviorHost {
  onCommands?: (commands: SceneCommand[]) => void;
  onDataUpdates?: (updates: Record<string, JsonValue>) => void;
  onEvent?: (event: { name: string; payload?: JsonValue }) => void;
  onLog?: (entry: Extract<SceneBehaviorWorkerResponse, { type: "behavior.log" }>) => void;
  onDiagnosticsChange?: (diagnostics: SceneBehaviorHostDiagnostics) => void;

  private readonly worker: SceneBehaviorWorkerPort;
  private readonly authorDebug: boolean;
  private awaitingDebugStart = false;
  private readonly scheduler: SceneBehaviorScheduler;
  private readonly executionBudgetMs: number;
  private readonly initializationTimeoutMs: number;
  private readonly maxPendingInvocations: number;
  private readonly maxCommandsPerInvocation: number;
  private readonly networkTimeoutMs: number;
  private readonly executeNetworkRequest: SceneBehaviorHostOptions["executeNetworkRequest"];
  private readonly capabilityTimeoutMs: number;
  private readonly executeCapabilityRequest: SceneBehaviorHostOptions["executeCapabilityRequest"];
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
  private lastErrorLocation: { line: number; column: number } | undefined;
  private latestData: JsonValue | undefined;
  private stopped = false;
  private terminated = false;

  constructor(worker: SceneBehaviorWorkerPort, options: SceneBehaviorHostOptions = {}) {
    this.worker = worker;
    this.authorDebug = options.authorDebug === true;
    this.scheduler = new SceneBehaviorScheduler(options.runtime);
    this.executionBudgetMs = finiteOption(options.executionBudgetMs, 1, 10_000, 25);
    this.initializationTimeoutMs = finiteOption(options.initializationTimeoutMs, 10, 60_000, 2_000);
    this.maxPendingInvocations = Math.round(finiteOption(options.maxPendingInvocations, 1, 256, 8));
    this.maxCommandsPerInvocation = Math.round(finiteOption(options.maxCommandsPerInvocation, 1, 10_000, 256));
    this.networkTimeoutMs = finiteOption(options.networkTimeoutMs, 100, 120_000, 15_000);
    this.executeNetworkRequest = options.executeNetworkRequest;
    this.capabilityTimeoutMs = finiteOption(options.capabilityTimeoutMs, 100, 300_000, 90_000);
    this.executeCapabilityRequest = options.executeCapabilityRequest;
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
    this.lastErrorLocation = undefined;
    this.scheduler.reset();
    this.worker.postMessage({ type: "behavior.initialize", module: this.module, sceneId });
    if (!this.authorDebug) this.initTimeoutId = globalThis.setTimeout(() => this.fail(`行为“${module.name}”初始化超过 ${this.initializationTimeoutMs} ms`), this.initializationTimeoutMs);
    this.emitDiagnostics();
  }

  advance(deltaMs: number): void {
    if (this.status !== "running" || !this.module) return;
    // DevTools cannot report pause state to page JS. Freeze the clock while a
    // frame is in flight; never enqueue elapsed wall time behind a breakpoint.
    if (this.authorDebug && this.pending.size) return;
    for (const tick of this.scheduler.advance(deltaMs)) {
      if (this.module.lifecycle.includes(tick.lifecycle)) this.invoke(tick.lifecycle, tick.elapsedMs, { deltaMs: tick.deltaMs });
    }
  }

  dispatchEvent(event: SceneEvent): void {
    if (this.authorDebug && this.pending.size) return;
    if (this.status === "running" && this.module?.lifecycle.includes("onEvent")) this.invoke("onEvent", this.scheduler.diagnostics().elapsedMs, { event });
  }

  dispatchData(data: JsonValue): void {
    this.latestData = structuredClone(data);
    if (this.authorDebug && this.pending.size) return;
    if (this.status === "running" && this.module?.lifecycle.includes("onData")) this.invoke("onData", this.scheduler.diagnostics().elapsedMs, { data: this.latestData });
  }

  pause(): void {
    if (this.status !== "running") return;
    this.scheduler.pause();
    this.status = "paused";
    this.emitDiagnostics();
  }

  /** Advance one simulation frame without resuming event/data dispatch. */
  step(deltaMs = 1000 / 60): boolean {
    if (this.status !== "paused" || !this.module || this.pending.size || this.awaitingDebugStart) return false;
    this.scheduler.resume();
    try {
      for (const tick of this.scheduler.advance(deltaMs)) {
        if (this.module.lifecycle.includes(tick.lifecycle)) this.invoke(tick.lifecycle, tick.elapsedMs, { deltaMs: tick.deltaMs });
      }
    } finally {
      this.scheduler.pause();
      this.emitDiagnostics();
    }
    return true;
  }

  resume(): void {
    if (this.status !== "paused") return;
    this.stopped = false;
    this.scheduler.resume();
    this.status = "running";
    if (this.awaitingDebugStart) {
      this.awaitingDebugStart = false;
      this.invokeInitialLifecycles();
    }
    this.emitDiagnostics();
  }

  configure(patch: Partial<SceneBehaviorRuntimeSettings>): void {
    this.scheduler.configure(patch);
    this.emitDiagnostics();
  }

  stop(): void {
    if (this.authorDebug) { this.finishDispose(); return; }
    if (this.status !== "running" && this.status !== "paused") return;
    if (!this.stopped && this.module?.lifecycle.includes("onStop")) {
      this.invoke("onStop", this.scheduler.diagnostics().elapsedMs);
    }
    this.stopped = true;
    this.scheduler.pause();
    this.status = "paused";
    this.emitDiagnostics();
  }

  dispose(): void {
    if (this.status === "disposed" || this.status === "disposing") return;
    // A debugger-paused Worker cannot acknowledge teardown. Its private run is
    // discarded immediately, including callbacks that were already queued.
    if (this.authorDebug) { this.finishDispose(); return; }
    if (this.status === "idle" || this.status === "error") {
      this.finishDispose();
      return;
    }
    this.clearInitializationTimeout();
    this.clearPending();
    // Queue cleanup in lifecycle order, but never apply teardown commands to a
    // document/viewer that the owner may already have replaced.
    if (!this.stopped && (this.status === "running" || this.status === "paused") && this.module?.lifecycle.includes("onStop")) {
      this.worker.postMessage({ type: "behavior.invoke", invocationId: this.nextInvocationId("onStop"), lifecycle: "onStop", elapsedMs: this.scheduler.diagnostics().elapsedMs });
    }
    this.stopped = true;
    this.scheduler.pause();
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
      ...(this.lastErrorLocation ? { lastErrorLocation: { ...this.lastErrorLocation } } : {}),
      scheduler: this.scheduler.diagnostics(),
      ...(this.authorDebug && this.module ? { authorDebug: { sourceUrl: behaviorScriptSource(this.module).url, lineOffset: behaviorScriptSource(this.module).lineOffset, awaitingStart: this.awaitingDebugStart } } : {})
    };
  }

  private invoke(lifecycle: SceneScriptLifecycle, elapsedMs: number, detail: { deltaMs?: number; event?: SceneEvent; data?: JsonValue } = {}): void {
    if (this.pending.size >= this.maxPendingInvocations) {
      this.droppedInvocations += 1;
      this.emitDiagnostics();
      return;
    }
    const invocationId = this.nextInvocationId(lifecycle);
    const timeoutId = this.authorDebug ? undefined : globalThis.setTimeout(() => this.fail(`行为“${this.module?.name ?? "unknown"}”的 ${lifecycle} 超过 ${this.executionBudgetMs} ms`), this.executionBudgetMs);
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
    if (this.status === "disposed" || this.status === "error") return;
    if (!isWorkerResponse(value)) {
      this.fail("行为 Worker 返回了无效消息");
      return;
    }
    if (value.type === "behavior.ready") {
      if (this.status !== "initializing" || value.moduleId !== this.module?.id) return;
      this.clearInitializationTimeout();
      this.awaitingDebugStart = this.authorDebug;
      this.status = this.authorDebug ? "paused" : "running";
      if (this.authorDebug) this.scheduler.pause();
      else this.invokeInitialLifecycles();
      this.emitDiagnostics();
      return;
    }
    if (value.type === "behavior.log") {
      this.onLog?.(value);
      return;
    }
    if (this.status === "disposing") {
      if (value.type === "behavior.result" && this.pending.get(value.invocationId)?.lifecycle === "onDispose") {
        this.completedInvocations += 1;
        this.finishDispose();
      }
      return;
    }
    if (value.type === "behavior.network.request") {
      void this.handleNetworkRequest(value);
      return;
    }
    if (value.type === "behavior.capability.request") {
      void this.handleCapabilityRequest(value);
      return;
    }
    if (value.type === "behavior.error") {
      this.fail(value.message, behaviorSourceLocation(value.stack, this.module?.id));
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
    if (value.dataUpdates && Object.keys(value.dataUpdates).length > 0) this.onDataUpdates?.(structuredClone(value.dataUpdates));
    for (const event of value.events ?? []) this.onEvent?.(structuredClone(event));
    if (pending.lifecycle === "onDispose") this.finishDispose();
    else this.emitDiagnostics();
  }

  private async handleNetworkRequest(request: SceneBehaviorNetworkRequest): Promise<void> {
    const pending = this.pending.get(request.invocationId);
    if (!pending || !this.module) return;
    if (!this.module.permissions.includes("network.connect") || !this.executeNetworkRequest) {
      this.worker.postMessage({ type: "behavior.network.result", requestId: request.requestId, error: "脚本未获 network.connect 权限或网络网关不可用" });
      return;
    }
    globalThis.clearTimeout(pending.timeoutId);
    pending.timeoutId = globalThis.setTimeout(() => this.fail(`行为“${this.module?.name ?? "unknown"}”的网络请求超过 ${this.networkTimeoutMs} ms`), this.networkTimeoutMs);
    try {
      const result = await this.executeNetworkRequest({ binding: request.binding, variables: request.variables });
      if (this.pending.get(request.invocationId) !== pending) return;
      if (this.authorDebug) globalThis.clearTimeout(pending.timeoutId);
      this.worker.postMessage({ type: "behavior.network.result", requestId: request.requestId, result });
    } catch (reason) {
      if (this.pending.get(request.invocationId) !== pending) return;
      if (this.authorDebug) globalThis.clearTimeout(pending.timeoutId);
      this.worker.postMessage({ type: "behavior.network.result", requestId: request.requestId, error: reason instanceof Error ? reason.message : String(reason) });
    }
  }

  private async handleCapabilityRequest(request: SceneBehaviorCapabilityRequest): Promise<void> {
    const pending = this.pending.get(request.invocationId);
    if (!pending || !this.module) return;
    if (!this.executeCapabilityRequest) {
      this.worker.postMessage({
        type: "behavior.capability.result",
        requestId: request.requestId,
        error: "脚本 AI 能力网关暂不可用，请稍后重试或使用编辑器 AI 助手",
      });
      return;
    }
    if (!this.module.permissions.includes("ai.invoke") || !this.module.capabilities.includes("studio.ai")) {
      this.worker.postMessage({ type: "behavior.capability.result", requestId: request.requestId, error: "脚本未获 studio.ai 能力或 ai.invoke 权限" });
      return;
    }
    // 工业 AI 可能远程推理，将当前调用切换到独立的可控超时。
    globalThis.clearTimeout(pending.timeoutId);
    pending.timeoutId = globalThis.setTimeout(
      () => this.fail(`行为“${this.module?.name ?? "unknown"}”的 AI 能力调用超过 ${this.capabilityTimeoutMs} ms`),
      this.capabilityTimeoutMs,
    );
    try {
      const result = await this.executeCapabilityRequest({ capabilityId: request.capabilityId, input: request.input });
      if (this.pending.get(request.invocationId) !== pending) return;
      if (this.authorDebug) globalThis.clearTimeout(pending.timeoutId);
      this.worker.postMessage({ type: "behavior.capability.result", requestId: request.requestId, result });
    } catch (reason) {
      if (this.pending.get(request.invocationId) !== pending) return;
      if (this.authorDebug) globalThis.clearTimeout(pending.timeoutId);
      this.worker.postMessage({
        type: "behavior.capability.result",
        requestId: request.requestId,
        error: reason instanceof Error ? reason.message : String(reason),
      });
    }
  }

  private fail(message: string, location?: { line: number; column: number }): void {
    if (this.status === "disposed" || this.status === "error") return;
    this.lastError = message;
    this.lastErrorLocation = location;
    this.status = "error";
    this.scheduler.pause();
    this.clearInitializationTimeout();
    this.clearPending();
    this.terminate();
    this.emitDiagnostics();
  }

  private finishDispose(): void {
    if (this.status === "disposed") return;
    this.clearInitializationTimeout();
    this.clearPending();
    this.scheduler.dispose();
    this.terminate();
    this.status = "disposed";
    this.emitDiagnostics();
  }

  private terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.worker.terminate();
    this.worker.onmessage = null;
    this.worker.onerror = null;
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

  private invokeInitialLifecycles(): void {
    if (this.module?.lifecycle.includes("onStart")) this.invoke("onStart", 0, this.latestData === undefined ? {} : { data: this.latestData });
    if (this.latestData !== undefined && this.module?.lifecycle.includes("onData")) this.invoke("onData", 0, { data: this.latestData });
  }

  private emitDiagnostics(): void {
    this.onDiagnosticsChange?.(this.diagnostics());
  }
}

export function createSceneBehaviorWorker(name = "bim-studio-scene-behavior"): SceneBehaviorWorkerPort {
  return new Worker(new URL("../workers/sceneBehavior.worker.ts", import.meta.url), { type: "module", name });
}

function isWorkerResponse(value: unknown): value is SceneBehaviorWorkerResponse {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.type === "behavior.ready") {
    return typeof message.moduleId === "string" && Array.isArray(message.lifecycle) && message.lifecycle.every((item) => LIFECYCLES.has(item as SceneScriptLifecycle));
  }
  if (message.type === "behavior.result") {
    return typeof message.invocationId === "string"
      && typeof message.durationMs === "number"
      && Number.isFinite(message.durationMs)
      && message.durationMs >= 0
      && Array.isArray(message.commands)
      && (message.dataUpdates === undefined || isJsonRecord(message.dataUpdates))
      && (message.events === undefined || Array.isArray(message.events) && message.events.every(isBehaviorEvent));
  }
  if (message.type === "behavior.network.request") {
    return typeof message.requestId === "string"
      && typeof message.invocationId === "string"
      && Boolean(message.binding && typeof message.binding === "object")
      && Boolean(message.variables && typeof message.variables === "object");
  }
  if (message.type === "behavior.capability.request") {
    return typeof message.requestId === "string"
      && typeof message.invocationId === "string"
      && typeof message.capabilityId === "string"
      && message.capabilityId.trim().length > 0
      && isJsonValue(message.input);
  }
  if (message.type === "behavior.log") return typeof message.level === "string" && LOG_LEVELS.has(message.level) && typeof message.message === "string";
  if (message.type === "behavior.error") return typeof message.message === "string" && (message.invocationId === undefined || typeof message.invocationId === "string");
  return false;
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item));
}

function isBehaviorEvent(value: unknown): value is { name: string; payload?: JsonValue } {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return typeof event.name === "string" && event.name.trim().length > 0 && (event.payload === undefined || isJsonValue(event.payload));
}

function isJsonValue(value: unknown, seen = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  return Object.values(value).every((item) => isJsonValue(item, seen));
}

function finiteOption(value: number | undefined, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function behaviorSourceLocation(stack: string | undefined, moduleId: string | undefined): { line: number; column: number } | undefined {
  if (!stack || !moduleId) return undefined;
  const sourceId = encodeURIComponent(moduleId);
  const isModule = stack.includes(`industrial-studio-behavior-${sourceId}.mjs:`);
  const marker = `industrial-studio-behavior-${sourceId}.${isModule ? "mjs" : "js"}:`;
  const start = stack.indexOf(marker);
  if (start < 0) return undefined;
  const match = /^(\d+):(\d+)/.exec(stack.slice(start + marker.length));
  if (!match) return undefined;
  const generatedLine = Number(match[1]);
  const column = Number(match[2]);
  if (!Number.isInteger(generatedLine) || !Number.isInteger(column)) return undefined;
  return { line: Math.max(1, generatedLine - (isModule ? 1 : 3)), column: Math.max(1, column) };
}
