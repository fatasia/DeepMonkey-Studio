/// <reference types="@webgpu/types" />
import type { ShaderCompileCapabilities } from "../shader/index.js";
import type { DeepSlPackageCompatibilityReport } from "../shaderAuthoring/packageAdapterTypes.js";
import type { ShaderTextRange } from "../shaderAuthoring/types.js";
import type { PreparedShaderPackage } from "./shaderPackageExecutor.js";

export type ShaderHotReloadState = "ready" | "lost" | "disposed";
export type ShaderHotReloadDiagnosticStage = "authoring" | "adapter" | "gpu" | "runtime";

export interface ShaderHotReloadDiagnostic {
  readonly severity: "error" | "warning";
  readonly stage: ShaderHotReloadDiagnosticStage;
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly range?: ShaderTextRange;
  readonly generatedLine?: number;
  readonly generatedColumn?: number;
}

export interface ShaderHotReloadOptions {
  readonly capabilities: ShaderCompileCapabilities;
  readonly packageVersion: string;
  readonly compilerVersion: string;
  readonly packageId?: string;
  /** Editor quiet period. Defaults to 150ms and is bounded to five seconds. */
  readonly debounceMs?: number;
}

export interface PublishedShaderPackage {
  readonly revision: string;
  readonly artifactHash: string;
  readonly packageHash: string;
  readonly preparedPackage: PreparedShaderPackage;
  readonly compatibility: DeepSlPackageCompatibilityReport & Readonly<{ status: "direct-package-ready" }>;
}

export type ShaderHotReloadRequestStatus = "ready" | "unchanged" | "failed" | "superseded";

export interface ShaderHotReloadRequestResult {
  readonly status: ShaderHotReloadRequestStatus;
  readonly revision?: string;
  readonly artifactHash?: string;
  readonly diagnostics: readonly ShaderHotReloadDiagnostic[];
}

export interface ShaderHotReloadPublishResult {
  readonly published: boolean;
  readonly current?: PublishedShaderPackage;
}

export type ShaderHotReloadFrameBoundaryHook = () => ShaderHotReloadPublishResult;
