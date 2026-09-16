import type {
  CompiledShaderPass,
  DeepShaderAsset,
  ShaderCompileCapabilities,
  ShaderStage,
} from "../shader/index.js";
import type { DeepShaderPackageV2 } from "../shaderPackage/types.js";
import type { DeepSlPackageCompatibilityReport } from "./packageAdapterTypes.js";

export const SHADER_AUTHORING_SCHEMA_VERSION = 1 as const;

export const SHADER_AUTHORING_BUDGETS = Object.freeze({
  maxDepth: 48,
  maxInputNodes: 32_768,
  maxIssues: 128,
  maxSnapshotBytes: 4 * 1024 * 1024,
  maxSourceLength: 1024 * 1024,
  maxSourceLines: 32_768,
  maxHistoryEntries: 128,
});

export interface ShaderGraphAuthoringDocument {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly mode: "graph";
  readonly asset: DeepShaderAsset;
  readonly techniqueId: string;
  readonly passId: string;
}

/** Text is persisted as authoring content and compiled by the bounded DeepSL surface frontend. */
export interface ShaderTextAuthoringDocument {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly mode: "text";
  readonly language: "deepsl";
  readonly source: string;
}

export type ShaderAuthoringDocument = ShaderGraphAuthoringDocument | ShaderTextAuthoringDocument;

export type ShaderAuthoringDiagnosticSource =
  | "document"
  | "snapshot"
  | "graph-compiler"
  | "text-compiler"
  | "session";

export interface ShaderTextPosition {
  readonly line: number;
  readonly column: number;
}

export interface ShaderTextRange {
  readonly start: ShaderTextPosition;
  readonly end: ShaderTextPosition;
}

export interface ShaderAuthoringDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly source: ShaderAuthoringDiagnosticSource;
  readonly path: string;
  readonly message: string;
  readonly range?: ShaderTextRange;
}

export type ShaderAuthoringSourceMapEntry =
  | Readonly<{
      sourceKind: "graph-node";
      stage: ShaderStage;
      nodeId: string;
      generatedLine: number;
    }>
  | Readonly<{
      sourceKind: "text-range";
      range: ShaderTextRange;
      generatedLine: number;
    }>;

export interface ShaderAuthoringArtifact {
  readonly target: "webgpu";
  readonly pass: CompiledShaderPass;
  readonly sourceMap: readonly ShaderAuthoringSourceMapEntry[];
  /** Exact bounded package emitted by the runtime adapter for driver validation and semantic parity. */
  readonly runtimePackage?: DeepShaderPackageV2;
  readonly runtimeCompatibility?: DeepSlPackageCompatibilityReport & Readonly<{ status: "direct-package-ready" }>;
}

export interface ShaderAuthoringCompilerResult {
  readonly success: boolean;
  readonly diagnostics: readonly ShaderAuthoringDiagnostic[];
  readonly artifact?: ShaderAuthoringArtifact;
}

export interface ShaderAuthoringCompileRequest {
  readonly document: ShaderTextAuthoringDocument;
  readonly revision: string;
  readonly candidateId: number;
}

/** Optional override for the built-in bounded DeepSL surface compiler. */
export type ShaderTextCompiler = (
  request: ShaderAuthoringCompileRequest,
) => ShaderAuthoringCompilerResult | Promise<ShaderAuthoringCompilerResult>;

export interface ShaderAuthoringSessionOptions {
  readonly capabilities?: ShaderCompileCapabilities;
  /** Overrides the built-in DeepSL frontend for future language profiles or editor-hosted workers. */
  readonly textCompiler?: ShaderTextCompiler;
  readonly historyLimit?: number;
}

export type ShaderCompileStatus = "idle" | "compiling" | "succeeded" | "failed";

export interface ShaderCompileState {
  readonly status: ShaderCompileStatus;
  readonly revision?: string;
  readonly candidateId?: number;
  readonly diagnostics: readonly ShaderAuthoringDiagnostic[];
}

export interface ShaderKnownGood {
  readonly revision: string;
  readonly candidateId: number;
  readonly artifact: ShaderAuthoringArtifact;
}

export interface ShaderAuthoringSessionView {
  readonly document: ShaderAuthoringDocument;
  readonly revision: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly compile: ShaderCompileState;
  readonly lastKnownGood?: ShaderKnownGood;
}

export interface ShaderAuthoringMutationResult {
  readonly accepted: boolean;
  readonly changed: boolean;
  readonly diagnostics: readonly ShaderAuthoringDiagnostic[];
  readonly view: ShaderAuthoringSessionView;
}

export interface ShaderAuthoringCompileCommit {
  readonly committed: boolean;
  readonly stale: boolean;
  readonly revision: string;
  readonly candidateId: number;
  readonly result: ShaderAuthoringCompilerResult;
  readonly view: ShaderAuthoringSessionView;
}

export interface ShaderAuthoringPersistedSnapshot {
  readonly schemaVersion: 1;
  readonly historyLimit: number;
  readonly document: ShaderAuthoringDocument;
  readonly undo: readonly ShaderAuthoringDocument[];
  readonly redo: readonly ShaderAuthoringDocument[];
}

export interface ShaderAuthoringSessionResult {
  readonly success: boolean;
  readonly diagnostics: readonly ShaderAuthoringDiagnostic[];
  readonly session?: import("./session.js").ShaderAuthoringSession;
}
