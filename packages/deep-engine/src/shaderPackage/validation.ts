import {
  DEEP_PBR_MESH_V1_CANONICAL_JSON, DEEP_PBR_MESH_V1_SHA256, canonicalShaderAbiJson,
  DEEP_PBR_MESH_V2_CANONICAL_JSON, DEEP_PBR_MESH_V2_SHA256,
} from "../shaderAbi/index.js";
import {
  DEEP_SHADER_PACKAGE_BUDGETS, DEEP_SHADER_PACKAGE_SCHEMA,
  DEEP_SHADER_PACKAGE_SCHEMA_VERSION, DEEP_SHADER_TARGET_PROFILE,
} from "./constants.js";
import { hashCanonicalShaderPackage } from "./hash.js";
import { computeDeepShaderPassCacheKey, resolveShaderPackagePipeline } from "./pipeline.js";
import {
  exactFields, HASH_PATTERN, issue, PACKAGE_ID_PATTERN, record, RECORD_ID_PATTERN,
  requireArray, requireCanonicalOrder, SYMBOL_PATTERN, validInteger, validString,
  validateHash, VERSION_PATTERN,
} from "./primitives.js";
import { validateDependencies, validateModules } from "./recordValidation.js";
import { inspectShaderPackageInput } from "./safeInput.js";
import { immutableCanonicalSnapshot } from "./snapshot.js";
import type {
  DeepShaderPackageV2, ShaderPackageDiagnostic, ShaderPackageModule,
  ShaderPackageAbiReference, ShaderPackagePass,
  ShaderPackagePipelineSelection, ShaderPackageValidationResult,
} from "./types.js";

function packageCore(value: DeepShaderPackageV2): Omit<DeepShaderPackageV2, "packageCacheKey"> {
  const { packageCacheKey: _ignored, ...core } = value;
  return core;
}

export const computeDeepShaderPackageCacheKey = (value: DeepShaderPackageV2): string =>
  hashCanonicalShaderPackage(packageCore(value));

function invalidResult(
  diagnostics: ShaderPackageDiagnostic[],
): ShaderPackageValidationResult {
  return Object.freeze({
    valid: false,
    diagnostics: Object.freeze(diagnostics.map((entry) => Object.freeze(entry))),
  });
}

function validateShaderAbi(
  value: unknown,
  diagnostics: ShaderPackageDiagnostic[],
): ShaderPackageAbiReference | undefined {
  const initialIssues = diagnostics.length;
  const path = "$.shaderAbi";
  if (!record(value)) {
    issue(diagnostics, "invalid-type", path, "Expected frozen shader ABI reference.");
    return undefined;
  }
  exactFields(value, ["id", "contentHash", "contract"], path, diagnostics);
  if (value.id !== "deep.pbr.mesh.v1" && value.id !== "deep.pbr.mesh.v2") {
    issue(diagnostics, "invalid-value", `${path}.id`, "Unsupported shader ABI.");
  }
  validateHash(value.contentHash, `${path}.contentHash`, diagnostics);
  const expectedHash = value.id === "deep.pbr.mesh.v2" ? DEEP_PBR_MESH_V2_SHA256 : DEEP_PBR_MESH_V1_SHA256;
  const expectedContract = value.id === "deep.pbr.mesh.v2" ? DEEP_PBR_MESH_V2_CANONICAL_JSON : DEEP_PBR_MESH_V1_CANONICAL_JSON;
  if (record(value.contentHash) && value.contentHash.value !== expectedHash) {
    issue(diagnostics, "hash-mismatch", `${path}.contentHash.value`, "Shader ABI fingerprint mismatch.");
  }
  if (!record(value.contract)
    || canonicalShaderAbiJson(value.contract) !== expectedContract) {
    issue(diagnostics, "invalid-value", `${path}.contract`, "Shader ABI contract differs from its frozen version.");
  }
  return diagnostics.length === initialIssues
    ? value as unknown as ShaderPackageAbiReference
    : undefined;
}

function shaderTokensOnly(source: string): string {
  let output = "", blockDepth = 0;
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!, next = source[index + 1];
    if (blockDepth > 0) {
      if (current === "/" && next === "*") { blockDepth += 1; output += "  "; index += 1; }
      else if (current === "*" && next === "/") { blockDepth -= 1; output += "  "; index += 1; }
      else output += current === "\n" ? "\n" : " ";
    } else if (quote) {
      if (current === "\\") { output += "  "; index += 1; }
      else { if (current === quote) quote = undefined; output += current === "\n" ? "\n" : " "; }
    } else if (current === "/" && next === "/") {
      output += "  "; index += 1;
      while (index + 1 < source.length && source[index + 1] !== "\n") { output += " "; index += 1; }
    } else if (current === "/" && next === "*") { blockDepth = 1; output += "  "; index += 1; }
    else if (current === "\"" || current === "'") { quote = current; output += " "; }
    else output += current;
  }
  return output;
}

function containsEntryPoint(source: string, stage: "vertex" | "fragment", name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`@${stage}\\s+fn\\s+${escaped}\\s*\\(`).test(shaderTokensOnly(source));
}

function validateSourceMap(
  value: unknown,
  path: string,
  lineCount: number,
  diagnostics: ShaderPackageDiagnostic[],
): void {
  const items = requireArray(value, DEEP_SHADER_PACKAGE_BUDGETS.maxSourceMapEntriesPerPass, path, diagnostics);
  let previousLine = 0;
  const keys = new Set<string>();
  items?.forEach((item, index) => {
    const itemPath = `${path}.${index}`;
    if (!record(item)) { issue(diagnostics, "invalid-type", itemPath, "Expected source-map entry."); return; }
    exactFields(item, ["stage", "nodeId", "generatedLine"], itemPath, diagnostics);
    if (item.stage !== "vertex" && item.stage !== "fragment") issue(diagnostics, "invalid-value", `${itemPath}.stage`, "Unknown shader stage.");
    validString(item.nodeId, `${itemPath}.nodeId`, diagnostics, SYMBOL_PATTERN);
    if (validInteger(item.generatedLine, 1, 1 << 24, `${itemPath}.generatedLine`, diagnostics)) {
      if (item.generatedLine < previousLine) issue(diagnostics, "non-canonical", path, "Source-map lines must be nondecreasing.");
      if (item.generatedLine > lineCount) issue(diagnostics, "missing-reference", `${itemPath}.generatedLine`, "Source-map line is outside the module.");
      previousLine = item.generatedLine;
    }
    const key = `${String(item.stage)}:${String(item.nodeId)}`;
    if (keys.has(key)) issue(diagnostics, "duplicate-id", itemPath, "Duplicate source-map entry.");
    keys.add(key);
  });
}

function validatePass(
  item: unknown,
  index: number,
  packageValue: DeepShaderPackageV2 | undefined,
  modules: ReadonlyMap<string, ShaderPackageModule>,
  diagnostics: ShaderPackageDiagnostic[],
): ShaderPackagePass | undefined {
  const path = `$.passes.${index}`;
  if (!record(item)) { issue(diagnostics, "invalid-type", path, "Expected pass record."); return undefined; }
  exactFields(item, ["id", "techniqueId", "passId", "kind", "moduleId", "cacheKey", "entryPoints", "sourceMap", "pipeline"], path, diagnostics);
  validString(item.id, `${path}.id`, diagnostics, RECORD_ID_PATTERN);
  validString(item.techniqueId, `${path}.techniqueId`, diagnostics, SYMBOL_PATTERN);
  validString(item.passId, `${path}.passId`, diagnostics, SYMBOL_PATTERN);
  if (typeof item.techniqueId === "string" && typeof item.passId === "string" && item.id !== `${item.techniqueId}/${item.passId}`) issue(diagnostics, "invalid-value", `${path}.id`, "Pass ID must be techniqueId/passId.");
  if (item.kind !== "forward" && item.kind !== "shadow") issue(diagnostics, "invalid-value", `${path}.kind`, "Only ABI render passes are supported.");
  validString(item.moduleId, `${path}.moduleId`, diagnostics, RECORD_ID_PATTERN);
  validString(item.cacheKey, `${path}.cacheKey`, diagnostics, HASH_PATTERN);
  const module = typeof item.moduleId === "string" ? modules.get(item.moduleId) : undefined;
  if (!module) issue(diagnostics, "missing-reference", `${path}.moduleId`, "Pass references an unknown module.");
  if (!record(item.entryPoints)) issue(diagnostics, "invalid-type", `${path}.entryPoints`, "Expected entry-point record.");
  else {
    exactFields(item.entryPoints, ["vertex", "fragment"], `${path}.entryPoints`, diagnostics);
    if (validString(item.entryPoints.vertex, `${path}.entryPoints.vertex`, diagnostics, SYMBOL_PATTERN)
      && module && !containsEntryPoint(module.source, "vertex", item.entryPoints.vertex)) issue(diagnostics, "missing-reference", `${path}.entryPoints.vertex`, "Vertex entry point is not declared by WGSL.");
    if (item.entryPoints.fragment !== null && (!validString(item.entryPoints.fragment, `${path}.entryPoints.fragment`, diagnostics, SYMBOL_PATTERN)
      || (module && !containsEntryPoint(module.source, "fragment", String(item.entryPoints.fragment))))) issue(diagnostics, "missing-reference", `${path}.entryPoints.fragment`, "Fragment entry point is not declared by WGSL.");
  }
  if (!record(item.pipeline)) issue(diagnostics, "invalid-type", `${path}.pipeline`, "Expected pipeline selection.");
  else exactFields(item.pipeline, ["passVariantId", "attachmentProfileId", "alphaMode", "rasterMode"], `${path}.pipeline`, diagnostics);
  const resolved = packageValue && record(item.pipeline)
    ? resolveShaderPackagePipeline(packageValue.shaderAbi.contract, item.pipeline as unknown as ShaderPackagePipelineSelection)
    : undefined;
  if (!resolved) issue(diagnostics, "invalid-value", `${path}.pipeline`, "Pipeline selection is not allowed by the shader ABI.");
  else {
    if (item.kind !== resolved.passVariant.pass) issue(diagnostics, "invalid-value", `${path}.kind`, "Pass kind disagrees with its ABI variant.");
    if (record(item.entryPoints) && (item.entryPoints.vertex !== resolved.passVariant.entryPoints.vertex
      || item.entryPoints.fragment !== resolved.passVariant.entryPoints.fragment)) issue(diagnostics, "invalid-value", `${path}.entryPoints`, "Entry points disagree with the ABI variant.");
  }
  validateSourceMap(item.sourceMap, `${path}.sourceMap`, module?.source.split("\n").length ?? 0, diagnostics);
  if (module && resolved && packageValue && record(item.entryPoints)) {
    const pass = item as unknown as ShaderPackagePass;
    const expected = computeDeepShaderPassCacheKey({
      schemaVersion: packageValue.schemaVersion, targetProfile: packageValue.targetProfile,
      compilerVersion: packageValue.compilerVersion, techniqueId: pass.techniqueId,
      passId: pass.passId, kind: pass.kind, module, entryPoints: pass.entryPoints,
      pipeline: pass.pipeline, shaderAbi: packageValue.shaderAbi, dependencies: packageValue.dependencies,
    });
    if (pass.cacheKey !== expected) issue(diagnostics, "cache-key-mismatch", `${path}.cacheKey`, "Pass cache key does not cover its complete executable state.");
  }
  return item as unknown as ShaderPackagePass;
}

function validatePasses(
  value: unknown,
  packageValue: DeepShaderPackageV2 | undefined,
  modules: ReadonlyMap<string, ShaderPackageModule>,
  diagnostics: ShaderPackageDiagnostic[],
): void {
  const items = requireArray(value, DEEP_SHADER_PACKAGE_BUDGETS.maxPasses, "$.passes", diagnostics);
  if (items?.length === 0) issue(diagnostics, "invalid-value", "$.passes", "At least one executable pass is required.");
  const ids = new Set<string>(), cacheKeys = new Set<string>(), usedModules = new Set<string>();
  const order: string[] = [];
  items?.some((item, index) => {
    const pass = validatePass(item, index, packageValue, modules, diagnostics);
    if (!pass) return diagnostics.length >= DEEP_SHADER_PACKAGE_BUDGETS.maxIssues;
    if (typeof pass.id === "string") {
      if (ids.has(pass.id)) issue(diagnostics, "duplicate-id", `$.passes.${index}.id`, "Duplicate pass ID.");
      ids.add(pass.id); order.push(pass.id);
    }
    if (typeof pass.cacheKey === "string") {
      if (cacheKeys.has(pass.cacheKey)) issue(diagnostics, "duplicate-cache-key", `$.passes.${index}.cacheKey`, "Duplicate pass cache key.");
      cacheKeys.add(pass.cacheKey);
    }
    if (typeof pass.moduleId === "string") usedModules.add(pass.moduleId);
    return diagnostics.length >= DEEP_SHADER_PACKAGE_BUDGETS.maxIssues;
  });
  requireCanonicalOrder(order, "$.passes", diagnostics);
  for (const id of modules.keys()) if (!usedModules.has(id)) issue(diagnostics, "missing-reference", "$.modules", `Module ${id} is unused.`);
}

export function validateDeepShaderPackage(input: unknown): ShaderPackageValidationResult {
  const diagnostics = [...inspectShaderPackageInput(input)];
  if (diagnostics.length > 0 || !record(input)) {
    if (!record(input) && diagnostics.length === 0) issue(diagnostics, "invalid-type", "$", "Expected shader package record.");
    return Object.freeze({ valid: false, diagnostics: Object.freeze(diagnostics) });
  }
  exactFields(input, ["schema", "schemaVersion", "packageId", "packageVersion", "compilerVersion", "targetProfile", "shaderAbi", "dependencies", "modules", "passes", "packageCacheKey"], "$", diagnostics);
  if (diagnostics.length >= DEEP_SHADER_PACKAGE_BUDGETS.maxIssues) return invalidResult(diagnostics);
  if (input.schema !== DEEP_SHADER_PACKAGE_SCHEMA) issue(diagnostics, "invalid-value", "$.schema", "Unknown package schema.");
  if (input.schemaVersion !== DEEP_SHADER_PACKAGE_SCHEMA_VERSION) issue(diagnostics, "invalid-value", "$.schemaVersion", "Schema v1 is rejected; executable package v2 is required.");
  validString(input.packageId, "$.packageId", diagnostics, PACKAGE_ID_PATTERN);
  validString(input.packageVersion, "$.packageVersion", diagnostics, VERSION_PATTERN);
  validString(input.compilerVersion, "$.compilerVersion", diagnostics, VERSION_PATTERN);
  if (input.targetProfile !== DEEP_SHADER_TARGET_PROFILE) issue(diagnostics, "invalid-value", "$.targetProfile", "Executable WGSL pipeline target is required.");
  const shaderAbi = validateShaderAbi(input.shaderAbi, diagnostics);
  if (diagnostics.length >= DEEP_SHADER_PACKAGE_BUDGETS.maxIssues) return invalidResult(diagnostics);
  const dependencies = validateDependencies(input.dependencies, diagnostics);
  if (diagnostics.length >= DEEP_SHADER_PACKAGE_BUDGETS.maxIssues) return invalidResult(diagnostics);
  const modules = validateModules(input.modules, dependencies.ids, diagnostics);
  if (diagnostics.length >= DEEP_SHADER_PACKAGE_BUDGETS.maxIssues) return invalidResult(diagnostics);
  const referenced = new Set([...modules.values()].flatMap((module) => [...module.dependencyIds]));
  for (const id of dependencies.ids) if (!referenced.has(id)) issue(diagnostics, "missing-reference", "$.dependencies", `Dependency ${id} is unused.`);
  const packageValue = shaderAbi
    && input.schemaVersion === DEEP_SHADER_PACKAGE_SCHEMA_VERSION
    && input.targetProfile === DEEP_SHADER_TARGET_PROFILE
    && typeof input.compilerVersion === "string"
    && Array.isArray(input.dependencies)
    && input.dependencies.length === dependencies.values.length
    && dependencies.values.length === dependencies.ids.size
    ? { ...input, shaderAbi, dependencies: dependencies.values } as unknown as DeepShaderPackageV2
    : undefined;
  validatePasses(input.passes, packageValue, modules, diagnostics);
  if (diagnostics.length >= DEEP_SHADER_PACKAGE_BUDGETS.maxIssues) return invalidResult(diagnostics);
  const cacheKeyIsValid = validString(input.packageCacheKey, "$.packageCacheKey", diagnostics, HASH_PATTERN);
  if (cacheKeyIsValid && diagnostics.length === 0
    && input.packageCacheKey !== computeDeepShaderPackageCacheKey(input as unknown as DeepShaderPackageV2)) {
    issue(diagnostics, "cache-key-mismatch", "$.packageCacheKey", "Package cache key mismatch.");
  }
  const frozen = Object.freeze(diagnostics.map((entry) => Object.freeze(entry)));
  return diagnostics.length === 0
    ? Object.freeze({ valid: true, diagnostics: frozen, value: immutableCanonicalSnapshot(input as unknown as DeepShaderPackageV2) })
    : Object.freeze({ valid: false, diagnostics: frozen });
}
