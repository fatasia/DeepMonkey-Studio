import { DEEP_RUNTIME_PACKAGE_BUDGETS as LIMITS, type RuntimeJson } from "./types.js";

export class RuntimePackageError extends Error {
  constructor(readonly path: string, message: string) { super(`${path}: ${message}`); this.name = "RuntimePackageError"; }
}
export function requireValue(condition: unknown, path: string, message: string): asserts condition {
  if (!condition) throw new RuntimePackageError(path, message);
}
export function record(value: unknown, path: string): Record<string, unknown> {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value), path, "Expected an object.");
  const prototype = Object.getPrototypeOf(value);
  requireValue(prototype === null || prototype === Object.prototype, path, "Expected a plain object.");
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  for (const key of Object.keys(value)) requireValue(required.includes(key) || optional.includes(key), `${path}.${key}`, "Unknown field.");
  for (const key of required) requireValue(Object.hasOwn(value, key), `${path}.${key}`, "Required field is missing.");
}
export function array(value: unknown, path: string, max: number = LIMITS.nodes): unknown[] {
  requireValue(Array.isArray(value) && value.length <= max, path, "Expected a bounded array.");
  return value;
}
export function integer(value: unknown, min: number, max: number, path: string): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max, path, "Invalid integer.");
  return value;
}
export function string(value: unknown, path: string): string {
  requireValue(typeof value === "string", path, "Expected a string.");
  return value;
}
export function resourceId(value: unknown, path: string): string {
  const text = string(value, path);
  requireValue(/^[a-z0-9][a-z0-9._:/-]{0,255}$/.test(text), path, "Invalid resource identifier.");
  return text;
}
export function revision(value: unknown, path: string): number { return integer(value, 1, Number.MAX_SAFE_INTEGER, path); }
export function wellFormedUnicode(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

/** 在哈希前取得无访问器、无共享内存的 JSON 快照，预算先于递归分配。 */
export function snapshotJson(input: unknown, typedArrays = false): RuntimeJson {
  const stack = new Set<object>();
  let nodes = 0, bytes = 0;
  function visit(value: unknown, path: string, depth: number): RuntimeJson {
    requireValue(++nodes <= LIMITS.nodes && depth <= LIMITS.depth, path, "JSON node or depth budget exceeded.");
    if (value === null || typeof value === "boolean") { bytes += 5; return value; }
    if (typeof value === "number") {
      requireValue(Number.isFinite(value), path, "Expected a finite JSON number.");
      bytes += 24; return value === 0 ? 0 : value;
    }
    if (typeof value === "string") {
      requireValue(wellFormedUnicode(value), path, "Unpaired Unicode surrogate.");
      bytes += new TextEncoder().encode(value).length + 2;
      requireValue(bytes <= LIMITS.inputBytes, path, "Input byte budget exceeded.");
      return value;
    }
    requireValue(value !== null && typeof value === "object" && !stack.has(value), path, "Non-JSON value or cyclic input.");
    stack.add(value);
    let output: RuntimeJson;
    if (ArrayBuffer.isView(value)) {
      requireValue(typedArrays && (value instanceof Float32Array || value instanceof Uint32Array || value instanceof Uint8Array)
        && value.buffer instanceof ArrayBuffer, path, "Unsupported or shared typed array.");
      requireValue(nodes + value.length <= LIMITS.nodes, path, "JSON node budget exceeded.");
      output = Array.from(value, (item, index) => visit(item, `${path}[${index}]`, depth + 1));
    } else {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      requireValue(Object.getOwnPropertySymbols(value).length === 0, path, "Symbol fields are not JSON.");
      for (const [key, descriptor] of Object.entries(descriptors)) {
        requireValue("value" in descriptor && (descriptor.enumerable || (Array.isArray(value) && key === "length")), path, "Accessors and hidden fields are not JSON.");
      }
      if (Array.isArray(value)) {
        requireValue(value.length + nodes <= LIMITS.nodes && Object.keys(value).length === value.length, path, "Sparse or extended array.");
        for (let index = 0; index < value.length; index += 1) requireValue(Object.hasOwn(value, index), path, "Sparse or extended array.");
        output = value.map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      } else {
        const object = record(value, path), result: Record<string, RuntimeJson> = Object.create(null);
        for (const key of Object.keys(object)) {
          requireValue(wellFormedUnicode(key), path, "Unpaired Unicode key surrogate.");
          bytes += new TextEncoder().encode(key).length + 3;
          result[key] = visit(object[key], `${path}.${key}`, depth + 1);
        }
        output = result;
      }
    }
    stack.delete(value);
    requireValue(bytes <= LIMITS.inputBytes, path, "Input byte budget exceeded.");
    return output;
  }
  return visit(input, "$", 0);
}
