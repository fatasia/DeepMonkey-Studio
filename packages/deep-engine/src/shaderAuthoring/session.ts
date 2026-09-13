import { canonicalShaderJson, sha256Hex } from "../shader/canonical.js";
import { compileShaderPass } from "../shader/index.js";
import { compileDeepSlSurface } from "./deepSl.js";
import { deepFreeze, readCanonicalInput } from "./safety.js";
import {
  SHADER_AUTHORING_BUDGETS,
  type ShaderAuthoringArtifact,
  type ShaderAuthoringCompileCommit,
  type ShaderAuthoringCompilerResult,
  type ShaderAuthoringDiagnostic,
  type ShaderAuthoringDocument,
  type ShaderAuthoringMutationResult,
  type ShaderAuthoringPersistedSnapshot,
  type ShaderAuthoringSessionOptions,
  type ShaderAuthoringSessionResult,
  type ShaderAuthoringSessionView,
  type ShaderCompileState,
  type ShaderKnownGood,
} from "./types.js";
import { validateShaderAuthoringDocument, validateShaderAuthoringSnapshot } from "./validation.js";

const EMPTY_DIAGNOSTICS: readonly ShaderAuthoringDiagnostic[] = Object.freeze([]);

function sessionDiagnostic(code: string, message: string): ShaderAuthoringDiagnostic {
  return Object.freeze({ severity: "error", source: "session", code, path: "$", message });
}

function graphCompilerResult(document: Extract<ShaderAuthoringDocument, { mode: "graph" }>, options: ShaderAuthoringSessionOptions): ShaderAuthoringCompilerResult {
  if (!options.capabilities) {
    return Object.freeze({ success: false, diagnostics: Object.freeze([sessionDiagnostic("compiler-unavailable", "Graph compilation requires target WebGPU capabilities.")]) });
  }
  const result = compileShaderPass(document.asset, document.techniqueId, document.passId, options.capabilities);
  const diagnostics = Object.freeze(result.diagnostics.map((entry) => Object.freeze({
    severity: entry.severity,
    source: "graph-compiler" as const,
    code: entry.code,
    path: entry.path,
    message: entry.message,
  })));
  if (!result.success || !result.value) return Object.freeze({ success: false, diagnostics });
  const artifact: ShaderAuthoringArtifact = deepFreeze({
    target: "webgpu",
    pass: result.value,
    sourceMap: result.value.sourceMap.map((entry) => ({ sourceKind: "graph-node", ...entry })),
  });
  return Object.freeze({ success: true, diagnostics, artifact });
}

function invalidCompilerResult(message: string): ShaderAuthoringCompilerResult {
  return Object.freeze({ success: false, diagnostics: Object.freeze([sessionDiagnostic("invalid-compiler-result", message)]) });
}

function validPosition(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const value = input as { line?: unknown; column?: unknown };
  return Number.isSafeInteger(value.line) && (value.line as number) >= 1 &&
    Number.isSafeInteger(value.column) && (value.column as number) >= 1;
}

function validRange(input: unknown): boolean {
  if (!input || typeof input !== "object") return false;
  const value = input as { start?: unknown; end?: unknown };
  return validPosition(value.start) && validPosition(value.end);
}

function validSourceMap(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  return input.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const value = entry as { sourceKind?: unknown; stage?: unknown; nodeId?: unknown; range?: unknown; generatedLine?: unknown };
    if (!Number.isSafeInteger(value.generatedLine) || (value.generatedLine as number) < 1) return false;
    if (value.sourceKind === "graph-node") {
      return (value.stage === "vertex" || value.stage === "fragment") && typeof value.nodeId === "string";
    }
    return value.sourceKind === "text-range" && validRange(value.range);
  });
}

function normalizeCompilerResult(input: unknown): ShaderAuthoringCompilerResult {
  const read = readCanonicalInput(input);
  if (!read.success || !read.value || typeof read.value !== "object") return invalidCompilerResult("Compiler returned a non-canonical result.");
  try {
    const result = read.value as Partial<ShaderAuthoringCompilerResult>;
    if (Object.keys(result).some((key) => !["success", "diagnostics", "artifact"].includes(key))) return invalidCompilerResult("Compiler result contains unknown fields.");
    if (typeof result.success !== "boolean" || !Array.isArray(result.diagnostics)) return invalidCompilerResult("Compiler result is missing success or diagnostics.");
    if (result.diagnostics.length > SHADER_AUTHORING_BUDGETS.maxIssues) return invalidCompilerResult("Compiler diagnostics exceed the session budget.");
    const diagnostics = result.diagnostics.map((entry) => {
      if (!entry || typeof entry !== "object" || (entry.severity !== "error" && entry.severity !== "warning") ||
        typeof entry.code !== "string" || !["document", "snapshot", "graph-compiler", "text-compiler", "session"].includes(entry.source) ||
        typeof entry.path !== "string" || typeof entry.message !== "string" || (entry.range !== undefined && !validRange(entry.range))) {
        throw new Error("Compiler returned an invalid diagnostic.");
      }
      return Object.freeze({ ...entry });
    });
    if (result.success && diagnostics.some((entry) => entry.severity === "error")) return invalidCompilerResult("Successful compiler result contains an error diagnostic.");
    if (!result.success && !diagnostics.some((entry) => entry.severity === "error")) return invalidCompilerResult("Failed compiler result requires an error diagnostic.");
    if (result.success && !result.artifact) return invalidCompilerResult("Successful compiler result is missing an artifact.");
    if (!result.success && result.artifact) return invalidCompilerResult("Failed compiler result cannot contain an artifact.");
    if (result.artifact) {
      const artifact = result.artifact;
      if (artifact.target !== "webgpu" || !artifact.pass || !validSourceMap(artifact.sourceMap) ||
        !/^[a-f0-9]{64}$/.test(artifact.pass.cacheKey) || typeof artifact.pass.module?.code !== "string") {
        return invalidCompilerResult("Compiler returned an invalid WebGPU artifact.");
      }
      if (artifact.pass.module.code.length > SHADER_AUTHORING_BUDGETS.maxSourceLength) return invalidCompilerResult("Compiled WGSL exceeds the session budget.");
      return deepFreeze({ success: true, diagnostics, artifact });
    }
    return deepFreeze({ success: false, diagnostics });
  } catch {
    return invalidCompilerResult("Compiler result could not be inspected safely.");
  }
}

export class ShaderAuthoringSession {
  readonly #options: ShaderAuthoringSessionOptions;
  readonly #historyLimit: number;
  #document: ShaderAuthoringDocument;
  #revision: string;
  #undo: ShaderAuthoringDocument[];
  #redo: ShaderAuthoringDocument[];
  #compile: ShaderCompileState = Object.freeze({ status: "idle", diagnostics: EMPTY_DIAGNOSTICS });
  #lastKnownGood?: ShaderKnownGood;
  #candidateId = 0;

  private constructor(document: ShaderAuthoringDocument, options: ShaderAuthoringSessionOptions, undo: ShaderAuthoringDocument[] = [], redo: ShaderAuthoringDocument[] = []) {
    this.#options = options;
    const requestedLimit = options.historyLimit ?? 64;
    this.#historyLimit = Number.isSafeInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), SHADER_AUTHORING_BUDGETS.maxHistoryEntries)
      : 64;
    this.#document = document;
    this.#revision = sha256Hex(document);
    this.#undo = undo.slice(-this.#historyLimit);
    this.#redo = redo.slice(-this.#historyLimit);
  }

  static create(input: unknown, options: ShaderAuthoringSessionOptions = {}): ShaderAuthoringSessionResult {
    const validation = validateShaderAuthoringDocument(input);
    if (!validation.valid || !validation.value) return Object.freeze({ success: false, diagnostics: validation.diagnostics });
    return Object.freeze({ success: true, diagnostics: EMPTY_DIAGNOSTICS, session: new ShaderAuthoringSession(validation.value, options) });
  }

  static restore(input: unknown, options: ShaderAuthoringSessionOptions = {}): ShaderAuthoringSessionResult {
    const validation = validateShaderAuthoringSnapshot(input);
    if (!validation.valid || !validation.value) return Object.freeze({ success: false, diagnostics: validation.diagnostics });
    return Object.freeze({
      success: true,
      diagnostics: EMPTY_DIAGNOSTICS,
      session: new ShaderAuthoringSession(
        validation.value.document,
        { ...options, historyLimit: options.historyLimit ?? validation.value.historyLimit },
        [...validation.value.undo],
        [...validation.value.redo],
      ),
    });
  }

  view(): ShaderAuthoringSessionView {
    return Object.freeze({
      document: this.#document,
      revision: this.#revision,
      canUndo: this.#undo.length > 0,
      canRedo: this.#redo.length > 0,
      compile: this.#compile,
      ...(this.#lastKnownGood ? { lastKnownGood: this.#lastKnownGood } : {}),
    });
  }

  replaceDocument(input: unknown): ShaderAuthoringMutationResult {
    const validation = validateShaderAuthoringDocument(input);
    if (!validation.valid || !validation.value || !validation.revision) {
      return Object.freeze({ accepted: false, changed: false, diagnostics: validation.diagnostics, view: this.view() });
    }
    if (validation.revision === this.#revision) {
      return Object.freeze({ accepted: true, changed: false, diagnostics: EMPTY_DIAGNOSTICS, view: this.view() });
    }
    this.#undo.push(this.#document);
    if (this.#undo.length > this.#historyLimit) this.#undo.shift();
    this.#redo = [];
    this.#setDocument(validation.value, validation.revision);
    return Object.freeze({ accepted: true, changed: true, diagnostics: EMPTY_DIAGNOSTICS, view: this.view() });
  }

  undo(): boolean {
    const document = this.#undo.pop();
    if (!document) return false;
    this.#redo.push(this.#document);
    if (this.#redo.length > this.#historyLimit) this.#redo.shift();
    this.#setDocument(document, sha256Hex(document));
    return true;
  }

  redo(): boolean {
    const document = this.#redo.pop();
    if (!document) return false;
    this.#undo.push(this.#document);
    if (this.#undo.length > this.#historyLimit) this.#undo.shift();
    this.#setDocument(document, sha256Hex(document));
    return true;
  }

  async compileCandidate(): Promise<ShaderAuthoringCompileCommit> {
    const document = this.#document;
    const revision = this.#revision;
    const candidateId = ++this.#candidateId;
    this.#compile = Object.freeze({ status: "compiling", revision, candidateId, diagnostics: EMPTY_DIAGNOSTICS });
    let raw: unknown;
    try {
      if (document.mode === "graph") raw = graphCompilerResult(document, this.#options);
      else if (this.#options.textCompiler) raw = await this.#options.textCompiler(Object.freeze({ document, revision, candidateId }));
      else if (this.#options.capabilities) raw = compileDeepSlSurface(Object.freeze({ document, revision, candidateId }), { capabilities: this.#options.capabilities });
      else raw = Object.freeze({ success: false, diagnostics: Object.freeze([sessionDiagnostic("compiler-unavailable", "DeepSL compilation requires target WebGPU capabilities.")]) });
    } catch {
      raw = Object.freeze({ success: false, diagnostics: Object.freeze([sessionDiagnostic("compiler-threw", "The shader compiler failed without a usable result.")]) });
    }
    const result = normalizeCompilerResult(raw);
    const stale = candidateId !== this.#candidateId || revision !== this.#revision;
    if (!stale) {
      this.#compile = Object.freeze({
        status: result.success ? "succeeded" : "failed",
        revision,
        candidateId,
        diagnostics: result.diagnostics,
      });
      if (result.success && result.artifact) this.#lastKnownGood = deepFreeze({ revision, candidateId, artifact: result.artifact });
    }
    return Object.freeze({ committed: !stale, stale, revision, candidateId, result, view: this.view() });
  }

  serialize(): string {
    const snapshot: ShaderAuthoringPersistedSnapshot = {
      schemaVersion: 1,
      historyLimit: this.#historyLimit,
      document: this.#document,
      undo: this.#undo,
      redo: this.#redo,
    };
    const serialized = canonicalShaderJson(snapshot);
    if (new TextEncoder().encode(serialized).byteLength > SHADER_AUTHORING_BUDGETS.maxSnapshotBytes) throw new RangeError("Shader authoring snapshot exceeds the byte budget.");
    return serialized;
  }

  #setDocument(document: ShaderAuthoringDocument, revision: string): void {
    this.#document = document;
    this.#revision = revision;
    this.#candidateId += 1;
    this.#compile = Object.freeze({ status: "idle", diagnostics: EMPTY_DIAGNOSTICS });
  }
}

export function createShaderAuthoringSession(input: unknown, options: ShaderAuthoringSessionOptions = {}): ShaderAuthoringSessionResult {
  return ShaderAuthoringSession.create(input, options);
}

export function restoreShaderAuthoringSession(input: unknown, options: ShaderAuthoringSessionOptions = {}): ShaderAuthoringSessionResult {
  return ShaderAuthoringSession.restore(input, options);
}
