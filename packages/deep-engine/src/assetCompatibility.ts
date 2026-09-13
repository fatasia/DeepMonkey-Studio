export const ASSET_COMPATIBILITY_SCHEMA_VERSION = 1 as const;

export type AssetSourceKind =
  | "model-file"
  | "unity-project"
  | "unity-asset-package"
  | "unity-upm-package"
  | "unity-asset-bundle"
  | "unity-addressables"
  | "unity-web-build";

export type AssetImporterKind =
  | "direct-parser"
  | "open-converter"
  | "licensed-converter"
  | "unity-editor-exporter"
  | "legacy-isolated";

export type AssetRuntimeArtifact = "deep-asset-package" | "legacy-runtime" | "none";
export type AssetFacetStatus = "verified" | "partial" | "unsupported" | "unverified";
export type AssetFacet =
  | "geometry"
  | "hierarchy"
  | "materials"
  | "textures"
  | "animation"
  | "skin"
  | "morph"
  | "cameras"
  | "lights"
  | "colliders"
  | "navmesh"
  | "metadata"
  | "pmi"
  | "behavior"
  | "audio";

export const ASSET_FACETS: readonly AssetFacet[] = Object.freeze([
  "geometry", "hierarchy", "materials", "textures", "animation", "skin", "morph",
  "cameras", "lights", "colliders", "navmesh", "metadata", "pmi", "behavior", "audio",
]);

export interface AssetFacetEvidence {
  readonly status: AssetFacetStatus;
  readonly evidenceIds: readonly string[];
  readonly reason: string | null;
}

export interface AssetCompatibilityProfile {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly sourceKind: AssetSourceKind;
  readonly format: string;
  readonly importer: AssetImporterKind;
  readonly runtimeArtifact: AssetRuntimeArtifact;
  readonly importerVersion: string;
  readonly fixtureSetHash: string;
  readonly deterministic: boolean;
  readonly facets: Readonly<Record<AssetFacet, AssetFacetEvidence>>;
}

export interface AssetCompatibilityRequirement {
  readonly target: "native-viewer" | "native-studio" | "round-trip";
  readonly requiredFacets: readonly AssetFacet[];
  readonly requireDeterministicOutput: boolean;
}

export interface AssetCompatibilityEvaluation {
  readonly valid: boolean;
  readonly eligible: boolean;
  readonly issues: readonly string[];
  readonly unsupported: readonly AssetFacet[];
  readonly partial: readonly AssetFacet[];
  readonly unverified: readonly AssetFacet[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const FORMAT = /^[a-z0-9][a-z0-9._+-]{0,31}$/;
const HASH = /^[a-f0-9]{64}$/;
const UNITY_MIGRATION_SOURCES = new Set<AssetSourceKind>([
  "unity-project", "unity-asset-package", "unity-upm-package", "unity-asset-bundle", "unity-addressables",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[], path: string, issues: string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) issues.push(`${path}.${key} is not part of asset compatibility v1`);
}

function validateFacet(value: unknown, path: string, issues: string[]): AssetFacetEvidence | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be a facet evidence object`);
    return undefined;
  }
  knownKeys(value, ["status", "evidenceIds", "reason"], path, issues);
  if (!["verified", "partial", "unsupported", "unverified"].includes(value.status as string)) issues.push(`${path}.status is invalid`);
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.some((id) => typeof id !== "string" || !ID.test(id))) {
    issues.push(`${path}.evidenceIds must contain stable ids`);
  }
  if (!(value.reason === null || (typeof value.reason === "string" && value.reason.trim().length > 0 && value.reason.length <= 1024))) {
    issues.push(`${path}.reason must be null or bounded non-blank text`);
  }
  const evidenceIds = Array.isArray(value.evidenceIds) ? value.evidenceIds as string[] : [];
  if (value.status === "verified" && evidenceIds.length === 0) issues.push(`${path} is verified without evidence`);
  if ((value.status === "unsupported" || value.status === "partial") && value.reason === null) issues.push(`${path} requires a reason`);
  return value as unknown as AssetFacetEvidence;
}

export function evaluateAssetCompatibility(
  input: unknown,
  requirement: AssetCompatibilityRequirement,
): AssetCompatibilityEvaluation {
  const issues: string[] = [];
  const unsupported: AssetFacet[] = [];
  const partial: AssetFacet[] = [];
  const unverified: AssetFacet[] = [];
  if (!isRecord(input)) return { valid: false, eligible: false, issues: ["profile must be a plain object"], unsupported, partial, unverified };
  knownKeys(input, ["schemaVersion", "id", "sourceKind", "format", "importer", "runtimeArtifact", "importerVersion", "fixtureSetHash", "deterministic", "facets"], "profile", issues);
  if (input.schemaVersion !== ASSET_COMPATIBILITY_SCHEMA_VERSION) issues.push("profile.schemaVersion must be 1");
  if (typeof input.id !== "string" || !ID.test(input.id)) issues.push("profile.id is invalid");
  const sourceKinds: AssetSourceKind[] = ["model-file", "unity-project", "unity-asset-package", "unity-upm-package", "unity-asset-bundle", "unity-addressables", "unity-web-build"];
  const importers: AssetImporterKind[] = ["direct-parser", "open-converter", "licensed-converter", "unity-editor-exporter", "legacy-isolated"];
  const artifacts: AssetRuntimeArtifact[] = ["deep-asset-package", "legacy-runtime", "none"];
  if (!sourceKinds.includes(input.sourceKind as AssetSourceKind)) issues.push("profile.sourceKind is invalid");
  if (typeof input.format !== "string" || !FORMAT.test(input.format)) issues.push("profile.format must be a normalized extension or package kind");
  if (!importers.includes(input.importer as AssetImporterKind)) issues.push("profile.importer is invalid");
  if (!artifacts.includes(input.runtimeArtifact as AssetRuntimeArtifact)) issues.push("profile.runtimeArtifact is invalid");
  if (typeof input.importerVersion !== "string" || !input.importerVersion.trim() || input.importerVersion.length > 128) issues.push("profile.importerVersion is invalid");
  if (typeof input.fixtureSetHash !== "string" || !HASH.test(input.fixtureSetHash)) issues.push("profile.fixtureSetHash must be lowercase SHA-256");
  if (typeof input.deterministic !== "boolean") issues.push("profile.deterministic must be boolean");

  const facetValues = new Map<AssetFacet, AssetFacetEvidence>();
  if (!isRecord(input.facets)) issues.push("profile.facets must be a complete object");
  else {
    knownKeys(input.facets, ASSET_FACETS, "profile.facets", issues);
    for (const facet of ASSET_FACETS) {
      const checked = validateFacet(input.facets[facet], `profile.facets.${facet}`, issues);
      if (checked) facetValues.set(facet, checked);
    }
  }

  const sourceKind = input.sourceKind as AssetSourceKind;
  const importer = input.importer as AssetImporterKind;
  const artifact = input.runtimeArtifact as AssetRuntimeArtifact;
  if (sourceKind === "unity-web-build" && (importer !== "legacy-isolated" || artifact !== "legacy-runtime")) {
    issues.push("Unity Web builds are legacy opaque runtimes and cannot become a Deep native asset");
  }
  if (UNITY_MIGRATION_SOURCES.has(sourceKind) && importer !== "unity-editor-exporter") {
    issues.push(`${sourceKind} requires the isolated Unity Editor exporter`);
  }
  if (importer === "legacy-isolated" && artifact !== "legacy-runtime") issues.push("legacy-isolated imports must remain legacy-runtime artifacts");
  if (artifact === "legacy-runtime" && importer !== "legacy-isolated") issues.push("legacy runtime artifacts must use the isolated legacy importer");

  const required = new Set<AssetFacet>();
  for (const facet of requirement.requiredFacets) {
    if (!ASSET_FACETS.includes(facet)) issues.push(`requirement contains unknown facet ${String(facet)}`);
    else if (required.has(facet)) issues.push(`requirement duplicates facet ${facet}`);
    else required.add(facet);
  }
  for (const facet of required) {
    const status = facetValues.get(facet)?.status;
    if (status === "unsupported") unsupported.push(facet);
    else if (status === "partial") partial.push(facet);
    else if (status !== "verified") unverified.push(facet);
  }
  const nativeTarget = requirement.target === "native-viewer" || requirement.target === "native-studio";
  if (requirement.target === "round-trip" && sourceKind !== "model-file") {
    const behavior = facetValues.get("behavior")?.status;
    if (behavior !== "verified") unverified.push("behavior");
  }
  const eligible = issues.length === 0
    && (!nativeTarget || artifact === "deep-asset-package")
    && (!requirement.requireDeterministicOutput || input.deterministic === true)
    && unsupported.length === 0 && partial.length === 0 && unverified.length === 0;
  return { valid: issues.length === 0, eligible, issues, unsupported, partial, unverified: [...new Set(unverified)] };
}
