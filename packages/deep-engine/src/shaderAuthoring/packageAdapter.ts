import { compileShaderPass } from "../shader/compiler.js";
import type { ShaderSourceMapEntry } from "../shader/types.js";
import { buildDeepShaderPackage } from "../shaderPackage/builder.js";
import type { ShaderPackagePassBuildInput } from "../shaderPackage/types.js";
import { buildDeepPbrMeshV1StandardShader } from "../shaderPresets/packageStandardSurface.js";
import { inspectDeepSlSurface } from "./deepSl.js";
import {
  inspectPackageAdapterRequest,
  packageAdapterIssue,
  packageAdapterReport,
  rejectedPackageAdapterResult,
} from "./packageAdapterContract.js";
import {
  hasPackageMaterialTextures,
  packageMaterialDefaults,
  packageMaterialTextureDefaults,
} from "./packageAdapterMaterial.js";
import type {
  DeepSlPackageAdapterResult,
  DeepSlPackageCompatibilityIssue,
  DeepSlPackageCompatibilityReport,
  DeepSlPackagePassCompatibility,
} from "./packageAdapterTypes.js";
import { adaptStandardPlainWgsl } from "./packageAdapterWgsl.js";
import { adaptCsmWgsl } from "./packageAdapterCsm.js";

function compatibilityIssues(
  model: NonNullable<ReturnType<typeof inspectDeepSlSurface>["model"]>,
): DeepSlPackageCompatibilityIssue[] {
  return model.surface === "standard" ? [] : [packageAdapterIssue(
    "unsupported-surface",
    "$.source.surface",
    "Adapter profile v2 accepts Standard Surface only.",
  )];
}

function copySourceMap(entries: readonly ShaderSourceMapEntry[]): ShaderSourceMapEntry[] {
  return entries.map((entry) => ({
    stage: entry.stage,
    nodeId: entry.nodeId,
    generatedLine: entry.generatedLine,
  }));
}

function packagePasses(
  module: Readonly<{ label: string; code: string }>,
  alpha: "opaque" | "mask" | "blend",
  doubleSided: boolean,
  textured: boolean,
  normalMapped: boolean,
  sourceEntries: readonly ShaderSourceMapEntry[],
): { readonly builds: ShaderPackagePassBuildInput[]; readonly reports: DeepSlPackagePassCompatibility[] } {
  const modes: readonly ("ccw" | "cw" | "double")[] = doubleSided ? ["double"] : ["ccw", "cw"];
  const builds: ShaderPackagePassBuildInput[] = [];
  const reports: DeepSlPackagePassCompatibility[] = [];
  for (const rasterMode of modes) {
    const suffix = rasterMode === "ccw" ? "Ccw" : rasterMode === "cw" ? "Cw" : "Double";
    const forward = {
      passId: `forward${suffix}`,
      kind: "forward" as const,
      entryPoints: {
        vertex: normalMapped ? "vertexNormalMapped" : "vertexMain",
        fragment: textured ? "fragmentMaterial" : "fragmentMain",
      },
      pipeline: {
        passVariantId: normalMapped ? "forward-normal" as const
          : textured ? "forward-material" as const : "forward-plain" as const,
        attachmentProfileId: alpha === "blend" ? "forward-blend" as const : "forward-opaque" as const,
        alphaMode: alpha === "blend" ? "BLEND" as const : alpha === "mask" ? "MASK" as const : "OPAQUE" as const,
        rasterMode,
      },
    };
    builds.push({ techniqueId: "webgpu", ...forward, module: { ...module }, sourceMap: copySourceMap(sourceEntries) });
    reports.push(Object.freeze({
      ...forward,
      entryPoints: Object.freeze({ ...forward.entryPoints }),
      pipeline: Object.freeze({ ...forward.pipeline }),
    }));
    if (alpha === "blend") continue;
    const masked = alpha === "mask";
    const shadow = {
      passId: `shadow${suffix}`,
      kind: "shadow" as const,
      entryPoints: masked
        ? { vertex: "shadowMaskMain", fragment: textured ? "shadowMaskTextured" : "shadowMaskPlain" }
        : { vertex: "shadowMain", fragment: null },
      pipeline: {
        passVariantId: masked
          ? textured ? "shadow-mask-material" as const : "shadow-mask-plain" as const
          : "shadow-solid" as const,
        attachmentProfileId: "shadow" as const,
        alphaMode: masked ? "MASK" as const : "OPAQUE" as const,
        rasterMode,
      },
    };
    builds.push({ techniqueId: "webgpu", ...shadow, module: { ...module }, sourceMap: [] });
    reports.push(Object.freeze({
      ...shadow,
      entryPoints: Object.freeze({ ...shadow.entryPoints }),
      pipeline: Object.freeze({ ...shadow.pipeline }),
    }));
  }
  return { builds, reports };
}

/** Builds the directly executable DeepSL Standard subset for Shader Package v2. */
export function adaptDeepSlStandardToShaderPackage(input: unknown): DeepSlPackageAdapterResult {
  const request = inspectPackageAdapterRequest(input);
  if (!request.value) return rejectedPackageAdapterResult(request.issues);
  const targetAbi = request.value.targetAbi ?? "deep.pbr.mesh.v1";
  const rejected = (issues: readonly DeepSlPackageCompatibilityIssue[], textured = false) =>
    rejectedPackageAdapterResult(issues, textured, targetAbi);
  if (targetAbi === "deep.pbr.mesh.v2" && request.value.capabilities.limits.maxBindingsPerBindGroup < 8) {
    return rejected([packageAdapterIssue("unsupported-capability", "$.capabilities.limits.maxBindingsPerBindGroup",
      "The CSM ABI requires forward group bindings 0 through 7.")]);
  }
  const inspected = inspectDeepSlSurface(request.value.source);
  if (!inspected.success || !inspected.model) return rejected(inspected.diagnostics.map((entry) =>
    packageAdapterIssue("invalid-deepsl", entry.path, `${entry.code}: ${entry.message}`)));
  const textured = hasPackageMaterialTextures(inspected.model);
  const normalMapped = inspected.model.normalTexture;
  const unsupported = compatibilityIssues(inspected.model);
  if (unsupported.length > 0) return rejected(unsupported, textured);
  if (textured && request.value.capabilities.limits.maxBindGroups < 2) return rejected([
    packageAdapterIssue("unsupported-capability", "$.capabilities.limits.maxBindGroups",
      "The fixed base-color texture ABI requires bind groups 0 and 1."),
  ], true);
  if (textured && request.value.capabilities.limits.maxBindingsPerBindGroup < 11) return rejected([
    packageAdapterIssue("unsupported-capability", "$.capabilities.limits.maxBindingsPerBindGroup",
      "The bounded material layout requires 11 bindings, including disabled-slot dummies."),
  ], true);
  const alphaMode = inspected.model.alpha;
  const preset = buildDeepPbrMeshV1StandardShader({
    id: inspected.model.shaderId,
    alphaMode: alphaMode === "opaque" ? "opaque" : "blend",
    materialMode: textured ? "base-color-texture" : "plain",
    normalMapped,
  });
  if (!preset.ok) return rejected(preset.issues.map((entry) =>
    packageAdapterIssue("shader-ir-build-failed", entry.path, entry.message)), textured);
  const compiled = compileShaderPass(preset.asset, "webgpu", "forward", request.value.capabilities);
  if (!compiled.success || !compiled.value) return rejected(compiled.diagnostics.map((entry) =>
    packageAdapterIssue(entry.code === "unsupported-capability" ? "unsupported-capability" : "shader-compile-failed",
      entry.path, `${entry.code}: ${entry.message}`)), textured);
  let module = adaptStandardPlainWgsl(compiled.value, preset.asset, {
    alphaMode,
    doubleSided: inspected.model.doubleSided,
    materialMode: textured ? "base-color-texture" : "plain",
    normalMapped,
  });
  if (module && targetAbi === "deep.pbr.mesh.v2") module = adaptCsmWgsl(module);
  if (!module) return rejected([
    packageAdapterIssue("shader-compile-failed", "$.module",
      "Compiled Standard pass did not satisfy the fixed ABI adapter preconditions."),
  ], textured);
  const passes = packagePasses(
    module, alphaMode, inspected.model.doubleSided, textured, normalMapped, compiled.value.sourceMap,
  );
  const built = buildDeepShaderPackage({
    packageId: request.value.packageId ?? inspected.model.shaderId,
    packageVersion: request.value.packageVersion,
    compilerVersion: request.value.compilerVersion,
    targetAbi,
    passes: passes.builds,
  });
  if (!built.success || !built.value) return rejected(built.diagnostics.map((entry) =>
    packageAdapterIssue("package-build-failed", entry.path, `${entry.code}: ${entry.message}`)), textured);
  const readyReport = packageAdapterReport(
    "direct-package-ready",
    [],
    passes.reports,
    packageMaterialDefaults(inspected.model),
    textured,
    textured ? packageMaterialTextureDefaults(inspected.model) : undefined,
    normalMapped,
    targetAbi,
  ) as DeepSlPackageCompatibilityReport & { status: "direct-package-ready" };
  return Object.freeze({ success: true, report: readyReport, package: built.value });
}
