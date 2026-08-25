import {
  SCENE_CAPABILITIES,
  SCENE_PERMISSIONS,
  resolveSceneExtensionCompatibility,
  type SceneCapability,
  type SceneHostKind,
  type ScenePermission,
  type SceneRendererKind
} from "@bim-studio/scene-sdk";
import {
  type PluginExtensionPointKind,
  type PluginManifestIssue,
  type PluginManifestV1,
  validatePluginManifest
} from "./manifest.js";

export interface PluginHostPolicy {
  /** Platform plugin API, negotiated against PluginManifestV1.apiVersion. */
  apiVersion: string;
  /** Scene SDK API, negotiated independently for scene.extension declarations. */
  sceneApiVersion: string;
  host: SceneHostKind;
  renderer: SceneRendererKind;
  capabilities: string[];
  permissions: string[];
  extensionPoints: PluginExtensionPointKind[];
  allowTrustedSceneExtensions: boolean;
}

export const PLUGIN_COMPATIBILITY_REASON_CODES = [
  "invalid-manifest",
  "invalid-host-policy",
  "plugin-api-major-mismatch",
  "plugin-api-minor-unsupported",
  "host-unsupported",
  "extension-point-unsupported",
  "capability-unsupported",
  "permission-denied",
  "scene-extension-incompatible"
] as const;

export type PluginCompatibilityReasonCode = typeof PLUGIN_COMPATIBILITY_REASON_CODES[number];

export interface PluginCompatibilityReason {
  code: PluginCompatibilityReasonCode;
  detail: string;
}

export type PluginCompatibility =
  | { compatible: true; manifest: PluginManifestV1; reasons: [] }
  | { compatible: false; reasons: PluginCompatibilityReason[]; manifest?: PluginManifestV1 };

export function resolvePluginCompatibility(input: unknown, host: PluginHostPolicy): PluginCompatibility {
  const validation = validatePluginManifest(input);
  if (!validation.valid) {
    return {
      compatible: false,
      reasons: [{ code: "invalid-manifest", detail: formatIssues(validation.issues) }]
    };
  }
  const manifest = validation.manifest;
  const hostIssues = validateHostPolicy(host);
  if (hostIssues.length > 0) {
    return {
      compatible: false,
      manifest,
      reasons: [{ code: "invalid-host-policy", detail: hostIssues.join(",") }]
    };
  }

  const reasons: PluginCompatibilityReason[] = [];
  const pluginApi = parseApiVersion(manifest.apiVersion)!;
  const hostApi = parseApiVersion(host.apiVersion)!;
  if (pluginApi.major !== hostApi.major) {
    reasons.push({ code: "plugin-api-major-mismatch", detail: `plugin ${manifest.apiVersion}, host ${host.apiVersion}` });
  } else if (pluginApi.minor > hostApi.minor) {
    reasons.push({ code: "plugin-api-minor-unsupported", detail: `plugin ${manifest.apiVersion}, host ${host.apiVersion}` });
  }

  if (!manifest.hosts.includes(host.host)) reasons.push({ code: "host-unsupported", detail: host.host });
  appendMissing(reasons, manifest.extensionPoints.map((point) => point.kind), host.extensionPoints, "extension-point-unsupported");
  appendMissing(reasons, manifest.capabilities, host.capabilities, "capability-unsupported");
  appendMissing(reasons, manifest.permissions, host.permissions, "permission-denied");

  const sceneHost = {
    apiVersion: host.sceneApiVersion,
    host: host.host,
    renderer: host.renderer,
    capabilities: filterKnownValues(host.capabilities, SCENE_CAPABILITIES),
    permissions: filterKnownValues(host.permissions, SCENE_PERMISSIONS),
    allowTrustedExtensions: host.allowTrustedSceneExtensions
  };
  for (const point of manifest.extensionPoints) {
    if (point.kind !== "scene.extension") continue;
    const result = resolveSceneExtensionCompatibility(point.manifest, sceneHost);
    for (const reason of result.reasons) {
      reasons.push({
        code: "scene-extension-incompatible",
        detail: `${point.id}:${reason.code}:${reason.detail}`
      });
    }
  }

  if (reasons.length > 0) return { compatible: false, manifest, reasons };
  return { compatible: true, manifest, reasons: [] };
}

function appendMissing(
  reasons: PluginCompatibilityReason[],
  requested: readonly string[],
  supported: readonly string[],
  code: "extension-point-unsupported" | "capability-unsupported" | "permission-denied"
): void {
  const supportedSet = new Set(supported);
  const missing = [...new Set(requested.filter((value) => !supportedSet.has(value)))].sort();
  if (missing.length > 0) reasons.push({ code, detail: missing.join(",") });
}

function filterKnownValues<T extends string>(values: readonly string[], known: readonly T[]): T[] {
  const knownSet = new Set<string>(known);
  return [...new Set(values.filter((value): value is T => knownSet.has(value)))];
}

function validateHostPolicy(host: PluginHostPolicy): string[] {
  const issues: string[] = [];
  if (!parseApiVersion(host.apiVersion)) issues.push("apiVersion");
  if (!parseApiVersion(host.sceneApiVersion)) issues.push("sceneApiVersion");
  if (host.host !== "browser" && host.host !== "tauri" && host.host !== "cloud") issues.push("host");
  if (host.renderer !== "webgl2" && host.renderer !== "webgpu") issues.push("renderer");
  if (!isUniqueStringArray(host.capabilities)) issues.push("capabilities");
  if (!isUniqueStringArray(host.permissions)) issues.push("permissions");
  if (!Array.isArray(host.extensionPoints) || new Set(host.extensionPoints).size !== host.extensionPoints.length) issues.push("extensionPoints");
  if (typeof host.allowTrustedSceneExtensions !== "boolean") issues.push("allowTrustedSceneExtensions");
  return issues.sort();
}

function isUniqueStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") && new Set(value).size === value.length;
}

function parseApiVersion(value: unknown): { major: bigint; minor: bigint } | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  return { major: BigInt(match[1]!), minor: BigInt(match[2]!) };
}

function formatIssues(issues: PluginManifestIssue[]): string {
  return issues.map((item) => `${item.path}:${item.code}`).join(",");
}
