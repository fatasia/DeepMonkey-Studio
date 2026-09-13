import type { DeepSlPackageCompatibilityIssue } from "../shaderAuthoring/packageAdapterTypes.js";
import type { ShaderAuthoringDiagnostic, ShaderAuthoringArtifact } from "../shaderAuthoring/types.js";
import type { ShaderPackageDiagnostic } from "../shaderPackage/index.js";
import { ShaderPackageExecutorError } from "./shaderPackageExecutor.js";
import type { ShaderHotReloadDiagnostic } from "./hotReloadTypes.js";

export const EMPTY_HOT_RELOAD_DIAGNOSTICS: readonly ShaderHotReloadDiagnostic[] = Object.freeze([]);

export function runtimeDiagnostic(code: string, message: string): ShaderHotReloadDiagnostic {
  return Object.freeze({ severity: "error", stage: "runtime", code, path: "$", message });
}

export function authoringDiagnostics(entries: readonly ShaderAuthoringDiagnostic[]): readonly ShaderHotReloadDiagnostic[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    severity: entry.severity, stage: "authoring" as const, code: entry.code,
    path: entry.path, message: entry.message, ...(entry.range ? { range: entry.range } : {}),
  })));
}

export function adapterDiagnostics(entries: readonly DeepSlPackageCompatibilityIssue[]): readonly ShaderHotReloadDiagnostic[] {
  return Object.freeze(entries.map((entry) => Object.freeze({
    severity: "error" as const, stage: "adapter" as const, code: entry.code, path: entry.path, message: entry.message,
  })));
}

function packageDiagnostics(entries: readonly ShaderPackageDiagnostic[]): readonly ShaderHotReloadDiagnostic[] {
  return entries.map((entry) => Object.freeze({
    severity: "error" as const, stage: "gpu" as const, code: entry.code, path: entry.path, message: entry.message,
  }));
}

function compilationDiagnostics(message: string, artifact: ShaderAuthoringArtifact): readonly ShaderHotReloadDiagnostic[] {
  const output: ShaderHotReloadDiagnostic[] = [];
  for (const line of message.split("\n")) {
    const match = /^(.+) WGSL (\d+):(\d+) (.+)$/u.exec(line);
    if (!match) continue;
    const generatedLine = Number(match[2]), generatedColumn = Number(match[3]);
    const source = artifact.sourceMap.find((entry) => entry.generatedLine === generatedLine);
    output.push(Object.freeze({ severity: "error", stage: "gpu", code: "wgsl-compilation-error", path: "$.module",
      message: `${match[1]}: ${match[4]}`, generatedLine, generatedColumn,
      ...(source?.sourceKind === "text-range" ? { range: source.range } : {}) }));
  }
  return output;
}

export function gpuDiagnostics(error: unknown, artifact: ShaderAuthoringArtifact): readonly ShaderHotReloadDiagnostic[] {
  if (error instanceof ShaderPackageExecutorError) {
    if (error.diagnostics.length) return Object.freeze(packageDiagnostics(error.diagnostics));
    const compilation = compilationDiagnostics(error.message, artifact);
    if (compilation.length) return Object.freeze(compilation);
  }
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze([Object.freeze({ severity: "error", stage: "gpu", code: "gpu-prewarm-failed",
    path: "$.gpu", message })]);
}
