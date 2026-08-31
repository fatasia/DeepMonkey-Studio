import { resolvePluginCompatibility, type PluginCompatibilityReason, type PluginHostPolicy } from "./compatibility.js";
import {
  CapabilityRegistry,
  type CapabilityDescriptor,
  type CapabilityProvider,
  type CapabilityRegistrationResult,
  type CapabilityRequest,
  type CapabilityInvocationResult
} from "./capability.js";
import type { PluginManifestV1 } from "./manifest.js";
import {
  AiProviderRegistry,
  type AiProvider,
  type AiProviderCompletion,
  type AiProviderDescriptor,
  type AiProviderRegistrationResult,
  type AiProviderRequest,
  type AiProviderStreamEvent
} from "./aiProvider.js";

export type PluginRuntimeStatus = "registered" | "enabling" | "enabled" | "disabling" | "faulted";
export type PluginOperationCode = "ok" | "not-found" | "already-registered" | "invalid-state" | "incompatible" | "activation-failed" | "deactivation-failed";

export interface PluginDiagnostic {
  operation: "enable" | "disable" | "uninstall";
  message: string;
  timestamp: string;
}

export interface PluginRecordSnapshot {
  manifest: PluginManifestV1;
  status: PluginRuntimeStatus;
  diagnostics: PluginDiagnostic[];
}

export interface PluginActivationContext {
  pluginId: string;
  pluginVersion: string;
  host: PluginHostPolicy["host"];
  renderer: PluginHostPolicy["renderer"];
  grantedCapabilities: readonly string[];
  grantedPermissions: readonly string[];
  signal: AbortSignal;
  /** Register only the capabilities declared by this plugin's manifest. */
  registerCapability(provider: CapabilityProvider): CapabilityRegistrationResult;
  /** Register only the AI providers declared by this plugin's manifest. */
  registerAiProvider(provider: AiProvider): AiProviderRegistrationResult;
}

export interface PluginInstance {
  deactivate?(): void | Promise<void>;
}

/** A factory for code that the host already resolved and installed locally. */
export type InstalledPluginFactory = (context: PluginActivationContext) => void | PluginInstance | Promise<void | PluginInstance>;

export type PluginOperationResult =
  | { ok: true; code: "ok"; plugin?: PluginRecordSnapshot; warning?: PluginDiagnostic }
  | { ok: false; code: Exclude<PluginOperationCode, "ok">; message: string; reasons?: PluginCompatibilityReason[]; plugin?: PluginRecordSnapshot };

interface PluginRecord {
  manifest: PluginManifestV1;
  factory: InstalledPluginFactory;
  status: PluginRuntimeStatus;
  instance?: PluginInstance;
  controller?: AbortController;
  diagnostics: PluginDiagnostic[];
}

/**
 * Coordinates pre-installed plugin factories. It never downloads, imports or evaluates code.
 * A plugin failure is converted to a local result and does not escape into other plugins.
 */
export class PluginRegistry {
  readonly #records = new Map<string, PluginRecord>();
  readonly #hostPolicy: PluginHostPolicy;
  readonly #capabilityRegistry = new CapabilityRegistry();
  readonly #aiProviderRegistry = new AiProviderRegistry();

  public constructor(hostPolicy: PluginHostPolicy) {
    this.#hostPolicy = cloneHostPolicy(hostPolicy);
  }

  public register(manifestInput: unknown, factory: InstalledPluginFactory): PluginOperationResult {
    const compatibility = resolvePluginCompatibility(manifestInput, this.#hostPolicy);
    if (!compatibility.manifest) {
      return { ok: false, code: "incompatible", message: "plugin manifest is invalid", reasons: compatibility.reasons };
    }
    const manifest = cloneManifest(compatibility.manifest);
    if (this.#records.has(manifest.id)) return { ok: false, code: "already-registered", message: `plugin ${manifest.id} is already registered` };
    const record: PluginRecord = { manifest, factory, status: "registered", diagnostics: [] };
    this.#records.set(manifest.id, record);
    if (!compatibility.compatible) {
      return { ok: false, code: "incompatible", message: `plugin ${manifest.id} is not compatible with this host`, reasons: compatibility.reasons, plugin: snapshot(record) };
    }
    return { ok: true, code: "ok", plugin: snapshot(record) };
  }

  public get(pluginId: string): PluginRecordSnapshot | undefined {
    const record = this.#records.get(pluginId);
    return record ? snapshot(record) : undefined;
  }

  public list(): PluginRecordSnapshot[] {
    return [...this.#records.values()].map(snapshot).sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  }

  public listCapabilities(): CapabilityDescriptor[] {
    return this.#capabilityRegistry.list();
  }

  public getCapability(capabilityId: string): CapabilityDescriptor | undefined {
    return this.#capabilityRegistry.get(capabilityId);
  }

  public invokeCapability<TOutput = unknown>(capabilityId: string, request: CapabilityRequest, options?: { timeoutMs?: number; traceId?: string }): Promise<CapabilityInvocationResult<TOutput>> {
    return this.#capabilityRegistry.invoke<TOutput>(capabilityId, request, options);
  }

  public listAiProviders(): AiProviderDescriptor[] {
    return this.#aiProviderRegistry.list();
  }

  public getAiProvider(providerId: string): AiProviderDescriptor | undefined {
    return this.#aiProviderRegistry.get(providerId);
  }

  public invokeAiProvider(providerId: string, request: AiProviderRequest): Promise<AiProviderCompletion> {
    return this.#aiProviderRegistry.complete(providerId, request);
  }

  public streamAiProvider(providerId: string, request: AiProviderRequest): AsyncIterable<AiProviderStreamEvent> {
    return this.#aiProviderRegistry.stream(providerId, request);
  }

  public async enable(pluginId: string): Promise<PluginOperationResult> {
    const record = this.#records.get(pluginId);
    if (!record) return notFound(pluginId);
    if (record.status === "enabled") return { ok: true, code: "ok", plugin: snapshot(record) };
    if (record.status === "enabling" || record.status === "disabling") return invalidState(record, "enable");
    const compatibility = resolvePluginCompatibility(record.manifest, this.#hostPolicy);
    if (!compatibility.compatible) {
      return { ok: false, code: "incompatible", message: `plugin ${pluginId} is not compatible with this host`, reasons: compatibility.reasons, plugin: snapshot(record) };
    }

    record.status = "enabling";
    const controller = new AbortController();
    record.controller = controller;
    try {
      const instance = await record.factory({
        pluginId: record.manifest.id,
        pluginVersion: record.manifest.version,
        host: this.#hostPolicy.host,
        renderer: this.#hostPolicy.renderer,
        grantedCapabilities: Object.freeze([...record.manifest.capabilities]),
        grantedPermissions: Object.freeze([...record.manifest.permissions]),
        signal: controller.signal,
        registerCapability: (provider) => {
          if (!declaresCapability(record.manifest, provider.descriptor.id)) {
            throw new Error(`插件 ${record.manifest.id} 未在 manifest 声明能力 ${provider.descriptor.id}`);
          }
          return this.#capabilityRegistry.register(provider, record.manifest.id, record.manifest.version, record.manifest.permissions);
        },
        registerAiProvider: (provider) => {
          if (!declaresAiProvider(record.manifest, provider.descriptor.id)) {
            throw new Error(`插件 ${record.manifest.id} 未在 manifest 声明 AI provider ${provider.descriptor.id}`);
          }
          return this.#aiProviderRegistry.register(provider, record.manifest.id, record.manifest.version, record.manifest.permissions);
        }
      });
      if (instance) record.instance = instance;
      else delete record.instance;
      record.status = "enabled";
      return { ok: true, code: "ok", plugin: snapshot(record) };
    } catch (error) {
      controller.abort();
      this.#capabilityRegistry.unregisterPlugin(record.manifest.id);
      this.#aiProviderRegistry.unregisterPlugin(record.manifest.id);
      delete record.controller;
      delete record.instance;
      record.status = "faulted";
      const diagnostic = appendDiagnostic(record, "enable", error);
      return { ok: false, code: "activation-failed", message: diagnostic.message, plugin: snapshot(record) };
    }
  }

  public async disable(pluginId: string): Promise<PluginOperationResult> {
    const record = this.#records.get(pluginId);
    if (!record) return notFound(pluginId);
    if (record.status === "registered") return { ok: true, code: "ok", plugin: snapshot(record) };
    if (record.status === "enabling" || record.status === "disabling") return invalidState(record, "disable");
    if (record.status === "faulted" && !record.instance) {
      record.status = "registered";
      return { ok: true, code: "ok", plugin: snapshot(record) };
    }

    record.status = "disabling";
    record.controller?.abort();
    try {
      await record.instance?.deactivate?.();
      this.#capabilityRegistry.unregisterPlugin(record.manifest.id);
      this.#aiProviderRegistry.unregisterPlugin(record.manifest.id);
      delete record.instance;
      delete record.controller;
      record.status = "registered";
      return { ok: true, code: "ok", plugin: snapshot(record) };
    } catch (error) {
      this.#capabilityRegistry.unregisterPlugin(record.manifest.id);
      this.#aiProviderRegistry.unregisterPlugin(record.manifest.id);
      delete record.instance;
      delete record.controller;
      record.status = "faulted";
      const diagnostic = appendDiagnostic(record, "disable", error);
      return { ok: false, code: "deactivation-failed", message: diagnostic.message, plugin: snapshot(record) };
    }
  }

  public async uninstall(pluginId: string): Promise<PluginOperationResult> {
    const record = this.#records.get(pluginId);
    if (!record) return notFound(pluginId);
    if (record.status === "enabling" || record.status === "disabling") return invalidState(record, "uninstall");

    let warning: PluginDiagnostic | undefined;
    if (record.status === "enabled" || record.instance) {
      record.controller?.abort();
      try {
        await record.instance?.deactivate?.();
      } catch (error) {
        warning = appendDiagnostic(record, "uninstall", error);
      }
      this.#capabilityRegistry.unregisterPlugin(record.manifest.id);
      this.#aiProviderRegistry.unregisterPlugin(record.manifest.id);
    }
    this.#records.delete(pluginId);
    return warning ? { ok: true, code: "ok", warning } : { ok: true, code: "ok" };
  }

  public async enableAll(): Promise<PluginOperationResult[]> {
    return Promise.all(this.list().map((record) => this.enable(record.manifest.id)));
  }
}

function declaresCapability(manifest: PluginManifestV1, capabilityId: string): boolean {
  return manifest.extensionPoints.some((point) => point.kind === "capability.provider" && point.capabilityIds.includes(capabilityId));
}

function declaresAiProvider(manifest: PluginManifestV1, providerId: string): boolean {
  return manifest.extensionPoints.some((point) => point.kind === "ai.provider" && point.providerIds.includes(providerId));
}

function snapshot(record: PluginRecord): PluginRecordSnapshot {
  return {
    manifest: cloneManifest(record.manifest),
    status: record.status,
    diagnostics: record.diagnostics.map((item) => ({ ...item }))
  };
}

function cloneManifest(manifest: PluginManifestV1): PluginManifestV1 {
  return structuredClone(manifest);
}

function cloneHostPolicy(policy: PluginHostPolicy): PluginHostPolicy {
  return {
    ...policy,
    capabilities: [...policy.capabilities],
    permissions: [...policy.permissions],
    extensionPoints: [...policy.extensionPoints]
  };
}

function appendDiagnostic(record: PluginRecord, operation: PluginDiagnostic["operation"], error: unknown): PluginDiagnostic {
  const diagnostic = { operation, message: errorMessage(error), timestamp: new Date().toISOString() };
  record.diagnostics.push(diagnostic);
  if (record.diagnostics.length > 50) record.diagnostics.splice(0, record.diagnostics.length - 50);
  return { ...diagnostic };
}

function notFound(pluginId: string): PluginOperationResult {
  return { ok: false, code: "not-found", message: `plugin ${pluginId} is not registered` };
}

function invalidState(record: PluginRecord, operation: string): PluginOperationResult {
  return { ok: false, code: "invalid-state", message: `cannot ${operation} plugin ${record.manifest.id} while ${record.status}`, plugin: snapshot(record) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "plugin operation failed";
}
