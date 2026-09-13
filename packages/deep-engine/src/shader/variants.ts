import { sha256Hex } from "./canonical.js";
import { DEEP_SHADER_BUDGETS } from "./constants.js";
import { frozenDiagnostics, issue } from "./diagnostics.js";
import { exactFields, inspectCanonicalShaderInput, record } from "./safeInput.js";
import { validateShaderAsset } from "./validation.js";
import type {
  ShaderCompileCapabilities, ShaderDiagnostic, ShaderFeaturePredicate,
  ShaderTargetRequirements, ShaderVariant, ShaderVariantPlan,
} from "./types.js";

function predicateKeywords(predicate: ShaderFeaturePredicate | undefined, result: Set<string>): void {
  if (!predicate) return;
  if (predicate.op === "keyword") result.add(predicate.name);
  else if (predicate.op === "all" || predicate.op === "any") predicate.terms.forEach((term) => predicateKeywords(term, result));
  else if (predicate.op === "not") predicateKeywords(predicate.term, result);
}

function evaluate(
  predicate: ShaderFeaturePredicate | undefined,
  keywords: Readonly<Record<string, string>>,
  capabilities: ReadonlySet<string>,
): boolean {
  if (!predicate) return true;
  if (predicate.op === "keyword") return keywords[predicate.name] === predicate.equals;
  if (predicate.op === "capability") return capabilities.has(predicate.name);
  if (predicate.op === "all") return predicate.terms.every((term) => evaluate(term, keywords, capabilities));
  if (predicate.op === "any") return predicate.terms.some((term) => evaluate(term, keywords, capabilities));
  if (predicate.op === "not") return !evaluate(predicate.term, keywords, capabilities);
  return false;
}

export function requirementsMet(requirements: ShaderTargetRequirements, capabilities: ShaderCompileCapabilities): boolean {
  if (requirements.features?.some((feature) => !capabilities.features.includes(feature))) return false;
  const limits = requirements.minLimits;
  return !limits
    || (limits.maxBindGroups ?? 0) <= capabilities.limits.maxBindGroups
    && (limits.maxBindingsPerBindGroup ?? 0) <= capabilities.limits.maxBindingsPerBindGroup
    && (limits.maxInterStageShaderVariables ?? 0) <= capabilities.limits.maxInterStageShaderVariables;
}

const CAPABILITIES = new Set(["depth-clip-control", "float32-filterable", "indirect-first-instance", "shader-f16", "texture-compression-bc", "texture-compression-etc2", "texture-compression-astc"]);

export function validateCompileCapabilities(value: unknown, diagnostics: ShaderDiagnostic[]): value is ShaderCompileCapabilities {
  if (!inspectCanonicalShaderInput(value, diagnostics, "capabilities")) return false;
  if (!record(value)) { issue(diagnostics, "invalid-type", "capabilities", "Expected compile capabilities."); return false; }
  exactFields(value, ["features", "limits"], "capabilities", diagnostics);
  if (!Array.isArray(value.features)) issue(diagnostics, "invalid-type", "capabilities.features", "Expected capability feature array.");
  if (!record(value.limits)) issue(diagnostics, "invalid-type", "capabilities.limits", "Expected capability limits.");
  if (!Array.isArray(value.features) || !record(value.limits)) return false;
  exactFields(value.limits, ["maxBindGroups", "maxBindingsPerBindGroup", "maxInterStageShaderVariables"], "capabilities.limits", diagnostics);
  let previous = "";
  for (const [index, feature] of value.features.entries()) {
    if (typeof feature !== "string" || !CAPABILITIES.has(feature)) issue(diagnostics, "invalid-value", `capabilities.features.${index}`, "Unknown target capability.");
    if (typeof feature !== "string") continue;
    if (feature <= previous) issue(diagnostics, "non-deterministic", `capabilities.features.${index}`, "Capability features must be sorted and unique.");
    previous = feature;
  }
  for (const key of ["maxBindGroups", "maxBindingsPerBindGroup", "maxInterStageShaderVariables"] as const) {
    const limit = value.limits[key];
    if (!Number.isSafeInteger(limit) || (limit as number) < 1) issue(diagnostics, "invalid-value", `capabilities.limits.${key}`, "Capability limit must be a positive integer.");
  }
  return diagnostics.length === 0;
}

export function planShaderVariants(
  input: unknown,
  capabilitiesInput: unknown,
  maxVariants = DEEP_SHADER_BUDGETS.maxVariants,
): ShaderVariantPlan {
  const validation = validateShaderAsset(input);
  if (!validation.valid || !validation.value) return Object.freeze({ valid: false, diagnostics: validation.diagnostics, variants: Object.freeze([]) });
  const diagnostics: ShaderDiagnostic[] = [];
  if (!validateCompileCapabilities(capabilitiesInput, diagnostics)) return Object.freeze({ valid: false, diagnostics: frozenDiagnostics(diagnostics), variants: Object.freeze([]) });
  const capabilities = capabilitiesInput;
  if (!Number.isSafeInteger(maxVariants) || maxVariants < 1 || maxVariants > DEEP_SHADER_BUDGETS.maxVariants) {
    issue(diagnostics, "variant-budget", "maxVariants", `Variant budget must be from 1 to ${DEEP_SHADER_BUDGETS.maxVariants}.`);
  }
  const asset = validation.value;
  const used = new Set<string>();
  asset.techniques.forEach((technique) => {
    predicateKeywords(technique.predicate, used);
    technique.passes.forEach((pass) => predicateKeywords(pass.predicate, used));
  });
  const dimensions = asset.keywords.filter((keyword) => used.has(keyword.name)).sort((a, b) => a.name.localeCompare(b.name));
  let combinations = 1;
  for (const keyword of dimensions) {
    combinations *= keyword.values.length;
    if (combinations > DEEP_SHADER_BUDGETS.maxRawKeywordCombinations) {
      issue(diagnostics, "variant-budget", "$.keywords", `Referenced keyword space exceeds ${DEEP_SHADER_BUDGETS.maxRawKeywordCombinations} combinations.`);
      return Object.freeze({ valid: false, diagnostics: frozenDiagnostics(diagnostics), variants: Object.freeze([]) });
    }
  }
  if (diagnostics.length > 0) return Object.freeze({ valid: false, diagnostics: frozenDiagnostics(diagnostics), variants: Object.freeze([]) });

  const capabilitySet = new Set<string>(capabilities.features);
  const defaults = Object.fromEntries(asset.keywords.map((entry) => [entry.name, entry.default]));
  const candidates: Record<string, string>[] = [];
  const expand = (index: number, current: Record<string, string>): void => {
    const keyword = dimensions[index];
    if (!keyword) { candidates.push({ ...defaults, ...current }); return; }
    keyword.values.forEach((value) => { current[keyword.name] = value; expand(index + 1, current); });
    delete current[keyword.name];
  };
  expand(0, {});
  const variants: ShaderVariant[] = [];
  const signatures = new Set<string>();
  for (const keywords of candidates) {
    const activeTechniques = asset.techniques.filter((technique) => requirementsMet(technique.requirements, capabilities) && evaluate(technique.predicate, keywords, capabilitySet));
    const passIds = activeTechniques.flatMap((technique) => technique.passes
      .filter((pass) => (!pass.requirements || requirementsMet(pass.requirements, capabilities)) && evaluate(pass.predicate, keywords, capabilitySet))
      .map((pass) => pass.id));
    if (passIds.length === 0) continue;
    const techniqueIds = activeTechniques.filter((technique) => technique.passes.some((pass) => passIds.includes(pass.id))).map((technique) => technique.id);
    const signature = JSON.stringify([techniqueIds, passIds]);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    const stableKeywords = Object.freeze(Object.fromEntries(Object.entries(keywords).sort(([a], [b]) => a.localeCompare(b))));
    variants.push(Object.freeze({ key: sha256Hex({ asset: asset.id, keywords: stableKeywords, techniqueIds, passIds }), keywords: stableKeywords, techniqueIds: Object.freeze(techniqueIds), passIds: Object.freeze(passIds) }));
    if (variants.length > maxVariants) {
      issue(diagnostics, "variant-budget", "$.keywords", `Static variant output exceeds the budget of ${maxVariants}.`);
      return Object.freeze({ valid: false, diagnostics: frozenDiagnostics(diagnostics), variants: Object.freeze([]) });
    }
  }
  if (variants.length === 0) issue(diagnostics, "unsupported-capability", "capabilities", "No pass is compatible with the target capabilities and keyword predicates.");
  return Object.freeze({ valid: diagnostics.length === 0, diagnostics: frozenDiagnostics(diagnostics), variants: Object.freeze(variants) });
}
