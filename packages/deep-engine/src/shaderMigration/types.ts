export const SHADER_MIGRATION_SCHEMA_VERSION = 1 as const;

export type ShaderSourceKind =
  | "unity-standard"
  | "unity-urp-lit"
  | "unity-unlit"
  | "unity-simple-lit"
  | "unity-hdrp-lit"
  | "unity-shader-graph"
  | "unity-shaderlab-hlsl"
  | "three-mesh-standard"
  | "three-mesh-physical"
  | "three-shader-material"
  | "three-on-before-compile"
  | "three-tsl";

export type ShaderMigrationFacet =
  | "properties"
  | "render-state"
  | "passes"
  | "surface-features"
  | "vertex-deformation"
  | "keywords-variants"
  | "custom-code"
  | "compute"
  | "source-mapping";

export type ShaderFacetStatus = "verified" | "partial" | "unsupported" | "unverified";

export type ShaderMigrationStrategy =
  | "direct-template"
  | "graph-translate"
  | "code-subset"
  | "bake"
  | "manual-port"
  | "rejected";

export interface ShaderFacetEvidence {
  readonly status: ShaderFacetStatus;
  readonly evidenceIds: readonly string[];
  readonly reason: string | null;
}

export interface ShaderMigrationProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceKind: ShaderSourceKind;
  readonly sourceVersion: string;
  readonly translatorVersion: string;
  readonly fixtureSetHash: string;
  readonly deterministic: boolean;
  readonly facets: Readonly<Record<ShaderMigrationFacet, ShaderFacetEvidence>>;
}

export interface ShaderMigrationRequirement {
  readonly target: "deep-native" | "deep-webgpu";
  readonly requiredFacets: readonly ShaderMigrationFacet[];
  readonly requireDeterministic: boolean;
  readonly acceptPartial: boolean;
  readonly allowBake: boolean;
  readonly bakeableFacets: readonly ShaderMigrationFacet[];
  readonly allowManualPort: boolean;
}

export interface ShaderMigrationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface ShaderMigrationEvaluation {
  readonly valid: boolean;
  readonly eligible: boolean;
  readonly strategy: ShaderMigrationStrategy;
  readonly automatic: boolean;
  readonly lossless: boolean;
  readonly diagnostics: readonly ShaderMigrationDiagnostic[];
  readonly partial: readonly ShaderMigrationFacet[];
  readonly unsupported: readonly ShaderMigrationFacet[];
  readonly unverified: readonly ShaderMigrationFacet[];
  readonly evidenceIds: readonly string[];
}
