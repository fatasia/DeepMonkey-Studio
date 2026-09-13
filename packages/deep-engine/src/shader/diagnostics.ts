import { DEEP_SHADER_BUDGETS } from "./constants.js";
import type { ShaderDiagnostic, ShaderIssueCode } from "./types.js";

export function issue(
  diagnostics: ShaderDiagnostic[],
  code: ShaderIssueCode,
  path: string,
  message: string,
): void {
  if (diagnostics.length >= DEEP_SHADER_BUDGETS.maxIssues) return;
  diagnostics.push(Object.freeze({ severity: "error", code, path, message }));
}

export function frozenDiagnostics(diagnostics: ShaderDiagnostic[]): readonly ShaderDiagnostic[] {
  return Object.freeze(diagnostics.map((entry) => Object.freeze({ ...entry })));
}
