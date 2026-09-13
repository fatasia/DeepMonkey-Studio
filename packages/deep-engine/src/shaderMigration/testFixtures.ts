import { SHADER_MIGRATION_FACETS } from "./constants.js";
import type {
  ShaderFacetEvidence,
  ShaderFacetStatus,
  ShaderMigrationFacet,
  ShaderMigrationProfile,
  ShaderMigrationRequirement,
  ShaderSourceKind,
} from "./types.js";

export function evidence(status: ShaderFacetStatus = "verified", id = "fixture:shader-v1"): ShaderFacetEvidence {
  return {
    status,
    evidenceIds: [id],
    reason: status === "verified" ? null : `fixture records ${status} coverage`,
  };
}

export function profile(
  sourceKind: ShaderSourceKind = "unity-urp-lit",
  overrides: Partial<Record<ShaderMigrationFacet, ShaderFacetEvidence>> = {},
): ShaderMigrationProfile {
  return {
    schemaVersion: 1,
    id: `profile:${sourceKind}`,
    sourceKind,
    sourceVersion: "fixture-1",
    translatorVersion: "deep-shader-migration-1",
    fixtureSetHash: "a".repeat(64),
    deterministic: true,
    facets: Object.fromEntries(SHADER_MIGRATION_FACETS.map((facet) => [facet, overrides[facet] ?? evidence()])) as Record<
      ShaderMigrationFacet,
      ShaderFacetEvidence
    >,
  };
}

export function requirement(overrides: Partial<ShaderMigrationRequirement> = {}): ShaderMigrationRequirement {
  return {
    target: "deep-native",
    requiredFacets: [...SHADER_MIGRATION_FACETS],
    requireDeterministic: true,
    acceptPartial: false,
    allowBake: false,
    bakeableFacets: [],
    allowManualPort: false,
    ...overrides,
  };
}
