import { DIRECT_TEMPLATE_SOURCES, GRAPH_TRANSLATE_SOURCES, SHADER_MIGRATION_FACETS } from "./constants.js";
import { addDiagnostic, safeDataSnapshot, type DiagnosticSink } from "./safeData.js";
import type {
  ShaderMigrationEvaluation,
  ShaderMigrationFacet,
  ShaderMigrationProfile,
  ShaderMigrationRequirement,
  ShaderMigrationStrategy,
} from "./types.js";
import { parseShaderMigrationProfile, parseShaderMigrationRequirement } from "./validation.js";

function baseStrategy(profile: ShaderMigrationProfile): ShaderMigrationStrategy {
  if (DIRECT_TEMPLATE_SOURCES.has(profile.sourceKind)) return "direct-template";
  if (GRAPH_TRANSLATE_SOURCES.has(profile.sourceKind)) return "graph-translate";
  return "code-subset";
}

function rejected(sink: DiagnosticSink): ShaderMigrationEvaluation {
  return {
    valid: false,
    eligible: false,
    strategy: "rejected",
    automatic: false,
    lossless: false,
    diagnostics: sink.diagnostics,
    partial: [],
    unsupported: [],
    unverified: [],
    evidenceIds: [],
  };
}

function routeDegradation(
  partial: readonly ShaderMigrationFacet[],
  unsupported: readonly ShaderMigrationFacet[],
  requirement: ShaderMigrationRequirement,
): ShaderMigrationStrategy {
  const degraded = [...partial, ...unsupported];
  const bakeable = new Set(requirement.bakeableFacets);
  if (degraded.length > 0 && requirement.allowBake && degraded.every((facet) => bakeable.has(facet))) return "bake";
  if (requirement.allowManualPort) return "manual-port";
  return "rejected";
}

export function evaluateShaderMigration(profileInput: unknown, requirementInput: unknown): ShaderMigrationEvaluation {
  const sink: DiagnosticSink = { diagnostics: [], capped: false };
  try {
    const profileSnapshot = safeDataSnapshot(profileInput, sink);
    const requirementSnapshot = safeDataSnapshot(requirementInput, sink);
    if (sink.diagnostics.length > 0) return rejected(sink);
    const profile = parseShaderMigrationProfile(profileSnapshot, sink);
    const requirement = parseShaderMigrationRequirement(requirementSnapshot, sink);
    if (!profile || !requirement || sink.diagnostics.length > 0) return rejected(sink);

    const partial = SHADER_MIGRATION_FACETS.filter((facet) => profile.facets[facet].status === "partial");
    const unsupported = SHADER_MIGRATION_FACETS.filter((facet) => profile.facets[facet].status === "unsupported");
    const unverified = SHADER_MIGRATION_FACETS.filter((facet) => profile.facets[facet].status === "unverified");
    const evidenceIds = [...new Set(SHADER_MIGRATION_FACETS.flatMap((facet) => profile.facets[facet].evidenceIds))].sort();
    const required = new Set(requirement.requiredFacets);
    const requiredPartial = partial.filter((facet) => required.has(facet));
    const requiredUnsupported = unsupported.filter((facet) => required.has(facet));
    const requiredUnverified = unverified.filter((facet) => required.has(facet));

    let strategy = baseStrategy(profile);
    if (requiredUnverified.length > 0) {
      strategy = "rejected";
      addDiagnostic(sink, "UNVERIFIED_FACET", "$.profile.facets", "required facets contain unverified migration behavior");
    } else if (requiredUnsupported.length > 0 || (requiredPartial.length > 0 && !requirement.acceptPartial)) {
      strategy = routeDegradation(requiredPartial, requiredUnsupported, requirement);
      if (strategy === "rejected") {
        addDiagnostic(sink, "NO_SAFE_ROUTE", "$.requirement", "required degradation has no explicitly permitted route");
      }
    }
    if (requirement.requireDeterministic && !profile.deterministic) {
      strategy = "rejected";
      addDiagnostic(sink, "NON_DETERMINISTIC", "$.profile.deterministic", "target requires deterministic migration output");
    }
    const eligible = strategy !== "rejected";
    return {
      valid: true,
      eligible,
      strategy,
      automatic: eligible && strategy !== "manual-port",
      lossless: eligible && partial.length === 0 && unsupported.length === 0 && strategy !== "bake",
      diagnostics: sink.diagnostics,
      partial,
      unsupported,
      unverified,
      evidenceIds,
    };
  } catch {
    addDiagnostic(sink, "EVALUATOR_FAILURE", "$", "shader migration input could not be evaluated safely");
    return rejected(sink);
  }
}
