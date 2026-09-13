import { DEEP_SHADER_PACKAGE_BUDGETS } from "./constants.js";
import type { ShaderPackageDiagnostic } from "./types.js";

export const HASH_PATTERN = /^[0-9a-f]{64}$/;
export const PACKAGE_ID_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/;
export const SYMBOL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const RECORD_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}(?:\/[A-Za-z][A-Za-z0-9_.-]{0,127})?$/;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function issue(
  diagnostics: ShaderPackageDiagnostic[],
  code: ShaderPackageDiagnostic["code"],
  path: string,
  message: string,
): void {
  if (diagnostics.length < DEEP_SHADER_PACKAGE_BUDGETS.maxIssues) diagnostics.push({ code, path, message });
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: ShaderPackageDiagnostic[],
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) issue(diagnostics, "unknown-field", `${path}.${key}`, `Unknown field ${key}.`);
  }
}

export function validString(
  value: unknown,
  path: string,
  diagnostics: ShaderPackageDiagnostic[],
  pattern?: RegExp,
): value is string {
  if (typeof value !== "string") {
    issue(diagnostics, "invalid-type", path, "Expected string.");
    return false;
  }
  if (value.length === 0 || value.length > DEEP_SHADER_PACKAGE_BUDGETS.maxStringLength || (pattern && !pattern.test(value))) {
    issue(diagnostics, "invalid-value", path, "String is outside the accepted format or length.");
    return false;
  }
  return true;
}

export function validInteger(
  value: unknown,
  min: number,
  max: number,
  path: string,
  diagnostics: ShaderPackageDiagnostic[],
): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    issue(diagnostics, "invalid-value", path, `Expected an integer from ${min} to ${max}.`);
    return false;
  }
  return true;
}

export function validateHash(value: unknown, path: string, diagnostics: ShaderPackageDiagnostic[]): boolean {
  if (!record(value)) {
    issue(diagnostics, "invalid-type", path, "Expected SHA-256 record.");
    return false;
  }
  exactFields(value, ["algorithm", "value"], path, diagnostics);
  if (value.algorithm !== "sha256") issue(diagnostics, "invalid-value", `${path}.algorithm`, "Only SHA-256 is supported.");
  validString(value.value, `${path}.value`, diagnostics, HASH_PATTERN);
  return true;
}

export function requireArray(
  value: unknown,
  max: number,
  path: string,
  diagnostics: ShaderPackageDiagnostic[],
): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    issue(diagnostics, "invalid-type", path, "Expected array.");
    return undefined;
  }
  if (value.length > max) issue(diagnostics, "budget-exceeded", path, `Array exceeds the ${max}-entry budget.`);
  return value.slice(0, max);
}

export function requireCanonicalOrder(
  values: readonly string[],
  path: string,
  diagnostics: ShaderPackageDiagnostic[],
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]! >= values[index]!) {
      issue(diagnostics, "non-canonical", path, "Entries must be sorted and unique.");
      return;
    }
  }
}
