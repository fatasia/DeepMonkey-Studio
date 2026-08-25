import type {
  SceneCapability,
  SceneExtensionExecution,
  SceneHostKind,
  ScenePermission,
  SceneRendererKind
} from "./protocol.js";

export interface SceneHostCapabilities {
  apiVersion: string;
  host: SceneHostKind;
  renderer: SceneRendererKind;
  capabilities: SceneCapability[];
  permissions: ScenePermission[];
  allowTrustedExtensions: boolean;
}

export const SCENE_EXTENSION_COMPATIBILITY_REASON_CODES = [
  "invalid-api-version",
  "api-major-mismatch",
  "api-minor-unsupported",
  "host-unsupported",
  "renderer-unsupported",
  "invalid-execution",
  "trusted-extension-disabled",
  "capability-unsupported",
  "permission-denied"
] as const;

export type SceneExtensionCompatibilityReasonCode = typeof SCENE_EXTENSION_COMPATIBILITY_REASON_CODES[number];

export interface SceneExtensionCompatibilityReason {
  code: SceneExtensionCompatibilityReasonCode;
  detail: string;
}

export interface SceneExtensionCompatibility {
  compatible: boolean;
  reasons: SceneExtensionCompatibilityReason[];
}

interface ApiVersion {
  major: bigint;
  minor: bigint;
}

/**
 * Negotiates external manifest data without trusting its runtime shape.
 * This is a compatibility check, not a plugin loader or a full manifest validator.
 */
export function resolveSceneExtensionCompatibility(
  manifest: unknown,
  hostCapabilities: unknown
): SceneExtensionCompatibility {
  const reasons: SceneExtensionCompatibilityReason[] = [];
  const extensionApiVersionValue = readProperty(manifest, "apiVersion");
  const hostApiVersionValue = readProperty(hostCapabilities, "apiVersion");
  const extensionApiVersion = parseApiVersion(extensionApiVersionValue);
  const hostApiVersion = parseApiVersion(hostApiVersionValue);

  if (!extensionApiVersion || !hostApiVersion) {
    const invalidVersions = [
      ...(!extensionApiVersion ? [`extension apiVersion ${formatExternalValue(extensionApiVersionValue)}`] : []),
      ...(!hostApiVersion ? [`host apiVersion ${formatExternalValue(hostApiVersionValue)}`] : [])
    ];
    reasons.push({ code: "invalid-api-version", detail: invalidVersions.join(", ") });
  } else if (extensionApiVersion.major !== hostApiVersion.major) {
    reasons.push({
      code: "api-major-mismatch",
      detail: `extension ${String(extensionApiVersionValue)} is incompatible with host ${String(hostApiVersionValue)}`
    });
  } else if (extensionApiVersion.minor > hostApiVersion.minor) {
    reasons.push({
      code: "api-minor-unsupported",
      detail: `extension ${String(extensionApiVersionValue)} requires a newer minor than host ${String(hostApiVersionValue)}`
    });
  }

  const extensionHosts = readStringArray(manifest, "hosts");
  const hostKind = readProperty(hostCapabilities, "host");
  if (!extensionHosts || typeof hostKind !== "string" || !extensionHosts.includes(hostKind)) {
    reasons.push({ code: "host-unsupported", detail: formatExternalValue(hostKind) });
  }

  const extensionRenderers = readStringArray(manifest, "renderers");
  const rendererKind = readProperty(hostCapabilities, "renderer");
  if (!extensionRenderers || typeof rendererKind !== "string" || !extensionRenderers.includes(rendererKind)) {
    reasons.push({ code: "renderer-unsupported", detail: formatExternalValue(rendererKind) });
  }

  const execution = readProperty(manifest, "execution");
  const allowTrustedExtensions = readProperty(hostCapabilities, "allowTrustedExtensions");
  if (execution !== ("worker-sandbox" satisfies SceneExtensionExecution)
    && execution !== ("trusted-main-thread" satisfies SceneExtensionExecution)) {
    reasons.push({ code: "invalid-execution", detail: formatExternalValue(execution) });
  } else if (execution === "trusted-main-thread" && allowTrustedExtensions !== true) {
    reasons.push({
      code: "trusted-extension-disabled",
      detail: "host does not allow trusted-main-thread extensions"
    });
  }

  appendMissingValuesReason(reasons, {
    requested: readStringArray(manifest, "capabilities"),
    supported: readStringArray(hostCapabilities, "capabilities"),
    code: "capability-unsupported",
    requestedLabel: "extension capabilities",
    supportedLabel: "host capabilities"
  });
  appendMissingValuesReason(reasons, {
    requested: readStringArray(manifest, "permissions"),
    supported: readStringArray(hostCapabilities, "permissions"),
    code: "permission-denied",
    requestedLabel: "extension permissions",
    supportedLabel: "host permissions"
  });

  return { compatible: reasons.length === 0, reasons };
}

function appendMissingValuesReason(
  reasons: SceneExtensionCompatibilityReason[],
  options: {
    requested: string[] | undefined;
    supported: string[] | undefined;
    code: "capability-unsupported" | "permission-denied";
    requestedLabel: string;
    supportedLabel: string;
  }
): void {
  if (!options.requested) {
    reasons.push({ code: options.code, detail: `invalid ${options.requestedLabel}` });
    return;
  }
  if (!options.supported) {
    reasons.push({ code: options.code, detail: `invalid ${options.supportedLabel}` });
    return;
  }
  const supportedValues = new Set(options.supported);
  const missingValues = [...new Set(options.requested.filter((value) => !supportedValues.has(value)))].sort();
  if (missingValues.length > 0) reasons.push({ code: options.code, detail: missingValues.join(",") });
}

function parseApiVersion(value: unknown): ApiVersion | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  try {
    return { major: BigInt(match[1]!), minor: BigInt(match[2]!) };
  } catch {
    return undefined;
  }
}

function readStringArray(value: unknown, key: string): string[] | undefined {
  const candidate = readProperty(value, key);
  try {
    if (!Array.isArray(candidate)) return undefined;
    const strings: string[] = [];
    for (let index = 0; index < candidate.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(candidate, index)) return undefined;
      const item: unknown = candidate[index];
      if (typeof item !== "string") return undefined;
      strings.push(item);
    }
    return strings;
  } catch {
    return undefined;
  }
}

function readProperty(value: unknown, key: string): unknown {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function formatExternalValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "symbol") return String(value);
  try {
    const json = JSON.stringify(value);
    return json ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "<unprintable>";
    }
  }
}
