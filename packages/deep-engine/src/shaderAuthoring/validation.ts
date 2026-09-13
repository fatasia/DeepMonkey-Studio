import { canonicalShaderJson, sha256Hex } from "../shader/canonical.js";
import { validateShaderAsset } from "../shader/index.js";
import { deepFreeze, readCanonicalInput } from "./safety.js";
import {
  SHADER_AUTHORING_BUDGETS,
  type ShaderAuthoringDiagnostic,
  type ShaderAuthoringDocument,
  type ShaderAuthoringPersistedSnapshot,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

function diagnostic(
  source: "document" | "snapshot",
  code: string,
  path: string,
  message: string,
): ShaderAuthoringDiagnostic {
  return Object.freeze({ severity: "error", source, code, path, message });
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(
  value: Record<string, unknown>,
  accepted: readonly string[],
  source: "document" | "snapshot",
  path: string,
  diagnostics: ShaderAuthoringDiagnostic[],
): void {
  const fields = new Set(accepted);
  for (const key of Object.keys(value)) {
    if (!fields.has(key)) diagnostics.push(diagnostic(source, "unknown-field", `${path}.${key}`, "Unknown field."));
  }
}

function validIdentifier(
  value: unknown,
  path: string,
  source: "document" | "snapshot",
  diagnostics: ShaderAuthoringDiagnostic[],
): value is string {
  if (typeof value === "string" && IDENTIFIER.test(value)) return true;
  diagnostics.push(diagnostic(source, "invalid-value", path, "Expected a stable identifier."));
  return false;
}

function validateClonedDocument(
  value: unknown,
  source: "document" | "snapshot",
  path = "$",
): Readonly<{ value?: ShaderAuthoringDocument; diagnostics: readonly ShaderAuthoringDiagnostic[] }> {
  const diagnostics: ShaderAuthoringDiagnostic[] = [];
  if (!record(value)) {
    diagnostics.push(diagnostic(source, "invalid-type", path, "Expected an authoring document record."));
    return Object.freeze({ diagnostics: Object.freeze(diagnostics) });
  }
  if (value.schemaVersion !== 1) diagnostics.push(diagnostic(source, "invalid-value", `${path}.schemaVersion`, "Unsupported authoring schema version."));
  validIdentifier(value.id, `${path}.id`, source, diagnostics);
  if (value.mode === "graph") {
    exactFields(value, ["schemaVersion", "id", "mode", "asset", "techniqueId", "passId"], source, path, diagnostics);
    validIdentifier(value.techniqueId, `${path}.techniqueId`, source, diagnostics);
    validIdentifier(value.passId, `${path}.passId`, source, diagnostics);
    const asset = validateShaderAsset(value.asset);
    diagnostics.push(...asset.diagnostics.map((entry) => diagnostic(source, entry.code, `${path}.asset${entry.path.slice(1)}`, entry.message)));
    if (diagnostics.length === 0 && asset.value) {
      return Object.freeze({
        value: deepFreeze<ShaderAuthoringDocument>({
          schemaVersion: 1,
          id: value.id as string,
          mode: "graph",
          asset: asset.value,
          techniqueId: value.techniqueId as string,
          passId: value.passId as string,
        }),
        diagnostics: Object.freeze([]),
      });
    }
  } else if (value.mode === "text") {
    exactFields(value, ["schemaVersion", "id", "mode", "language", "source"], source, path, diagnostics);
    if (value.language !== "deepsl") diagnostics.push(diagnostic(source, "invalid-value", `${path}.language`, "Only the versioned DeepSL authoring language identifier is accepted."));
    if (typeof value.source !== "string") diagnostics.push(diagnostic(source, "invalid-type", `${path}.source`, "Expected text source."));
    else if (value.source.length > SHADER_AUTHORING_BUDGETS.maxSourceLength) diagnostics.push(diagnostic(source, "budget-exceeded", `${path}.source`, "Text source exceeds the authoring limit."));
    if (diagnostics.length === 0) {
      return Object.freeze({
        value: deepFreeze<ShaderAuthoringDocument>({
          schemaVersion: 1,
          id: value.id as string,
          mode: "text",
          language: "deepsl",
          source: value.source as string,
        }),
        diagnostics: Object.freeze([]),
      });
    }
  } else {
    diagnostics.push(diagnostic(source, "invalid-value", `${path}.mode`, "Expected graph or text authoring mode."));
  }
  return Object.freeze({ diagnostics: Object.freeze(diagnostics.slice(0, SHADER_AUTHORING_BUDGETS.maxIssues)) });
}

export function validateShaderAuthoringDocument(input: unknown): Readonly<{
  valid: boolean;
  value?: ShaderAuthoringDocument;
  revision?: string;
  diagnostics: readonly ShaderAuthoringDiagnostic[];
}> {
  const read = readCanonicalInput(input);
  if (!read.success) {
    const diagnostics = read.issues.map((entry) => diagnostic("document", entry.code, entry.path, entry.message));
    return Object.freeze({ valid: false, diagnostics: Object.freeze(diagnostics) });
  }
  const validated = validateClonedDocument(read.value, "document");
  if (!validated.value) return Object.freeze({ valid: false, diagnostics: validated.diagnostics });
  return Object.freeze({
    valid: true,
    value: validated.value,
    revision: sha256Hex(validated.value),
    diagnostics: Object.freeze([]),
  });
}

export function validateShaderAuthoringSnapshot(input: unknown): Readonly<{
  valid: boolean;
  value?: ShaderAuthoringPersistedSnapshot;
  diagnostics: readonly ShaderAuthoringDiagnostic[];
}> {
  let parsed: unknown = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > SHADER_AUTHORING_BUDGETS.maxSnapshotBytes) {
      return Object.freeze({ valid: false, diagnostics: Object.freeze([diagnostic("snapshot", "budget-exceeded", "$", "Snapshot exceeds the byte budget.")]) });
    }
    try { parsed = JSON.parse(input); } catch {
      return Object.freeze({ valid: false, diagnostics: Object.freeze([diagnostic("snapshot", "invalid-value", "$", "Snapshot is not valid JSON.")]) });
    }
  }
  const read = readCanonicalInput(parsed);
  if (!read.success) {
    return Object.freeze({
      valid: false,
      diagnostics: Object.freeze(read.issues.map((entry) => diagnostic("snapshot", entry.code, entry.path, entry.message))),
    });
  }
  if (new TextEncoder().encode(canonicalShaderJson(read.value)).byteLength > SHADER_AUTHORING_BUDGETS.maxSnapshotBytes) {
    return Object.freeze({ valid: false, diagnostics: Object.freeze([diagnostic("snapshot", "budget-exceeded", "$", "Snapshot exceeds the byte budget.")]) });
  }
  if (!record(read.value)) return Object.freeze({ valid: false, diagnostics: Object.freeze([diagnostic("snapshot", "invalid-type", "$", "Expected a snapshot record.")]) });
  const raw = read.value;
  const diagnostics: ShaderAuthoringDiagnostic[] = [];
  exactFields(raw, ["schemaVersion", "historyLimit", "document", "undo", "redo"], "snapshot", "$", diagnostics);
  if (raw.schemaVersion !== 1) diagnostics.push(diagnostic("snapshot", "invalid-value", "$.schemaVersion", "Unsupported snapshot schema version."));
  if (!Number.isSafeInteger(raw.historyLimit) || (raw.historyLimit as number) < 1 || (raw.historyLimit as number) > SHADER_AUTHORING_BUDGETS.maxHistoryEntries) {
    diagnostics.push(diagnostic("snapshot", "invalid-value", "$.historyLimit", "History limit is outside the supported range."));
  }
  if (!Array.isArray(raw.undo) || !Array.isArray(raw.redo)) diagnostics.push(diagnostic("snapshot", "invalid-type", "$.history", "Undo and redo must be arrays."));
  if ((Array.isArray(raw.undo) && raw.undo.length > SHADER_AUTHORING_BUDGETS.maxHistoryEntries) ||
    (Array.isArray(raw.redo) && raw.redo.length > SHADER_AUTHORING_BUDGETS.maxHistoryEntries)) {
    diagnostics.push(diagnostic("snapshot", "budget-exceeded", "$.history", "Snapshot history exceeds the entry budget."));
  }
  const current = validateClonedDocument(raw.document, "snapshot", "$.document");
  diagnostics.push(...current.diagnostics);
  const undo: ShaderAuthoringDocument[] = [];
  const redo: ShaderAuthoringDocument[] = [];
  for (const [name, values, target] of [["undo", raw.undo, undo], ["redo", raw.redo, redo]] as const) {
    if (!Array.isArray(values)) continue;
    values.slice(0, SHADER_AUTHORING_BUDGETS.maxHistoryEntries).forEach((entry, index) => {
      const result = validateClonedDocument(entry, "snapshot", `$.${name}.${index}`);
      diagnostics.push(...result.diagnostics);
      if (result.value) target.push(result.value);
    });
  }
  if (!current.value || diagnostics.length > 0) return Object.freeze({ valid: false, diagnostics: Object.freeze(diagnostics.slice(0, SHADER_AUTHORING_BUDGETS.maxIssues)) });
  return Object.freeze({
    valid: true,
    value: deepFreeze<ShaderAuthoringPersistedSnapshot>({
      schemaVersion: 1,
      historyLimit: raw.historyLimit as number,
      document: current.value,
      undo,
      redo,
    }),
    diagnostics: Object.freeze([]),
  });
}
