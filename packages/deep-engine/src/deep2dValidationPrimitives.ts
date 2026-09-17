/**
 * Shared Deep2d display-list validation primitives. Leaf module: no imports, so the
 * per-kind validators (`deep2dDisplayListText.ts`) and the envelope (`deep2dDisplayList.ts`)
 * can both depend on it without a cycle. Mirrors the Rust twin's `validate.rs` helpers.
 */

export const DEEP_2D_DISPLAY_LIST_BUDGETS = Object.freeze({
  resources: 65_536,
  commands: 262_144,
  pathVerbsPerResource: 1_000_000,
  pathVerbsTotal: 2_000_000,
  clipsPerCommand: 64,
  dashEntries: 64,
  textCodeUnitsPerCommand: 1_000_000,
  textCodeUnitsTotal: 4_000_000,
} as const);

export type Deep2dDisplayListIssueCode =
  | "invalid-structure" | "invalid-schema-version" | "invalid-id" | "duplicate-id"
  | "invalid-revision" | "invalid-number" | "invalid-color" | "invalid-transform"
  | "invalid-path" | "missing-resource" | "resource-kind-mismatch" | "empty-paint" | "budget-exceeded";

export interface Deep2dDisplayListIssue { readonly code: Deep2dDisplayListIssueCode; readonly path: string; readonly message: string }
export interface Deep2dDisplayListValidationResult { readonly valid: boolean; readonly issues: readonly Deep2dDisplayListIssue[] }

type RecordValue = Record<string, unknown>;

export const DEEP2D_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
export const MAX_DRAW_VALUE = 16_777_216;
export const MAX_IMAGE_DIMENSION = 65_536;
const MAX_ISSUES = 256;

export type Deep2dRecord = Record<string, unknown>;

export const record = (value: unknown): value is Deep2dRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
export const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function denseArray(value: unknown, length?: number): value is unknown[] {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
}

export function add(issues: Deep2dDisplayListIssue[], code: Deep2dDisplayListIssueCode, path: string, message: string): void {
  if (issues.length < MAX_ISSUES) issues.push({ code, path, message });
}

export function allowedKeys(value: RecordValue, allowed: readonly string[], path: string, issues: Deep2dDisplayListIssue[]): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected !== undefined) add(issues, "invalid-structure", `${path}.${unexpected}`, "Unexpected field for this schema version.");
}

export function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

export function validId(value: unknown, path: string, issues: Deep2dDisplayListIssue[]): value is string {
  if (typeof value === "string" && DEEP2D_ID.test(value) && !["__proto__", "prototype", "constructor"].includes(value)) return true;
  add(issues, "invalid-id", path, "Expected a stable 1..256 character ASCII identifier.");
  return false;
}

export function validRevision(value: unknown, path: string, issues: Deep2dDisplayListIssue[]): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) add(issues, "invalid-revision", path, "Expected a non-negative JSON-safe integer revision.");
}

export function validDrawNumber(value: unknown, path: string, issues: Deep2dDisplayListIssue[]): void {
  if (!finite(value) || Math.abs(value) > MAX_DRAW_VALUE) add(issues, "invalid-number", path, `Expected a finite value with absolute magnitude at most ${MAX_DRAW_VALUE}.`);
}

export function validPositive(value: unknown, path: string, issues: Deep2dDisplayListIssue[], limit = MAX_DRAW_VALUE): void {
  if (!finite(value) || value <= 0 || value > limit) add(issues, "invalid-number", path, `Expected a finite value in (0, ${limit}].`);
}

export function validColor(value: unknown, path: string, issues: Deep2dDisplayListIssue[]): void {
  if (!denseArray(value, 4) || value.some((item) => !finite(item) || item < 0 || item > 1)) {
    add(issues, "invalid-color", path, "Expected four finite RGBA channels in [0, 1].");
  }
}

export function validMatrix(value: unknown, path: string, issues: Deep2dDisplayListIssue[]): void {
  if (!denseArray(value, 6) || value.some((item) => !finite(item) || Math.abs(item) > MAX_DRAW_VALUE)) {
    add(issues, "invalid-transform", path, "Expected six bounded finite affine-matrix values.");
  }
}

export function validEnum(value: unknown, values: readonly string[], path: string, issues: Deep2dDisplayListIssue[]): void {
  if (typeof value !== "string" || !values.includes(value)) add(issues, "invalid-structure", path, "Unsupported enum value.");
}
