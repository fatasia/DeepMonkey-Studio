import type { SceneExtensionManifest, SceneHostKind, SceneRendererKind } from "@bim-studio/scene-sdk";

export const PLUGIN_API_VERSION = "1.0" as const;
export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1 as const;

export const PLUGIN_EXTENSION_POINT_KINDS = [
  "editor.panel",
  "scene.extension",
  "converter.plugin",
  "capability.provider",
  "ai.provider"
] as const;

export type PluginExtensionPointKind = typeof PLUGIN_EXTENSION_POINT_KINDS[number];
export type EditorPanelPlacement = "left" | "right" | "bottom" | "modal";
export type ConverterExecution = "server-worker" | "tauri-sidecar";
export type CapabilityExecution = "in-process" | "worker";

export interface EditorPanelExtensionPoint {
  kind: "editor.panel";
  id: string;
  title: string;
  placement: EditorPanelPlacement;
  order?: number;
}

export interface SceneExtensionPoint {
  kind: "scene.extension";
  id: string;
  manifest: SceneExtensionManifest;
}

export interface ConverterPluginExtensionPoint {
  kind: "converter.plugin";
  id: string;
  inputExtensions: string[];
  inputMediaTypes: string[];
  outputFormat: string;
  outputMediaType: string;
  execution: ConverterExecution;
  limits: {
    timeoutMs: number;
    maxInputBytes: number;
    memoryMb: number;
  };
}

/**
 * Declares a typed domain capability exposed by a plugin.
 * The implementation is registered at activation time, so the manifest remains
 * serializable and never contains executable code.
 */
export interface CapabilityProviderExtensionPoint {
  kind: "capability.provider";
  id: string;
  capabilityIds: string[];
  execution: CapabilityExecution;
  limits: {
    timeoutMs: number;
    maxInputBytes: number;
    memoryMb: number;
  };
}

/** 声明插件可提供的可替换大模型运行时；密钥和地址属于宿主配置，不写入 Manifest。 */
export interface AiProviderExtensionPoint {
  kind: "ai.provider";
  id: string;
  providerIds: string[];
  execution: CapabilityExecution;
  limits: {
    timeoutMs: number;
    maxInputBytes: number;
    memoryMb: number;
  };
}

export type PluginExtensionPoint =
  | EditorPanelExtensionPoint
  | SceneExtensionPoint
  | ConverterPluginExtensionPoint
  | CapabilityProviderExtensionPoint
  | AiProviderExtensionPoint;

/**
 * Serializable metadata for an already-installed plugin bundle.
 * It intentionally contains no URL or executable source field: resolving, downloading,
 * signing and storing plugin artifacts are separate deployment concerns.
 */
export interface PluginManifestV1 {
  schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  id: string;
  name: string;
  version: string;
  apiVersion: string;
  hosts: SceneHostKind[];
  capabilities: string[];
  permissions: string[];
  extensionPoints: PluginExtensionPoint[];
}

export type PluginManifestIssueCode =
  | "unknown-field"
  | "invalid-type"
  | "invalid-value"
  | "duplicate-value";

export interface PluginManifestIssue {
  path: string;
  code: PluginManifestIssueCode;
  message: string;
}

export type PluginManifestValidation =
  | { valid: true; manifest: PluginManifestV1; issues: [] }
  | { valid: false; issues: PluginManifestIssue[] };

const identifierPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const tokenPattern = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)+$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const apiVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const extensionPattern = /^[a-z0-9][a-z0-9._+-]{0,31}$/;
const mediaTypePattern = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;
const localEntryPattern = /^(?:\.\/)?[A-Za-z0-9_@][A-Za-z0-9_@./-]*$/;

const topLevelFields = new Set(["schemaVersion", "id", "name", "version", "apiVersion", "hosts", "capabilities", "permissions", "extensionPoints"]);
const editorPanelFields = new Set(["kind", "id", "title", "placement", "order"]);
const sceneExtensionFields = new Set(["kind", "id", "manifest"]);
const converterFields = new Set(["kind", "id", "inputExtensions", "inputMediaTypes", "outputFormat", "outputMediaType", "execution", "limits"]);
const capabilityProviderFields = new Set(["kind", "id", "capabilityIds", "execution", "limits"]);
const aiProviderFields = new Set(["kind", "id", "providerIds", "execution", "limits"]);
const sceneManifestFields = new Set(["id", "name", "version", "apiVersion", "entry", "execution", "capabilities", "permissions", "hosts", "renderers", "lifecycle"]);
const sceneHosts = new Set<SceneHostKind>(["browser", "tauri", "cloud"]);
const renderers = new Set<SceneRendererKind>(["webgl2", "webgpu"]);
const sceneLifecycles = new Set(["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent", "onStop", "onDispose"]);

export function validatePluginManifest(input: unknown): PluginManifestValidation {
  const issues: PluginManifestIssue[] = [];
  if (!isRecord(input)) {
    return { valid: false, issues: [issue("$", "invalid-type", "manifest must be an object")] };
  }

  rejectUnknownFields(input, topLevelFields, "$", issues);
  if (input.schemaVersion !== PLUGIN_MANIFEST_SCHEMA_VERSION) issues.push(issue("$.schemaVersion", "invalid-value", "schemaVersion must be 1"));
  validateIdentifier(input.id, "$.id", issues);
  validateNonEmptyString(input.name, "$.name", issues, 120);
  validatePattern(input.version, "$.version", semverPattern, "version must be semantic version major.minor.patch", issues);
  validatePattern(input.apiVersion, "$.apiVersion", apiVersionPattern, "apiVersion must be major.minor", issues);
  validateEnumArray(input.hosts, "$.hosts", sceneHosts, issues);
  validateTokenArray(input.capabilities, "$.capabilities", issues);
  validateTokenArray(input.permissions, "$.permissions", issues);

  if (!Array.isArray(input.extensionPoints) || input.extensionPoints.length === 0) {
    issues.push(issue("$.extensionPoints", "invalid-value", "extensionPoints must be a non-empty array"));
  } else {
    const ids = new Set<string>();
    input.extensionPoints.forEach((point, index) => {
      const path = `$.extensionPoints[${index}]`;
      validateExtensionPoint(point, path, issues);
      if (isRecord(point) && typeof point.id === "string") {
        if (ids.has(point.id)) issues.push(issue(`${path}.id`, "duplicate-value", `duplicate extension point id ${point.id}`));
        ids.add(point.id);
      }
    });
  }

  if (issues.length > 0) return { valid: false, issues };
  return { valid: true, manifest: input as unknown as PluginManifestV1, issues: [] };
}

function validateExtensionPoint(value: unknown, path: string, issues: PluginManifestIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid-type", "extension point must be an object"));
    return;
  }
  validateIdentifier(value.id, `${path}.id`, issues);
  if (value.kind === "editor.panel") {
    rejectUnknownFields(value, editorPanelFields, path, issues);
    validateNonEmptyString(value.title, `${path}.title`, issues, 120);
    if (value.placement !== "left" && value.placement !== "right" && value.placement !== "bottom" && value.placement !== "modal") {
      issues.push(issue(`${path}.placement`, "invalid-value", "unsupported editor panel placement"));
    }
    if (value.order !== undefined && (!Number.isSafeInteger(value.order) || (value.order as number) < -10_000 || (value.order as number) > 10_000)) {
      issues.push(issue(`${path}.order`, "invalid-value", "order must be an integer from -10000 to 10000"));
    }
    return;
  }
  if (value.kind === "scene.extension") {
    rejectUnknownFields(value, sceneExtensionFields, path, issues);
    validateSceneExtension(value.manifest, `${path}.manifest`, issues);
    return;
  }
  if (value.kind === "converter.plugin") {
    rejectUnknownFields(value, converterFields, path, issues);
    validateConverter(value, path, issues);
    return;
  }
  if (value.kind === "capability.provider") {
    rejectUnknownFields(value, capabilityProviderFields, path, issues);
    validatePatternArray(value.capabilityIds, `${path}.capabilityIds`, identifierPattern, issues);
    if (value.execution !== "in-process" && value.execution !== "worker") {
      issues.push(issue(`${path}.execution`, "invalid-value", "unsupported capability execution mode"));
    }
    validateLimits(value, path, issues);
    return;
  }
  if (value.kind === "ai.provider") {
    rejectUnknownFields(value, aiProviderFields, path, issues);
    validatePatternArray(value.providerIds, `${path}.providerIds`, identifierPattern, issues);
    if (value.execution !== "in-process" && value.execution !== "worker") {
      issues.push(issue(`${path}.execution`, "invalid-value", "unsupported AI provider execution mode"));
    }
    validateLimits(value, path, issues);
    return;
  }
  issues.push(issue(`${path}.kind`, "invalid-value", "unsupported extension point kind"));
}

function validateSceneExtension(value: unknown, path: string, issues: PluginManifestIssue[]): void {
  if (!isRecord(value)) {
    issues.push(issue(path, "invalid-type", "scene extension manifest must be an object"));
    return;
  }
  rejectUnknownFields(value, sceneManifestFields, path, issues);
  validateIdentifier(value.id, `${path}.id`, issues);
  validateNonEmptyString(value.name, `${path}.name`, issues, 120);
  validatePattern(value.version, `${path}.version`, semverPattern, "version must be semantic version major.minor.patch", issues);
  validatePattern(value.apiVersion, `${path}.apiVersion`, apiVersionPattern, "apiVersion must be major.minor", issues);
  validatePattern(value.entry, `${path}.entry`, localEntryPattern, "entry must be a local installed module identifier", issues);
  if (value.execution !== "worker-sandbox" && value.execution !== "trusted-main-thread") issues.push(issue(`${path}.execution`, "invalid-value", "unsupported scene execution mode"));
  validateTokenArray(value.capabilities, `${path}.capabilities`, issues);
  validateTokenArray(value.permissions, `${path}.permissions`, issues);
  validateEnumArray(value.hosts, `${path}.hosts`, sceneHosts, issues);
  validateEnumArray(value.renderers, `${path}.renderers`, renderers, issues);
  validateEnumArray(value.lifecycle, `${path}.lifecycle`, sceneLifecycles, issues, true);
}

function validateConverter(value: Record<string, unknown>, path: string, issues: PluginManifestIssue[]): void {
  validatePatternArray(value.inputExtensions, `${path}.inputExtensions`, extensionPattern, issues);
  validatePatternArray(value.inputMediaTypes, `${path}.inputMediaTypes`, mediaTypePattern, issues);
  validatePattern(value.outputFormat, `${path}.outputFormat`, extensionPattern, "invalid output format", issues);
  validatePattern(value.outputMediaType, `${path}.outputMediaType`, mediaTypePattern, "invalid output media type", issues);
  if (value.execution !== "server-worker" && value.execution !== "tauri-sidecar") issues.push(issue(`${path}.execution`, "invalid-value", "unsupported converter execution mode"));
  validateLimits(value, path, issues);
}

function validateLimits(value: Record<string, unknown>, path: string, issues: PluginManifestIssue[]): void {
  if (!isRecord(value.limits)) {
    issues.push(issue(`${path}.limits`, "invalid-type", "limits must be an object"));
    return;
  }
  rejectUnknownFields(value.limits, new Set(["timeoutMs", "maxInputBytes", "memoryMb"]), `${path}.limits`, issues);
  validatePositiveInteger(value.limits.timeoutMs, `${path}.limits.timeoutMs`, 60 * 60 * 1000, issues);
  validatePositiveInteger(value.limits.maxInputBytes, `${path}.limits.maxInputBytes`, Number.MAX_SAFE_INTEGER, issues);
  validatePositiveInteger(value.limits.memoryMb, `${path}.limits.memoryMb`, 1024 * 64, issues);
}

function validateIdentifier(value: unknown, path: string, issues: PluginManifestIssue[]): void {
  validatePattern(value, path, identifierPattern, "identifier must be a lowercase namespaced token", issues);
}

function validateNonEmptyString(value: unknown, path: string, issues: PluginManifestIssue[], maxLength: number): void {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength) issues.push(issue(path, "invalid-value", `must be a non-empty string up to ${maxLength} characters`));
}

function validatePattern(value: unknown, path: string, pattern: RegExp, message: string, issues: PluginManifestIssue[]): void {
  if (typeof value !== "string" || !pattern.test(value)) issues.push(issue(path, "invalid-value", message));
}

function validateTokenArray(value: unknown, path: string, issues: PluginManifestIssue[]): void {
  validatePatternArray(value, path, tokenPattern, issues, true);
}

function validatePatternArray(value: unknown, path: string, pattern: RegExp, issues: PluginManifestIssue[], allowEmpty = false): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    issues.push(issue(path, "invalid-value", allowEmpty ? "must be an array" : "must be a non-empty array"));
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "string" || !pattern.test(item)) issues.push(issue(`${path}[${index}]`, "invalid-value", "invalid token"));
    else if (seen.has(item)) issues.push(issue(`${path}[${index}]`, "duplicate-value", `duplicate value ${item}`));
    else seen.add(item);
  });
}

function validateEnumArray<T extends string>(value: unknown, path: string, allowed: Set<T>, issues: PluginManifestIssue[], allowEmpty = false): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    issues.push(issue(path, "invalid-value", allowEmpty ? "must be an array" : "must be a non-empty array"));
    return;
  }
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "string" || !allowed.has(item as T)) issues.push(issue(`${path}[${index}]`, "invalid-value", "unsupported value"));
    else if (seen.has(item)) issues.push(issue(`${path}[${index}]`, "duplicate-value", `duplicate value ${item}`));
    else seen.add(item);
  });
}

function validatePositiveInteger(value: unknown, path: string, max: number, issues: PluginManifestIssue[]): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > max) issues.push(issue(path, "invalid-value", `must be a positive integer no greater than ${max}`));
}

function rejectUnknownFields(value: Record<string, unknown>, allowed: Set<string>, path: string, issues: PluginManifestIssue[]): void {
  for (const key of Object.keys(value).sort()) if (!allowed.has(key)) issues.push(issue(`${path}.${key}`, "unknown-field", `unknown field ${key}`));
}

function issue(path: string, code: PluginManifestIssueCode, message: string): PluginManifestIssue {
  return { path, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
