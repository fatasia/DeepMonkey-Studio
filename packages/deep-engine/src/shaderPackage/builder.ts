import {
  DEEP_PBR_MESH_V1, DEEP_PBR_MESH_V1_SHA256, DEEP_PBR_MESH_V2, DEEP_PBR_MESH_V2_SHA256,
  DEEP_PBR_MESH_V3, DEEP_PBR_MESH_V3_SHA256,
} from "../shaderAbi/index.js";
import {
  DEEP_SHADER_PACKAGE_BUDGETS, DEEP_SHADER_PACKAGE_SCHEMA,
  DEEP_SHADER_PACKAGE_SCHEMA_VERSION, DEEP_SHADER_TARGET_PROFILE,
} from "./constants.js";
import { hashCanonicalShaderPackage, sha256Utf8 } from "./hash.js";
import { computeDeepShaderPassCacheKey } from "./pipeline.js";
import {
  exactFields, issue, PACKAGE_ID_PATTERN, record, RECORD_ID_PATTERN,
  SYMBOL_PATTERN, validString, validateHash, VERSION_PATTERN,
} from "./primitives.js";
import { inspectShaderPackageInput } from "./safeInput.js";
import { cloneCanonical, deepFreeze } from "./snapshot.js";
import type {
  DeepShaderPackageBuildInput, DeepShaderPackageV2, ShaderPackageAbiReference,
  ShaderPackageBuildResult, ShaderPackageDependency, ShaderPackageDiagnostic,
  ShaderPackageModule, ShaderPackagePass, ShaderPackagePassBuildInput,
} from "./types.js";
import { validateDeepShaderPackage } from "./validation.js";

function validateBuildShape(
  input: unknown,
  diagnostics: ShaderPackageDiagnostic[],
): input is DeepShaderPackageBuildInput {
  if (!record(input)) {
    issue(diagnostics, "invalid-type", "$", "Expected shader package build input.");
    return false;
  }
  exactFields(input, ["packageId", "packageVersion", "compilerVersion", "targetProfile", "targetAbi", "dependencies", "passes"], "$", diagnostics);
  if (input.targetAbi !== undefined
    && !["deep.pbr.mesh.v1", "deep.pbr.mesh.v2", "deep.pbr.mesh.v3"].includes(String(input.targetAbi))) {
    issue(diagnostics, "invalid-value", "$.targetAbi", "Unsupported shader ABI.");
  }
  validString(input.packageId, "$.packageId", diagnostics, PACKAGE_ID_PATTERN);
  validString(input.packageVersion, "$.packageVersion", diagnostics, VERSION_PATTERN);
  validString(input.compilerVersion, "$.compilerVersion", diagnostics, VERSION_PATTERN);
  if (input.targetProfile !== undefined && input.targetProfile !== DEEP_SHADER_TARGET_PROFILE) {
    issue(diagnostics, "invalid-value", "$.targetProfile", "Executable WGSL pipeline target is required.");
  }
  validateBuildDependencies(input.dependencies, diagnostics);
  if (!Array.isArray(input.passes)) {
    issue(diagnostics, "invalid-type", "$.passes", "Expected pass build input array.");
    return false;
  }
  if (input.passes.length > DEEP_SHADER_PACKAGE_BUDGETS.maxPasses) {
    issue(diagnostics, "budget-exceeded", "$.passes", "Build input exceeds the pass budget.");
  }
  input.passes.forEach((entry, index) => validatePassBuildShape(entry, index, diagnostics));
  return diagnostics.length === 0;
}

function validateBuildDependencies(
  value: unknown,
  diagnostics: ShaderPackageDiagnostic[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issue(diagnostics, "invalid-type", "$.dependencies", "Expected dependency array.");
    return;
  }
  if (value.length > DEEP_SHADER_PACKAGE_BUDGETS.maxDependencies) {
    issue(diagnostics, "budget-exceeded", "$.dependencies", "Dependencies exceed their budget.");
  }
  value.slice(0, DEEP_SHADER_PACKAGE_BUDGETS.maxDependencies).forEach((entry, index) => {
    const path = `$.dependencies.${index}`;
    if (!record(entry)) {
      issue(diagnostics, "invalid-type", path, "Expected dependency record.");
      return;
    }
    exactFields(entry, ["id", "contentHash"], path, diagnostics);
    validString(entry.id, `${path}.id`, diagnostics, PACKAGE_ID_PATTERN);
    validateHash(entry.contentHash, `${path}.contentHash`, diagnostics);
  });
}

function validatePassBuildShape(
  entry: unknown,
  index: number,
  diagnostics: ShaderPackageDiagnostic[],
): void {
  const path = `$.passes.${index}`;
  if (!record(entry)) {
    issue(diagnostics, "invalid-type", path, "Expected pass build input.");
    return;
  }
  validString(entry.techniqueId, `${path}.techniqueId`, diagnostics, SYMBOL_PATTERN);
  validString(entry.passId, `${path}.passId`, diagnostics, SYMBOL_PATTERN);
  if (!["forward", "depth", "shadow", "picking"].includes(String(entry.kind))) {
    issue(diagnostics, "invalid-value", `${path}.kind`, "Only ABI render passes are supported.");
  }
  exactFields(entry, ["techniqueId", "passId", "kind", "module", "entryPoints", "sourceMap", "dependencyIds", "pipeline"], path, diagnostics);
  if (!record(entry.module)) {
    issue(diagnostics, "invalid-type", `${path}.module`, "Expected WGSL module.");
  } else {
    exactFields(entry.module, ["label", "code"], `${path}.module`, diagnostics);
    validString(entry.module.label, `${path}.module.label`, diagnostics);
    if (typeof entry.module.code !== "string") {
      issue(diagnostics, "invalid-type", `${path}.module.code`, "Expected WGSL string.");
    } else if (new TextEncoder().encode(entry.module.code).byteLength
      > DEEP_SHADER_PACKAGE_BUDGETS.maxWgslBytesPerModule) {
      issue(diagnostics, "budget-exceeded", `${path}.module.code`, "WGSL exceeds its byte budget.");
    }
  }
  if (!record(entry.entryPoints)) {
    issue(diagnostics, "invalid-type", `${path}.entryPoints`, "Expected entry points.");
  } else {
    exactFields(entry.entryPoints, ["vertex", "fragment"], `${path}.entryPoints`, diagnostics);
    validString(entry.entryPoints.vertex, `${path}.entryPoints.vertex`, diagnostics, SYMBOL_PATTERN);
    if (entry.entryPoints.fragment !== null) {
      validString(entry.entryPoints.fragment, `${path}.entryPoints.fragment`, diagnostics, SYMBOL_PATTERN);
    }
  }
  if (!record(entry.pipeline)) {
    issue(diagnostics, "invalid-type", `${path}.pipeline`, "Expected pipeline selection.");
  } else {
    exactFields(entry.pipeline, ["passVariantId", "attachmentProfileId", "alphaMode", "rasterMode"], `${path}.pipeline`, diagnostics);
    validString(entry.pipeline.passVariantId, `${path}.pipeline.passVariantId`, diagnostics, RECORD_ID_PATTERN);
    validString(entry.pipeline.attachmentProfileId, `${path}.pipeline.attachmentProfileId`, diagnostics, RECORD_ID_PATTERN);
    validString(entry.pipeline.alphaMode, `${path}.pipeline.alphaMode`, diagnostics, SYMBOL_PATTERN);
    validString(entry.pipeline.rasterMode, `${path}.pipeline.rasterMode`, diagnostics, RECORD_ID_PATTERN);
  }
  if (entry.sourceMap !== undefined && !Array.isArray(entry.sourceMap)) {
    issue(diagnostics, "invalid-type", `${path}.sourceMap`, "Expected source-map array.");
  }
  if (entry.dependencyIds !== undefined && !Array.isArray(entry.dependencyIds)) {
    issue(diagnostics, "invalid-type", `${path}.dependencyIds`, "Expected dependency ID array.");
  }
  if (Array.isArray(entry.sourceMap)
    && entry.sourceMap.length > DEEP_SHADER_PACKAGE_BUDGETS.maxSourceMapEntriesPerPass) {
    issue(diagnostics, "budget-exceeded", `${path}.sourceMap`, "Source map exceeds its budget.");
  }
  if (Array.isArray(entry.dependencyIds)
    && entry.dependencyIds.length > DEEP_SHADER_PACKAGE_BUDGETS.maxDependencies) {
    issue(diagnostics, "budget-exceeded", `${path}.dependencyIds`, "Dependency references exceed their budget.");
  }
}

function cloneDependencies(input: readonly ShaderPackageDependency[] | undefined): ShaderPackageDependency[] {
  return (input ?? []).map((entry) => cloneCanonical(entry)).sort((a, b) => a.id.localeCompare(b.id));
}

function moduleKey(input: ShaderPackagePassBuildInput): string {
  const dependencyIds = [...(input.dependencyIds ?? [])].sort();
  return hashCanonicalShaderPackage({ sourceHash: sha256Utf8(input.module.code), dependencyIds });
}

function buildModules(inputs: readonly ShaderPackagePassBuildInput[]): ShaderPackageModule[] {
  const modules = new Map<string, ShaderPackageModule>();
  for (const input of inputs) {
    const key = moduleKey(input);
    if (modules.has(key)) continue;
    modules.set(key, {
      id: `module.${key}`,
      language: "wgsl",
      source: input.module.code,
      sourceHash: { algorithm: "sha256", value: sha256Utf8(input.module.code) },
      dependencyIds: [...(input.dependencyIds ?? [])].sort(),
    });
  }
  return [...modules.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function shaderAbiReference(target: DeepShaderPackageBuildInput["targetAbi"]): ShaderPackageAbiReference {
  const contract = target === "deep.pbr.mesh.v3" ? DEEP_PBR_MESH_V3
    : target === "deep.pbr.mesh.v2" ? DEEP_PBR_MESH_V2 : DEEP_PBR_MESH_V1;
  const hash = target === "deep.pbr.mesh.v3" ? DEEP_PBR_MESH_V3_SHA256
    : target === "deep.pbr.mesh.v2" ? DEEP_PBR_MESH_V2_SHA256 : DEEP_PBR_MESH_V1_SHA256;
  return {
    id: contract.id,
    contentHash: { algorithm: "sha256", value: hash },
    contract: cloneCanonical(contract),
  };
}

function buildPass(
  input: ShaderPackagePassBuildInput,
  module: ShaderPackageModule,
  packageInput: DeepShaderPackageBuildInput,
  shaderAbi: ShaderPackageAbiReference,
  dependencies: readonly ShaderPackageDependency[],
): ShaderPackagePass {
  const pass = {
    id: `${input.techniqueId}/${input.passId}`,
    techniqueId: input.techniqueId,
    passId: input.passId,
    kind: input.kind,
    moduleId: module.id,
    entryPoints: cloneCanonical(input.entryPoints),
    sourceMap: cloneCanonical(input.sourceMap ?? []),
    pipeline: cloneCanonical(input.pipeline),
  };
  const cacheKey = computeDeepShaderPassCacheKey({
    schemaVersion: DEEP_SHADER_PACKAGE_SCHEMA_VERSION,
    targetProfile: packageInput.targetProfile ?? DEEP_SHADER_TARGET_PROFILE,
    compilerVersion: packageInput.compilerVersion,
    ...pass,
    module,
    shaderAbi,
    dependencies,
  });
  return { ...pass, cacheKey: cacheKey ?? "" };
}

export function buildDeepShaderPackage(input: unknown): ShaderPackageBuildResult {
  const diagnostics = [...inspectShaderPackageInput(input)];
  if (diagnostics.length > 0 || !validateBuildShape(input, diagnostics)) {
    return Object.freeze({ success: false, diagnostics: Object.freeze(diagnostics) });
  }
  const passInputs = [...input.passes].sort((a, b) =>
    `${a.techniqueId}/${a.passId}`.localeCompare(`${b.techniqueId}/${b.passId}`));
  const dependencies = cloneDependencies(input.dependencies);
  const modules = buildModules(passInputs);
  const shaderAbi = shaderAbiReference(input.targetAbi);
  const passes = passInputs.map((entry) => buildPass(
    entry,
    modules.find((module) => module.id === `module.${moduleKey(entry)}`)!,
    input,
    shaderAbi,
    dependencies,
  ));
  const core: Omit<DeepShaderPackageV2, "packageCacheKey"> = {
    schema: DEEP_SHADER_PACKAGE_SCHEMA,
    schemaVersion: DEEP_SHADER_PACKAGE_SCHEMA_VERSION,
    packageId: input.packageId,
    packageVersion: input.packageVersion,
    compilerVersion: input.compilerVersion,
    targetProfile: input.targetProfile ?? DEEP_SHADER_TARGET_PROFILE,
    shaderAbi,
    dependencies,
    modules,
    passes,
  };
  const draft: DeepShaderPackageV2 = {
    ...core,
    packageCacheKey: hashCanonicalShaderPackage(core),
  };
  const validation = validateDeepShaderPackage(draft);
  if (!validation.valid) return Object.freeze({ success: false, diagnostics: validation.diagnostics });
  return Object.freeze({ success: true, diagnostics: Object.freeze([]), value: deepFreeze(draft) });
}
