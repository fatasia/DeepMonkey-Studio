/**
 * 工业能力插件的运行时合同。
 *
 * 这里故意只描述请求、证据和生命周期，不暴露 React、Three.js、数据库
 * 或模型私有对象。这样领域算法可以在主线程、Worker 或远程服务之间替换，
 * 而 UI、MCP 和 API 始终消费同一份可审计结果。
 */

import type { CapabilityExecution } from "./manifest.js";
import { isCapabilitySchema, validateCapabilityValue, type CapabilityJsonSchema } from "./capabilitySchema.js";

export type CapabilityKind = "query" | "analysis" | "simulation" | "model" | "action";
export type CapabilityRunStatus = "completed" | "needs-input" | "blocked" | "unavailable" | "failed";
export type CapabilityDecisionStatus = "production" | "shadow" | "research-candidate" | "insufficient-data";

export interface CapabilityInterval {
  low: number;
  high: number;
  unit?: string;
}

export interface CapabilityEvidence {
  id: string;
  kind: "data" | "model" | "rule" | "simulation" | "trace";
  label: string;
  source: string;
  detail?: string;
  fingerprint?: string;
}

export interface CapabilitySuggestedAction {
  id: string;
  label: string;
  commandType: string;
  input: Record<string, unknown>;
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
}

export interface CapabilityDescriptor {
  id: string;
  version: string;
  label: string;
  kind: CapabilityKind;
  execution: CapabilityExecution;
  permissions: string[];
  timeoutMs: number;
  inputSchemaVersion: string;
  outputSchemaVersion: string;
  inputSchema: CapabilityJsonSchema;
  outputSchema: CapabilityJsonSchema;
}

export interface CapabilityRequest<TInput = unknown> {
  requestId: string;
  projectId: string;
  principal: string;
  role?: string;
  input: TInput;
  dryRun?: boolean;
  expectedRevision?: string;
  signal?: AbortSignal;
}

export interface CapabilityContext {
  pluginId: string;
  pluginVersion: string;
  descriptor: CapabilityDescriptor;
  signal: AbortSignal;
}

export interface CapabilityProviderResult<TOutput = unknown> {
  status: CapabilityRunStatus;
  decisionStatus: CapabilityDecisionStatus;
  output?: TOutput;
  confidence?: number;
  interval?: CapabilityInterval;
  evidence?: CapabilityEvidence[];
  warnings?: string[];
  suggestedActions?: CapabilitySuggestedAction[];
}

export interface CapabilityProvider<TInput = unknown, TOutput = unknown> {
  descriptor: CapabilityDescriptor;
  invoke(request: CapabilityRequest<TInput>, context: CapabilityContext): Promise<CapabilityProviderResult<TOutput>>;
}

export interface CapabilityError {
  code: "not-found" | "permission-denied" | "timeout" | "aborted" | "provider-failed" | "invalid-input" | "invalid-result" | "duplicate" | "invalid-provider";
  message: string;
  retryable: boolean;
}

export interface CapabilityInvocationResult<TOutput = unknown> {
  status: CapabilityRunStatus;
  capabilityId: string;
  pluginId: string;
  capabilityVersion: string;
  requestId: string;
  traceId: string;
  generatedAt: string;
  durationMs: number;
  decisionStatus: CapabilityDecisionStatus;
  output?: TOutput;
  confidence?: number;
  interval?: CapabilityInterval;
  evidence: CapabilityEvidence[];
  warnings: string[];
  suggestedActions: CapabilitySuggestedAction[];
  error?: CapabilityError;
}

export type CapabilityRegistrationResult =
  | {
      ok: true;
      capability: CapabilityDescriptor;
    }
  | {
      ok: false;
      code: "duplicate" | "invalid-provider" | "permission-denied";
      message: string;
    };

interface RegisteredCapability {
  pluginId: string;
  pluginVersion: string;
  grantedPermissions: ReadonlySet<string>;
  provider: CapabilityProvider;
}

const identifierPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * Registers and invokes capability providers while containing failures.
 * A provider is never allowed to mutate host state directly; it can only return
 * typed output, evidence and suggested commands.
 */
export class CapabilityRegistry {
  readonly #providers = new Map<string, RegisteredCapability>();

  public register(provider: CapabilityProvider, pluginId: string, pluginVersion: string, grantedPermissions: readonly string[]): CapabilityRegistrationResult {
    const issue = validateProvider(provider);
    if (issue) return { ok: false, code: "invalid-provider", message: issue };
    const capabilityId = provider.descriptor.id;
    if (this.#providers.has(capabilityId)) return { ok: false, code: "duplicate", message: `capability ${capabilityId} is already registered` };
    const permissions = new Set(grantedPermissions);
    const missing = provider.descriptor.permissions.filter((permission) => !permissions.has(permission));
    if (missing.length > 0) return { ok: false, code: "permission-denied", message: `capability ${capabilityId} requires ${missing.join(",")}` };
    this.#providers.set(capabilityId, {
      pluginId,
      pluginVersion,
      grantedPermissions: permissions,
      provider,
    });
    return { ok: true, capability: cloneDescriptor(provider.descriptor) };
  }

  public unregisterPlugin(pluginId: string): void {
    for (const [capabilityId, registered] of this.#providers) {
      if (registered.pluginId === pluginId) this.#providers.delete(capabilityId);
    }
  }

  public get(capabilityId: string): CapabilityDescriptor | undefined {
    const registered = this.#providers.get(capabilityId);
    return registered ? cloneDescriptor(registered.provider.descriptor) : undefined;
  }

  public list(): CapabilityDescriptor[] {
    return [...this.#providers.values()].map((registered) => cloneDescriptor(registered.provider.descriptor)).sort((left, right) => left.id.localeCompare(right.id));
  }

  public async invoke<TOutput = unknown>(
    capabilityId: string,
    request: CapabilityRequest,
    options: { timeoutMs?: number; traceId?: string } = {},
  ): Promise<CapabilityInvocationResult<TOutput>> {
    const startedAt = Date.now();
    const registered = this.#providers.get(capabilityId);
    const traceId = options.traceId ?? createTraceId();
    if (!registered) {
      return failureResult<TOutput>({
        capabilityId,
        request,
        traceId,
        startedAt,
        status: "blocked",
        error: { code: "not-found", message: `未注册能力：${capabilityId}`, retryable: false },
      });
    }
    const inputIssues = validateCapabilityValue(registered.provider.descriptor.inputSchema, request.input);
    if (inputIssues.length > 0) {
      return failureResult<TOutput>({
        capabilityId,
        pluginId: registered.pluginId,
        capabilityVersion: registered.pluginVersion,
        request,
        traceId,
        startedAt,
        status: "blocked",
        error: { code: "invalid-input", message: inputIssues.slice(0, 5).join("；"), retryable: false },
      });
    }

    const configuredTimeout = options.timeoutMs ?? registered.provider.descriptor.timeoutMs;
    const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? Math.min(Math.floor(configuredTimeout), 3_600_000) : registered.provider.descriptor.timeoutMs;
    const controller = new AbortController();
    if (request.signal?.aborted) {
      return failureResult<TOutput>({
        capabilityId,
        pluginId: registered.pluginId,
        capabilityVersion: registered.pluginVersion,
        request,
        traceId,
        startedAt,
        status: "failed",
        error: { code: "aborted", message: "能力执行已取消", retryable: true },
      });
    }
    let abortReason: "timeout" | "aborted" | undefined;
    const abortFromCaller = (): void => {
      abortReason = "aborted";
      controller.abort();
    };
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => {
        abortReason = "timeout";
        controller.abort();
        resolve("timeout");
      }, timeoutMs);
    });
    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<"aborted">((resolve) => {
      abortListener = () => resolve("aborted");
      if (request.signal?.aborted) abortListener();
      else request.signal?.addEventListener("abort", abortListener, { once: true });
    });
    const context: CapabilityContext = {
      pluginId: registered.pluginId,
      pluginVersion: registered.pluginVersion,
      descriptor: cloneDescriptor(registered.provider.descriptor),
      signal: controller.signal,
    };
    const providerPromise = Promise.resolve().then(() => registered.provider.invoke(request, context));
    // A provider that ignores AbortSignal must not create an unhandled rejection
    // after the host has already returned a timeout/abort result.
    void providerPromise.catch(() => undefined);
    try {
      const raced = await Promise.race([
        providerPromise.then((result) => ({ kind: "provider" as const, result })),
        timeoutPromise.then((reason) => ({ kind: reason })),
        abortPromise.then((reason) => ({ kind: reason })),
      ]);
      if (raced.kind === "timeout") {
        return failureResult<TOutput>({
          capabilityId,
          pluginId: registered.pluginId,
          capabilityVersion: registered.pluginVersion,
          request,
          traceId,
          startedAt,
          status: "failed",
          error: { code: "timeout", message: `能力执行超过 ${timeoutMs}ms`, retryable: true },
        });
      }
      if (raced.kind === "aborted") {
        return failureResult<TOutput>({
          capabilityId,
          pluginId: registered.pluginId,
          capabilityVersion: registered.pluginVersion,
          request,
          traceId,
          startedAt,
          status: "failed",
          error: { code: "aborted", message: "能力执行已取消", retryable: true },
        });
      }
      const providerResult = raced.result;
      if (providerResult.output !== undefined) {
        const outputIssues = validateCapabilityValue(registered.provider.descriptor.outputSchema, providerResult.output);
        if (outputIssues.length > 0) {
          return failureResult<TOutput>({
            capabilityId,
            pluginId: registered.pluginId,
            capabilityVersion: registered.pluginVersion,
            request,
            traceId,
            startedAt,
            status: "failed",
            error: { code: "invalid-result", message: `能力输出不符合合同：${outputIssues.slice(0, 5).join("；")}`, retryable: false },
          });
        }
      }
      return normalizeProviderResult<TOutput>(providerResult as CapabilityProviderResult<TOutput>, {
        capabilityId,
        pluginId: registered.pluginId,
        pluginVersion: registered.pluginVersion,
        request,
        traceId,
        startedAt,
      });
    } catch (error) {
      const code = abortReason === "timeout" ? "timeout" : abortReason === "aborted" ? "aborted" : "provider-failed";
      return failureResult<TOutput>({
        capabilityId,
        pluginId: registered.pluginId,
        capabilityVersion: registered.pluginVersion,
        request,
        traceId,
        startedAt,
        status: "failed",
        error: { code, message: code === "timeout" ? `能力执行超过 ${timeoutMs}ms` : code === "aborted" ? "能力执行已取消" : compactError(error), retryable: true },
      });
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      request.signal?.removeEventListener("abort", abortFromCaller);
      if (abortListener) request.signal?.removeEventListener("abort", abortListener);
    }
  }
}

function validateProvider(provider: CapabilityProvider): string | undefined {
  if (!provider || typeof provider !== "object" || typeof provider.invoke !== "function") return "能力提供者必须包含 invoke 函数";
  const descriptor = provider.descriptor;
  if (!descriptor || !identifierPattern.test(descriptor.id)) return "能力 id 必须是小写命名空间标识";
  if (!semverPattern.test(descriptor.version)) return "能力版本必须是 semver";
  if (!descriptor.label.trim()) return "能力 label 不能为空";
  if (!Number.isSafeInteger(descriptor.timeoutMs) || descriptor.timeoutMs <= 0 || descriptor.timeoutMs > 3_600_000) return "能力 timeoutMs 必须在 1 至 3600000 之间";
  if (!Array.isArray(descriptor.permissions) || new Set(descriptor.permissions).size !== descriptor.permissions.length) return "能力 permissions 必须是无重复数组";
  if (!isCapabilitySchema(descriptor.inputSchema) || !isCapabilitySchema(descriptor.outputSchema)) return "能力输入输出 schema 必须是对象根 JSON Schema";
  return undefined;
}

function normalizeProviderResult<TOutput>(
  providerResult: CapabilityProviderResult<TOutput>,
  metadata: { capabilityId: string; pluginId: string; pluginVersion: string; request: CapabilityRequest; traceId: string; startedAt: number },
): CapabilityInvocationResult<TOutput> {
  if (
    !providerResult ||
    typeof providerResult !== "object" ||
    !isRunStatus(providerResult.status) ||
    !isDecisionStatus(providerResult.decisionStatus) ||
    (providerResult.confidence !== undefined && (!Number.isFinite(providerResult.confidence) || providerResult.confidence < 0 || providerResult.confidence > 1)) ||
    (providerResult.interval !== undefined &&
      (!Number.isFinite(providerResult.interval.low) || !Number.isFinite(providerResult.interval.high) || providerResult.interval.low > providerResult.interval.high))
  ) {
    return failureResult<TOutput>({
      capabilityId: metadata.capabilityId,
      pluginId: metadata.pluginId,
      capabilityVersion: metadata.pluginVersion,
      request: metadata.request,
      traceId: metadata.traceId,
      startedAt: metadata.startedAt,
      status: "failed",
      error: { code: "invalid-result", message: "能力提供者返回了无效结果", retryable: false },
    });
  }
  const result: CapabilityInvocationResult<TOutput> = {
    status: providerResult.status,
    capabilityId: metadata.capabilityId,
    pluginId: metadata.pluginId,
    capabilityVersion: metadata.pluginVersion,
    requestId: metadata.request.requestId,
    traceId: metadata.traceId,
    generatedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - metadata.startedAt),
    decisionStatus: providerResult.decisionStatus,
    evidence: cloneArray(providerResult.evidence),
    warnings: cloneArray(providerResult.warnings),
    suggestedActions: cloneArray(providerResult.suggestedActions),
  };
  if (providerResult.output !== undefined) result.output = providerResult.output;
  if (providerResult.confidence !== undefined) result.confidence = providerResult.confidence;
  if (providerResult.interval !== undefined) result.interval = { ...providerResult.interval };
  return result;
}

function failureResult<TOutput = unknown>(input: {
  capabilityId: string;
  pluginId?: string;
  capabilityVersion?: string;
  request: CapabilityRequest;
  traceId: string;
  startedAt: number;
  status: CapabilityRunStatus;
  error: CapabilityError;
}): CapabilityInvocationResult<TOutput> {
  return {
    status: input.status,
    capabilityId: input.capabilityId,
    pluginId: input.pluginId ?? "host",
    capabilityVersion: input.capabilityVersion ?? "0.0.0",
    requestId: input.request.requestId,
    traceId: input.traceId,
    generatedAt: new Date().toISOString(),
    durationMs: Math.max(0, Date.now() - input.startedAt),
    decisionStatus: "insufficient-data",
    evidence: [],
    warnings: [],
    suggestedActions: [],
    error: input.error,
  };
}

function cloneDescriptor(descriptor: CapabilityDescriptor): CapabilityDescriptor {
  return { ...descriptor, permissions: [...descriptor.permissions], inputSchema: structuredClone(descriptor.inputSchema), outputSchema: structuredClone(descriptor.outputSchema) };
}

function cloneArray<T>(value: readonly T[] | undefined): T[] {
  return value ? value.map((item) => structuredClone(item)) : [];
}

function isRunStatus(value: unknown): value is CapabilityRunStatus {
  return value === "completed" || value === "needs-input" || value === "blocked" || value === "unavailable" || value === "failed";
}

function isDecisionStatus(value: unknown): value is CapabilityDecisionStatus {
  return value === "production" || value === "shadow" || value === "research-candidate" || value === "insufficient-data";
}

function compactError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return typeof error === "string" && error.trim() ? error : "能力提供者执行失败";
}

function createTraceId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID) return randomUUID.call(globalThis.crypto);
  return `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
