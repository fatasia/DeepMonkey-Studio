import type { ShaderCompileCapabilities, ShaderDiagnostic } from "../shader/types.js";
import type { DeepPbrMeshShaderAbiId } from "../shaderAbi/types.js";
import { validateCompileCapabilities } from "../shader/variants.js";
import {
  DEEP_SL_PACKAGE_ADAPTER_PROFILE, DEEP_SL_PACKAGE_ADAPTER_SCHEMA,
  DEEP_SL_PACKAGE_ADAPTER_SCHEMA_VERSION, DEEP_SL_PACKAGE_TEXTURE_ADAPTER_PROFILE,
  DEEP_SL_PACKAGE_CSM_ADAPTER_PROFILE, DEEP_SL_PACKAGE_CSM_TEXTURE_ADAPTER_PROFILE,
  DEEP_SL_UNLIT_PACKAGE_ADAPTER_PROFILE, DEEP_SL_UNLIT_PACKAGE_TEXTURE_ADAPTER_PROFILE,
  DEEP_SL_UNLIT_PACKAGE_CSM_ADAPTER_PROFILE, DEEP_SL_UNLIT_PACKAGE_CSM_TEXTURE_ADAPTER_PROFILE,
} from "./packageAdapterTypes.js";
import type {
  DeepPbrMeshV1MaterialDefaults, DeepPbrMeshV1MaterialTextureDefaults,
  DeepSlPackageAdapterInput, DeepSlPackageAdapterResult,
  DeepSlPackageCompatibilityIssue, DeepSlPackageCompatibilityReport,
  DeepSlPackagePassCompatibility,
} from "./packageAdapterTypes.js";

type IssueCode = DeepSlPackageCompatibilityIssue["code"];
export type AcceptedPackageAdapterRequest = Omit<DeepSlPackageAdapterInput, "capabilities"> & {
  readonly capabilities: ShaderCompileCapabilities;
};

export function packageAdapterIssue(
  code: IssueCode,
  path: string,
  message: string,
): DeepSlPackageCompatibilityIssue {
  return Object.freeze({ code, path, message });
}

export function inspectPackageAdapterRequest(input: unknown): {
  readonly value?: AcceptedPackageAdapterRequest;
  readonly issues: readonly DeepSlPackageCompatibilityIssue[];
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return {
    issues: Object.freeze([packageAdapterIssue("invalid-request", "$", "Expected a DeepSL package adapter request.")]),
  };
  let descriptors: PropertyDescriptorMap;
  let prototype: object | null;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
    prototype = Object.getPrototypeOf(input);
  } catch {
    return {
      issues: Object.freeze([
        packageAdapterIssue("invalid-request", "$", "Request reflection failed; proxies are not accepted."),
      ]),
    };
  }
  const issues: DeepSlPackageCompatibilityIssue[] = [];
  if (prototype !== Object.prototype && prototype !== null) {
    issues.push(packageAdapterIssue("invalid-request", "$", "Only a plain request record is accepted."));
  }
  const allowed = new Set([
    "schemaVersion", "source", "packageId", "packageVersion", "compilerVersion", "capabilities", "targetAbi",
  ]);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      issues.push(packageAdapterIssue("invalid-request", `$.${String(key)}`, "Unknown request field."));
    }
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (descriptor && (descriptor.get || descriptor.set || !("value" in descriptor))) {
      issues.push(packageAdapterIssue("invalid-request", `$.${String(key)}`, "Accessors are not accepted."));
    }
  }
  const read = (key: string): unknown => descriptors[key]?.value;
  if (read("targetAbi") !== undefined && read("targetAbi") !== "deep.pbr.mesh.v1" && read("targetAbi") !== "deep.pbr.mesh.v2") {
    issues.push(packageAdapterIssue("invalid-request", "$.targetAbi", "Unsupported shader ABI."));
  }
  if (read("schemaVersion") !== DEEP_SL_PACKAGE_ADAPTER_SCHEMA_VERSION) {
    issues.push(packageAdapterIssue("invalid-request", "$.schemaVersion", "Adapter request schemaVersion must be 1."));
  }
  if (typeof read("source") !== "string") {
    issues.push(packageAdapterIssue("invalid-request", "$.source", "DeepSL source must be text."));
  }
  if (read("packageId") !== undefined && typeof read("packageId") !== "string") {
    issues.push(packageAdapterIssue("invalid-request", "$.packageId", "Package ID must be text when provided."));
  }
  if (typeof read("packageVersion") !== "string") {
    issues.push(packageAdapterIssue("invalid-request", "$.packageVersion", "Package version must be text."));
  }
  if (typeof read("compilerVersion") !== "string") {
    issues.push(packageAdapterIssue("invalid-request", "$.compilerVersion", "Compiler version must be text."));
  }
  if (read("capabilities") === null || typeof read("capabilities") !== "object") {
    issues.push(packageAdapterIssue("invalid-request", "$.capabilities", "Compile capabilities are required."));
  }
  const capabilityDiagnostics: ShaderDiagnostic[] = [];
  if (read("capabilities") !== null && typeof read("capabilities") === "object"
    && !validateCompileCapabilities(read("capabilities"), capabilityDiagnostics)) {
    issues.push(...capabilityDiagnostics.map((entry) => packageAdapterIssue(
      "invalid-request", `$.${entry.path}`, `${entry.code}: ${entry.message}`,
    )));
  }
  if (issues.length > 0) return { issues: Object.freeze(issues) };
  const capabilities = read("capabilities") as ShaderCompileCapabilities;
  return {
    value: {
      schemaVersion: 1,
      source: read("source") as string,
      ...(read("targetAbi") === undefined ? {} : { targetAbi: read("targetAbi") as DeepPbrMeshShaderAbiId }),
      ...(read("packageId") === undefined ? {} : { packageId: read("packageId") as string }),
      packageVersion: read("packageVersion") as string,
      compilerVersion: read("compilerVersion") as string,
      capabilities: Object.freeze({
        features: Object.freeze([...capabilities.features]),
        limits: Object.freeze({ ...capabilities.limits }),
      }),
    },
    issues: Object.freeze([]),
  };
}

export function packageAdapterReport(
  status: DeepSlPackageCompatibilityReport["status"],
  issues: readonly DeepSlPackageCompatibilityIssue[],
  passSelections: readonly DeepSlPackagePassCompatibility[] = [],
  materialDefaults?: DeepPbrMeshV1MaterialDefaults,
  textured = false,
  materialTextureDefaults?: DeepPbrMeshV1MaterialTextureDefaults,
  normalMapped = false,
  targetAbi: DeepPbrMeshShaderAbiId = "deep.pbr.mesh.v1",
  surface: "standard" | "unlit" = "standard",
): DeepSlPackageCompatibilityReport {
  const bindGroupLayouts: ("forward-frame" | "shadow-frame" | "material")[] = [];
  if (passSelections.some((entry) => entry.kind === "forward")) bindGroupLayouts.push("forward-frame");
  if (textured && passSelections.length > 0) bindGroupLayouts.push("material");
  if (passSelections.some((entry) => entry.kind === "shadow")) bindGroupLayouts.push("shadow-frame");
  return Object.freeze({
    schema: DEEP_SL_PACKAGE_ADAPTER_SCHEMA,
    schemaVersion: DEEP_SL_PACKAGE_ADAPTER_SCHEMA_VERSION,
    adapterProfile: surface === "unlit"
      ? targetAbi === "deep.pbr.mesh.v2"
        ? textured ? DEEP_SL_UNLIT_PACKAGE_CSM_TEXTURE_ADAPTER_PROFILE : DEEP_SL_UNLIT_PACKAGE_CSM_ADAPTER_PROFILE
        : textured ? DEEP_SL_UNLIT_PACKAGE_TEXTURE_ADAPTER_PROFILE : DEEP_SL_UNLIT_PACKAGE_ADAPTER_PROFILE
      : targetAbi === "deep.pbr.mesh.v2"
        ? textured ? DEEP_SL_PACKAGE_CSM_TEXTURE_ADAPTER_PROFILE : DEEP_SL_PACKAGE_CSM_ADAPTER_PROFILE
        : textured ? DEEP_SL_PACKAGE_TEXTURE_ADAPTER_PROFILE : DEEP_SL_PACKAGE_ADAPTER_PROFILE,
    status,
    shaderAbi: targetAbi,
    materialSource: textured ? "instance-and-material-bind-group" : "instance-stream",
    bindGroupLayouts: Object.freeze(bindGroupLayouts),
    vertexStreams: Object.freeze(normalMapped
      ? ["geometry", "instance", "tangent"] as const
      : ["geometry", "instance"] as const),
    passSelections: Object.freeze(passSelections),
    ...(materialDefaults ? { materialDefaults } : {}),
    ...(materialTextureDefaults ? { materialTextureDefaults } : {}),
    issues: Object.freeze(issues),
  });
}

export function rejectedPackageAdapterResult(
  issues: readonly DeepSlPackageCompatibilityIssue[],
  textured = false,
  targetAbi: DeepPbrMeshShaderAbiId = "deep.pbr.mesh.v1",
  surface: "standard" | "unlit" = "standard",
): DeepSlPackageAdapterResult {
  return Object.freeze({
    success: false,
    report: packageAdapterReport("rejected", issues, [], undefined, textured, undefined, false, targetAbi, surface) as
      DeepSlPackageCompatibilityReport & { status: "rejected" },
  });
}
