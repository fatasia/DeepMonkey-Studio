import { resolvePluginCompatibility, type PluginCompatibilityReason, type PluginHostPolicy } from "./compatibility.js";
import type { PluginManifestV1 } from "./manifest.js";

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
        signal: controller.signal
      });
      if (instance) record.instance = instance;
      else delete record.instance;
      record.status = "enabled";
      return { ok: true, code: "ok", plugin: snapshot(record) };
    } catch (error) {
      controller.abort();
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
      delete record.instance;
      delete record.controller;
      record.status = "registered";
      return { ok: true, code: "ok", plugin: snapshot(record) };
    } catch (error) {
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
    }
    this.#records.delete(pluginId);
    return warning ? { ok: true, code: "ok", warning } : { ok: true, code: "ok" };
  }

  public async enableAll(): Promise<PluginOperationResult[]> {
    return Promise.all(this.list().map((record) => this.enable(record.manifest.id)));
  }
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
