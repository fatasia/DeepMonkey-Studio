import { buildDeepShaderPackage } from "../shaderPackage/builder.js";
import type { ShaderPackagePassBuildInput } from "../shaderPackage/types.js";
import { parseDeepSlDocument } from "./deepSlParser.js";
import {
  inspectPackageAdapterRequest, packageAdapterIssue, packageAdapterReport, rejectedPackageAdapterResult,
} from "./packageAdapterContract.js";
import { packageMaterialTextureDefaults, packageUnlitMaterialDefaults } from "./packageAdapterMaterial.js";
import type {
  DeepSlPackageAdapterResult, DeepSlPackageCompatibilityIssue, DeepSlPackageCompatibilityReport,
  DeepSlPackagePassCompatibility,
} from "./packageAdapterTypes.js";
import { buildUnlitPackageWgsl } from "./packageUnlitWgsl.js";
import { appendAuxiliaryWgsl, packageAuxiliaryPasses } from "./packageAuxiliaryPasses.js";

const FORBIDDEN_FIELDS = Object.freeze([
  "metallic", "roughness", "metallicRoughnessTexture", "metallicRoughnessTextureTransform",
  "normalTexture", "normalTextureTransform", "normalScale",
  "occlusionTexture", "occlusionTextureTransform", "occlusionStrength",
  "clearcoatFactor", "clearcoatRoughness",
] as const);

function unsupportedFields(fields: ReadonlyMap<string, unknown>): DeepSlPackageCompatibilityIssue[] {
  return FORBIDDEN_FIELDS.filter((field) => fields.has(field)).map((field) => packageAdapterIssue(
    "unsupported-unlit-field", `$.source.${field}`,
    `Unlit has no ${field} input; remove the declaration instead of relying on a silent no-op.`,
  ));
}

function capacityIssues(
  limits: Readonly<{
    maxBindGroups: number; maxBindingsPerBindGroup: number; maxInterStageShaderVariables: number;
  }>,
  targetAbi: "deep.pbr.mesh.v1" | "deep.pbr.mesh.v2" | "deep.pbr.mesh.v3" | "deep.pbr.mesh.v4",
  textured: boolean,
): DeepSlPackageCompatibilityIssue[] {
  const issues: DeepSlPackageCompatibilityIssue[] = [];
  const forwardBindings = targetAbi === "deep.pbr.mesh.v1" ? 7 : 8;
  if (limits.maxBindGroups < (textured ? 2 : 1)) issues.push(packageAdapterIssue(
    "unsupported-capability", "$.capabilities.limits.maxBindGroups",
    `Unlit ${textured ? "texture" : "plain"} ABI requires ${textured ? 2 : 1} bind group(s).`,
  ));
  if (limits.maxBindingsPerBindGroup < forwardBindings) issues.push(packageAdapterIssue(
    "unsupported-capability", "$.capabilities.limits.maxBindingsPerBindGroup",
    `The ${targetAbi} forward frame layout requires ${forwardBindings} bindings.`,
  ));
  if (textured && limits.maxBindingsPerBindGroup < 11) issues.push(packageAdapterIssue(
    "unsupported-capability", "$.capabilities.limits.maxBindingsPerBindGroup",
    "The bounded Unlit material layout requires 11 bindings, including disabled-slot dummies.",
  ));
  const interStageVariables = textured ? 5 : 3;
  if (limits.maxInterStageShaderVariables < interStageVariables) issues.push(packageAdapterIssue(
    "unsupported-capability", "$.capabilities.limits.maxInterStageShaderVariables",
    `Unlit ${textured ? "texture" : "plain"} forward requires ${interStageVariables} inter-stage locations.`,
  ));
  return issues;
}

function packagePasses(
  module: Readonly<{ label: string; code: string }>,
  alpha: "opaque" | "mask" | "blend",
  doubleSided: boolean,
  textured: boolean,
): { readonly builds: ShaderPackagePassBuildInput[]; readonly reports: DeepSlPackagePassCompatibility[] } {
  const rasterModes = doubleSided ? ["double" as const] : ["ccw" as const, "cw" as const];
  const builds: ShaderPackagePassBuildInput[] = [], reports: DeepSlPackagePassCompatibility[] = [];
  for (const rasterMode of rasterModes) {
    const suffix = rasterMode === "double" ? "Double" : rasterMode === "ccw" ? "Ccw" : "Cw";
    const forward = {
      passId: `forward${suffix}`, kind: "forward" as const,
      entryPoints: { vertex: "vertexMain", fragment: textured ? "fragmentMaterial" : "fragmentMain" },
      pipeline: {
        passVariantId: textured ? "forward-material" as const : "forward-plain" as const,
        attachmentProfileId: alpha === "blend" ? "forward-blend" as const : "forward-opaque" as const,
        alphaMode: alpha.toUpperCase() as "OPAQUE" | "MASK" | "BLEND", rasterMode,
      },
    };
    builds.push({ techniqueId: "webgpu", ...forward, module: { ...module }, sourceMap: [] });
    reports.push(Object.freeze({ ...forward, entryPoints: Object.freeze(forward.entryPoints), pipeline: Object.freeze(forward.pipeline) }));
    if (alpha === "blend") continue;
    const masked = alpha === "mask";
    const shadow = {
      passId: `shadow${suffix}`, kind: "shadow" as const,
      entryPoints: masked
        ? { vertex: "shadowMaskMain", fragment: textured ? "shadowMaskTextured" : "shadowMaskPlain" }
        : { vertex: "shadowMain", fragment: null },
      pipeline: {
        passVariantId: masked
          ? textured ? "shadow-mask-material" as const : "shadow-mask-plain" as const
          : "shadow-solid" as const,
        attachmentProfileId: "shadow" as const,
        alphaMode: masked ? "MASK" as const : "OPAQUE" as const, rasterMode,
      },
    };
    builds.push({ techniqueId: "webgpu", ...shadow, module: { ...module }, sourceMap: [] });
    reports.push(Object.freeze({ ...shadow, entryPoints: Object.freeze(shadow.entryPoints), pipeline: Object.freeze(shadow.pipeline) }));
  }
  return { builds, reports };
}

/** Builds the directly executable DeepSL Unlit subset for Shader Package v2. */
export function adaptDeepSlUnlitToShaderPackage(input: unknown): DeepSlPackageAdapterResult {
  const request = inspectPackageAdapterRequest(input);
  if (!request.value) return rejectedPackageAdapterResult(request.issues, false, "deep.pbr.mesh.v1", "unlit");
  const targetAbi = request.value.targetAbi ?? "deep.pbr.mesh.v1";
  const reject = (issues: readonly DeepSlPackageCompatibilityIssue[], textured = false) =>
    rejectedPackageAdapterResult(issues, textured, targetAbi, "unlit");
  const parsed = parseDeepSlDocument(request.value.source);
  const inspected = parsed.inspection;
  if (!inspected.success || !inspected.model) return reject(inspected.diagnostics.map((entry) =>
    packageAdapterIssue("invalid-deepsl", entry.path, `${entry.code}: ${entry.message}`)));
  if (inspected.model.surface !== "unlit") return reject([packageAdapterIssue(
    "unsupported-surface", "$.source.surface", "Unlit package adapter accepts Unlit Surface only.",
  )]);
  const fieldIssues = unsupportedFields(parsed.fields);
  if (fieldIssues.length > 0) return reject(fieldIssues);
  const textured = inspected.model.baseColorTexture || inspected.model.emissiveTexture;
  const capabilityIssues = capacityIssues(request.value.capabilities.limits, targetAbi, textured);
  if (capabilityIssues.length > 0) return reject(capabilityIssues, textured);
  const coreModule = buildUnlitPackageWgsl({ alphaMode: inspected.model.alpha, textured });
  const auxiliaryOptions = { alpha: inspected.model.alpha, doubleSided: inspected.model.doubleSided,
    textured, uvFunction: "deepUnlitUv" as const };
  // v4 只新增几何端颜色流，shader 产物与 v3 相同：同样携带 depth/picking 辅助通道。
  const auxiliaryAbi = targetAbi === "deep.pbr.mesh.v3" || targetAbi === "deep.pbr.mesh.v4";
  const module = auxiliaryAbi
    ? appendAuxiliaryWgsl(coreModule, auxiliaryOptions) : coreModule;
  const corePasses = packagePasses(module, inspected.model.alpha, inspected.model.doubleSided, textured);
  const auxiliary = auxiliaryAbi
    ? packageAuxiliaryPasses(module, auxiliaryOptions) : undefined;
  const passes = auxiliary ? {
    builds: [...corePasses.builds, ...auxiliary.builds],
    reports: [...corePasses.reports, ...auxiliary.reports],
  } : corePasses;
  const built = buildDeepShaderPackage({
    packageId: request.value.packageId ?? inspected.model.shaderId,
    packageVersion: request.value.packageVersion,
    compilerVersion: request.value.compilerVersion,
    targetAbi,
    passes: passes.builds,
  });
  if (!built.success || !built.value) return reject(built.diagnostics.map((entry) =>
    packageAdapterIssue("package-build-failed", entry.path, `${entry.code}: ${entry.message}`)), textured);
  const defaults = packageUnlitMaterialDefaults(inspected.model);
  const textureDefaults = textured ? packageMaterialTextureDefaults(inspected.model) : undefined;
  return Object.freeze({
    success: true,
    report: packageAdapterReport(
      "direct-package-ready", [], passes.reports, defaults, textured, textureDefaults,
      false, targetAbi, "unlit",
    ) as DeepSlPackageCompatibilityReport & { status: "direct-package-ready" },
    package: built.value,
  }) as DeepSlPackageAdapterResult;
}
