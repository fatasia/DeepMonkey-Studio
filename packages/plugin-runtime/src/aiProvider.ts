import type { CapabilityExecution } from "./manifest.js";

export interface AiProviderDescriptor {
  id: string;
  version: string;
  label: string;
  execution: CapabilityExecution;
  permissions: string[];
  streaming: boolean;
  timeoutMs: number;
}

export interface AiProviderRequest {
  requestId: string;
  projectId?: string;
  principal: string;
  model: string;
  instructions: string;
  input: string;
  temperature: number;
  maxOutputTokens: number;
  /** Provider 私有配置由宿主注入，插件 Manifest 永远不保存密钥。 */
  config: Readonly<Record<string, unknown>>;
  signal?: AbortSignal;
}

export interface AiProviderCompletion {
  text: string;
  model: string;
  execution?: AiProviderExecution;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface AiProviderExecution {
  protocol: "responses" | "chat-completions";
  requestedModel: string;
  reportedModel?: string;
  reasoningEffortSent?: string;
  reasoningEffortReported?: string;
  servedBy?: "primary" | "fallback";
  failoverCategory?: string;
}

export type AiProviderStreamEvent =
  | { type: "delta"; delta: string }
  | { type: "model"; model: string }
  | { type: "execution"; execution: AiProviderExecution }
  | { type: "usage"; inputTokens?: number; outputTokens?: number };

export interface AiProviderContext {
  pluginId: string;
  pluginVersion: string;
  descriptor: AiProviderDescriptor;
  signal: AbortSignal;
}

export interface AiProvider {
  descriptor: AiProviderDescriptor;
  complete(request: AiProviderRequest, context: AiProviderContext): Promise<AiProviderCompletion>;
  stream?(request: AiProviderRequest, context: AiProviderContext): AsyncIterable<AiProviderStreamEvent>;
}

export type AiProviderRegistrationResult =
  | { ok: true; provider: AiProviderDescriptor }
  | { ok: false; code: "duplicate" | "invalid-provider" | "permission-denied"; message: string };

interface RegisteredProvider {
  pluginId: string;
  pluginVersion: string;
  provider: AiProvider;
}

const identifierPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/;

/** 管理 AI Provider 的注册、卸载、超时和取消，不包含任何厂商专有协议。 */
export class AiProviderRegistry {
  readonly #providers = new Map<string, RegisteredProvider>();

  register(provider: AiProvider, pluginId: string, pluginVersion: string, grantedPermissions: readonly string[]): AiProviderRegistrationResult {
    const issue = validateProvider(provider);
    if (issue) return { ok: false, code: "invalid-provider", message: issue };
    if (this.#providers.has(provider.descriptor.id)) return { ok: false, code: "duplicate", message: `AI provider ${provider.descriptor.id} 已注册` };
    const granted = new Set(grantedPermissions);
    const missing = provider.descriptor.permissions.filter((permission) => !granted.has(permission));
    if (missing.length > 0) return { ok: false, code: "permission-denied", message: `AI provider ${provider.descriptor.id} 缺少权限：${missing.join(",")}` };
    this.#providers.set(provider.descriptor.id, { pluginId, pluginVersion, provider });
    return { ok: true, provider: cloneDescriptor(provider.descriptor) };
  }

  unregisterPlugin(pluginId: string): void {
    for (const [providerId, registered] of this.#providers) if (registered.pluginId === pluginId) this.#providers.delete(providerId);
  }

  get(providerId: string): AiProviderDescriptor | undefined {
    const registered = this.#providers.get(providerId);
    return registered ? cloneDescriptor(registered.provider.descriptor) : undefined;
  }

  list(): AiProviderDescriptor[] {
    return [...this.#providers.values()].map(({ provider }) => cloneDescriptor(provider.descriptor)).sort((left, right) => left.id.localeCompare(right.id));
  }

  async complete(providerId: string, request: AiProviderRequest): Promise<AiProviderCompletion> {
    const registered = this.require(providerId);
    const execution = executionContext(registered, request);
    try {
      if (execution.controller.signal.aborted) throw abortError(execution.controller.signal);
      const result = await Promise.race([
        registered.provider.complete({ ...request, signal: execution.controller.signal }, execution.context),
        abortPromise(execution.controller.signal)
      ]);
      if (!result.text?.trim()) throw new Error(`AI provider ${providerId} 返回空内容`);
      return { ...result, text: result.text.trim() };
    } catch (error) {
      if (execution.controller.signal.aborted) throw abortError(execution.controller.signal);
      throw error;
    } finally {
      execution.dispose();
    }
  }

  async *stream(providerId: string, request: AiProviderRequest): AsyncIterable<AiProviderStreamEvent> {
    const registered = this.require(providerId);
    const execution = executionContext(registered, request);
    try {
      if (execution.controller.signal.aborted) throw abortError(execution.controller.signal);
      if (!registered.provider.stream) {
        const result = await registered.provider.complete({ ...request, signal: execution.controller.signal }, execution.context);
        if (result.model) yield { type: "model", model: result.model };
        if (result.execution) yield { type: "execution", execution: result.execution };
        if (result.text) yield { type: "delta", delta: result.text };
        return;
      }
      const iterator = registered.provider.stream({ ...request, signal: execution.controller.signal }, execution.context)[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await Promise.race([iterator.next(), abortPromise(execution.controller.signal)]);
          if (next.done) break;
          if (next.value.type === "delta" && !next.value.delta) continue;
          yield next.value;
        }
      } finally {
        await iterator.return?.();
      }
    } catch (error) {
      if (execution.controller.signal.aborted) throw abortError(execution.controller.signal);
      throw error;
    } finally {
      execution.dispose();
    }
  }

  private require(providerId: string): RegisteredProvider {
    const registered = this.#providers.get(providerId);
    if (!registered) throw new Error(`未注册 AI provider：${providerId}`);
    return registered;
  }
}

function executionContext(registered: RegisteredProvider, request: AiProviderRequest) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("AI provider 调用超时")), registered.provider.descriptor.timeoutMs);
  const abortFromCaller = () => controller.abort(request.signal?.reason);
  // 调用方可能在输入审计等异步前置步骤中已经取消；只监听未来事件会把取消误报成超时。
  if (request.signal?.aborted) abortFromCaller();
  else request.signal?.addEventListener("abort", abortFromCaller, { once: true });
  return {
    controller,
    context: {
      pluginId: registered.pluginId,
      pluginVersion: registered.pluginVersion,
      descriptor: cloneDescriptor(registered.provider.descriptor),
      signal: controller.signal
    },
    dispose() {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  };
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(abortError(signal));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("AI provider 调用已取消");
}

function validateProvider(provider: AiProvider): string | undefined {
  const descriptor = provider?.descriptor;
  if (!descriptor || typeof provider.complete !== "function") return "AI provider 必须包含 descriptor 和 complete";
  if (!identifierPattern.test(descriptor.id) || !semverPattern.test(descriptor.version)) return "AI provider ID 或版本无效";
  if (!descriptor.label.trim() || !Number.isSafeInteger(descriptor.timeoutMs) || descriptor.timeoutMs <= 0) return "AI provider 标签或超时无效";
  if (!Array.isArray(descriptor.permissions) || new Set(descriptor.permissions).size !== descriptor.permissions.length) return "AI provider 权限必须唯一";
  if (descriptor.streaming && typeof provider.stream !== "function") return "声明 streaming 的 AI provider 必须实现 stream";
  return undefined;
}

function cloneDescriptor(descriptor: AiProviderDescriptor): AiProviderDescriptor {
  return { ...descriptor, permissions: [...descriptor.permissions] };
}
