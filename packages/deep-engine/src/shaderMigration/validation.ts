import { SHADER_MIGRATION_FACETS, SHADER_SOURCE_KINDS } from "./constants.js";
import { addDiagnostic, type DiagnosticSink } from "./safeData.js";
import {
  SHADER_MIGRATION_SCHEMA_VERSION,
  type ShaderFacetEvidence,
  type ShaderFacetStatus,
  type ShaderMigrationFacet,
  type ShaderMigrationProfile,
  type ShaderMigrationRequirement,
  type ShaderSourceKind,
} from "./types.js";

const PROFILE_FIELDS = [
  "schemaVersion", "id", "sourceKind", "sourceVersion", "translatorVersion",
  "fixtureSetHash", "deterministic", "facets",
] as const;
const REQUIREMENT_FIELDS = [
  "target", "requiredFacets", "requireDeterministic", "acceptPartial", "allowBake",
  "bakeableFacets", "allowManualPort",
] as const;
const FACET_FIELDS = ["status", "evidenceIds", "reason"] as const;
const FACET_STATUSES: readonly ShaderFacetStatus[] = ["verified", "partial", "unsupported", "unverified"];
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  path: string,
  sink: DiagnosticSink,
): void {
  const allowed = new Set(fields);
  for (const key of Object.keys(value).sort()) {
    if (!allowed.has(key)) addDiagnostic(sink, "UNKNOWN_FIELD", `${path}.${key}`, "field is not in shader migration v1");
  }
  for (const key of fields) {
    if (!(key in value)) addDiagnostic(sink, "MISSING_FIELD", `${path}.${key}`, "required field is missing");
  }
}

function boundedText(value: unknown, path: string, sink: DiagnosticSink): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || value.trim() !== value) {
    addDiagnostic(sink, "INVALID_TEXT", path, "value must be bounded, non-blank text without outer whitespace");
    return false;
  }
  return true;
}

function parseFacetList(
  value: unknown,
  path: string,
  sink: DiagnosticSink,
  requireNonEmpty: boolean,
): ShaderMigrationFacet[] {
  if (!Array.isArray(value)) {
    addDiagnostic(sink, "INVALID_FACET_LIST", path, "value must be an array of shader facets");
    return [];
  }
  if (requireNonEmpty && value.length === 0) addDiagnostic(sink, "EMPTY_FACET_LIST", path, "at least one facet is required");
  const found = new Set<ShaderMigrationFacet>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!SHADER_MIGRATION_FACETS.includes(item as ShaderMigrationFacet)) {
      addDiagnostic(sink, "UNKNOWN_FACET", `${path}[${index}]`, "facet is not in shader migration v1");
    } else if (found.has(item as ShaderMigrationFacet)) {
      addDiagnostic(sink, "DUPLICATE_FACET", `${path}[${index}]`, "facet is duplicated");
    } else {
      found.add(item as ShaderMigrationFacet);
    }
  }
  return SHADER_MIGRATION_FACETS.filter((facet) => found.has(facet));
}

function parseEvidenceIds(value: unknown, path: string, sink: DiagnosticSink): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    addDiagnostic(sink, "MISSING_EVIDENCE", path, "every facet status requires at least one evidence id");
    return [];
  }
  const output: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const id = value[index];
    if (typeof id !== "string" || !STABLE_ID.test(id)) {
      addDiagnostic(sink, "INVALID_EVIDENCE_ID", `${path}[${index}]`, "evidence id is invalid");
    } else output.push(id);
  }
  const canonical = [...new Set(output)].sort();
  if (canonical.length !== output.length || canonical.some((id, index) => id !== output[index])) {
    addDiagnostic(sink, "NON_CANONICAL_EVIDENCE", path, "evidence ids must be unique and lexically sorted");
  }
  return canonical;
}

function parseFacet(value: unknown, path: string, sink: DiagnosticSink): ShaderFacetEvidence | undefined {
  if (!isRecord(value)) {
    addDiagnostic(sink, "INVALID_FACET", path, "facet evidence must be a plain data object");
    return undefined;
  }
  exactFields(value, FACET_FIELDS, path, sink);
  const status = value.status as ShaderFacetStatus;
  if (!FACET_STATUSES.includes(status)) addDiagnostic(sink, "INVALID_STATUS", `${path}.status`, "facet status is invalid");
  const evidenceIds = parseEvidenceIds(value.evidenceIds, `${path}.evidenceIds`, sink);
  const reason = value.reason;
  if (status === "verified" && reason !== null) {
    addDiagnostic(sink, "UNEXPECTED_REASON", `${path}.reason`, "verified facets must use a null reason");
  } else if (status !== "verified" && !boundedText(reason, `${path}.reason`, sink)) {
    addDiagnostic(sink, "MISSING_REASON", `${path}.reason`, "non-verified facets require a bounded reason");
  }
  if (!FACET_STATUSES.includes(status)) return undefined;
  return { status, evidenceIds, reason: typeof reason === "string" ? reason : null };
}

export function parseShaderMigrationProfile(input: unknown, sink: DiagnosticSink): ShaderMigrationProfile | undefined {
  if (!isRecord(input)) {
    addDiagnostic(sink, "INVALID_PROFILE", "$.profile", "profile must be a plain data object");
    return undefined;
  }
  exactFields(input, PROFILE_FIELDS, "$.profile", sink);
  if (input.schemaVersion !== SHADER_MIGRATION_SCHEMA_VERSION) {
    addDiagnostic(sink, "SCHEMA_VERSION", "$.profile.schemaVersion", "schemaVersion must be 1");
  }
  if (typeof input.id !== "string" || !STABLE_ID.test(input.id)) addDiagnostic(sink, "INVALID_ID", "$.profile.id", "profile id is invalid");
  if (!SHADER_SOURCE_KINDS.includes(input.sourceKind as ShaderSourceKind)) {
    addDiagnostic(sink, "UNKNOWN_SOURCE", "$.profile.sourceKind", "shader source kind is unsupported or unknown");
  }
  boundedText(input.sourceVersion, "$.profile.sourceVersion", sink);
  boundedText(input.translatorVersion, "$.profile.translatorVersion", sink);
  if (typeof input.fixtureSetHash !== "string" || !SHA256.test(input.fixtureSetHash)) {
    addDiagnostic(sink, "INVALID_HASH", "$.profile.fixtureSetHash", "fixtureSetHash must be lowercase SHA-256");
  }
  if (typeof input.deterministic !== "boolean") addDiagnostic(sink, "INVALID_BOOLEAN", "$.profile.deterministic", "value must be boolean");

  const facets = {} as Record<ShaderMigrationFacet, ShaderFacetEvidence>;
  if (!isRecord(input.facets)) addDiagnostic(sink, "INVALID_FACETS", "$.profile.facets", "facets must be a complete object");
  else {
    exactFields(input.facets, SHADER_MIGRATION_FACETS, "$.profile.facets", sink);
    for (const facet of SHADER_MIGRATION_FACETS) {
      const parsed = parseFacet(input.facets[facet], `$.profile.facets.${facet}`, sink);
      if (parsed) facets[facet] = parsed;
    }
  }
  if (sink.diagnostics.length > 0) return undefined;
  return input as unknown as ShaderMigrationProfile;
}

export function parseShaderMigrationRequirement(input: unknown, sink: DiagnosticSink): ShaderMigrationRequirement | undefined {
  if (!isRecord(input)) {
    addDiagnostic(sink, "INVALID_REQUIREMENT", "$.requirement", "requirement must be a plain data object");
    return undefined;
  }
  exactFields(input, REQUIREMENT_FIELDS, "$.requirement", sink);
  if (input.target !== "deep-native" && input.target !== "deep-webgpu") {
    addDiagnostic(sink, "INVALID_TARGET", "$.requirement.target", "target must be deep-native or deep-webgpu");
  }
  for (const field of ["requireDeterministic", "acceptPartial", "allowBake", "allowManualPort"] as const) {
    if (typeof input[field] !== "boolean") addDiagnostic(sink, "INVALID_BOOLEAN", `$.requirement.${field}`, "value must be boolean");
  }
  const requiredFacets = parseFacetList(input.requiredFacets, "$.requirement.requiredFacets", sink, true);
  const bakeableFacets = parseFacetList(input.bakeableFacets, "$.requirement.bakeableFacets", sink, false);
  if (input.allowBake === false && bakeableFacets.length > 0) {
    addDiagnostic(sink, "INCONSISTENT_BAKE_POLICY", "$.requirement.bakeableFacets", "bakeableFacets must be empty when baking is disabled");
  }
  const required = new Set(requiredFacets);
  for (const facet of bakeableFacets) {
    if (!required.has(facet)) addDiagnostic(sink, "UNREQUIRED_BAKE_FACET", "$.requirement.bakeableFacets", `${facet} is not required`);
  }
  if (sink.diagnostics.length > 0) return undefined;
  return {
    target: input.target as ShaderMigrationRequirement["target"],
    requiredFacets,
    requireDeterministic: input.requireDeterministic as boolean,
    acceptPartial: input.acceptPartial as boolean,
    allowBake: input.allowBake as boolean,
    bakeableFacets,
    allowManualPort: input.allowManualPort as boolean,
  };
}
