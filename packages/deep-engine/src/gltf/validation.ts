export type GltfErrorCode = "invalid" | "unsupported" | "limit";

export class GltfImportError extends Error {
  constructor(readonly code: GltfErrorCode, readonly path: string, message: string, readonly feature?: string) {
    super(`${path}: ${message}`);
    this.name = "GltfImportError";
  }
}

export const MAX_BYTES = 128 * 1024 * 1024;
export type JsonObject = Record<string, unknown>;
export function invalid(path: string, message: string): never { throw new GltfImportError("invalid", path, message); }
export function unsupported(path: string, feature: string): never {
  throw new GltfImportError("unsupported", path, `Unsupported ${feature}.`, feature);
}
export function budget(value: number, maximum: number, path: string): void {
  if (!Number.isSafeInteger(value) || value > maximum) throw new GltfImportError("limit", path, `Limit ${maximum} exceeded.`);
}
export function object(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path, "Expected a JSON object.");
  return value as JsonObject;
}
export function array(value: unknown, path: string, maximum = 16_384): unknown[] {
  if (!Array.isArray(value)) invalid(path, "Expected an array.");
  budget(value.length, maximum, path);
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) invalid(`${path}[${index}]`, "Sparse JSON arrays are invalid.");
  return value;
}
export function list(value: unknown, path: string, maximum = 16_384): unknown[] {
  return value === undefined ? [] : array(value, path, maximum);
}
export function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid(path, `Expected an integer >= ${minimum}.`);
  return value;
}
export function reference(values: readonly unknown[], value: unknown, path: string): number {
  const index = integer(value, path);
  if (index >= values.length) invalid(path, "Reference is out of range.");
  return index;
}
export function vector(value: unknown, length: number, path: string): number[] {
  const values = array(value, path, length);
  if (values.length !== length || values.some(x => typeof x !== "number" || !Number.isFinite(x))) invalid(path, `Expected ${length} finite numbers.`);
  return values as number[];
}
export function factor(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid(path, "Expected a factor in 0..1.");
  return value;
}
export function abortSignal(value: unknown, path: string): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object"
    || typeof (value as AbortSignal).aborted !== "boolean"
    || typeof (value as AbortSignal).throwIfAborted !== "function"
    || typeof (value as AbortSignal).addEventListener !== "function") {
    invalid(path, "Expected an AbortSignal.");
  }
  return value as AbortSignal;
}
export function noExtensions(value: JsonObject, path: string): void {
  if (value.extensions === undefined) return;
  const names = Object.keys(object(value.extensions, `${path}.extensions`));
  if (names.length) unsupported(`${path}.extensions.${names[0]}`, `extension ${names[0]}`);
}

/** JSON 字节外的对象入口同样有工作量上限；循环和过深 extras 不得拖垮导入线程。 */
export function validateJson(value: unknown): void {
  const active = new Set<object>();
  const pending: { value: unknown; path: string; depth: number; exit?: boolean }[] = [{ value, path: "$", depth: 0 }];
  let entries = 0, textBytes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.exit) { active.delete(entry.value as object); continue; }
    budget(++entries, 250_000, entry.path);
    budget(entry.depth, 128, entry.path);
    const current = entry.value;
    if (typeof current === "string") { textBytes += current.length * 2; budget(textBytes, MAX_BYTES, entry.path); continue; }
    if (current === null || typeof current === "boolean") continue;
    if (typeof current === "number") { if (!Number.isFinite(current)) invalid(entry.path, "JSON numbers must be finite."); continue; }
    if (typeof current !== "object") invalid(entry.path, "Expected a JSON value.");
    if (active.has(current)) invalid(entry.path, "Cyclic JSON objects are invalid.");
    active.add(current);
    pending.push({ ...entry, exit: true });
    const values = Array.isArray(current) ? array(current, entry.path, 250_000).map((item, index) => [String(index), item] as const)
      : Object.entries(object(current, entry.path));
    budget(entries + pending.length + values.length, 250_000, entry.path);
    for (let index = values.length - 1; index >= 0; index--) {
      const [key, item] = values[index]!;
      textBytes += key.length * 2;
      budget(textBytes, MAX_BYTES, entry.path);
      pending.push({ value: item, path: `${entry.path}.${key}`, depth: entry.depth + 1 });
    }
  }
}
