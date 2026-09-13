import { DEEP_SHADER_BUDGETS } from "./constants.js";
import { issue } from "./diagnostics.js";
import type { ShaderDiagnostic } from "./types.js";

interface WalkState {
  nodes: number;
  stopped: boolean;
  readonly seen: WeakSet<object>;
}

function inspectObject(
  value: object,
  path: string,
  depth: number,
  diagnostics: ShaderDiagnostic[],
  state: WalkState,
): void {
  if (state.stopped) return;
  if (depth > DEEP_SHADER_BUDGETS.maxDepth) {
    issue(diagnostics, "budget-exceeded", path, "Shader input exceeds the maximum nesting depth.");
    state.stopped = true;
    return;
  }
  if (state.seen.has(value)) {
    issue(diagnostics, "non-deterministic", path, "Shared or cyclic object graphs are not canonical input.");
    return;
  }
  state.seen.add(value);

  let descriptors: PropertyDescriptorMap;
  let keys: readonly PropertyKey[];
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    issue(diagnostics, "non-deterministic", path, "Input reflection failed; proxies are not accepted.");
    state.stopped = true;
    return;
  }
  if (keys.some((key) => typeof key === "symbol")) {
    issue(diagnostics, "non-deterministic", path, "Symbol properties are not canonical input.");
  }
  for (const key of keys) {
    if (typeof key !== "string") continue;
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
      issue(diagnostics, "non-deterministic", `${path}.${key}`, "Accessors are not accepted.");
      continue;
    }
    inspectValue(descriptor.value, `${path}.${key}`, depth + 1, diagnostics, state);
    if (state.stopped) return;
  }
}

function inspectValue(
  value: unknown,
  path: string,
  depth: number,
  diagnostics: ShaderDiagnostic[],
  state: WalkState,
): void {
  if (state.stopped) return;
  state.nodes += 1;
  if (state.nodes > DEEP_SHADER_BUDGETS.maxInputNodes) {
    issue(diagnostics, "budget-exceeded", path, "Shader input exceeds the global node budget.");
    state.stopped = true;
    return;
  }
  if (typeof value === "string") {
    if (value.length > DEEP_SHADER_BUDGETS.maxStringLength) {
      issue(diagnostics, "budget-exceeded", path, "String exceeds the shader input limit.");
    }
    if (value.normalize("NFC") !== value) {
      issue(diagnostics, "non-deterministic", path, "Strings must use NFC normalization.");
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      issue(diagnostics, "non-deterministic", path, "Numbers must be finite and must not be negative zero.");
    }
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value !== "object") {
    issue(diagnostics, "invalid-type", path, "Only canonical JSON data is accepted.");
    return;
  }
  let prototype: object | null;
  try { prototype = Object.getPrototypeOf(value); } catch {
    issue(diagnostics, "non-deterministic", path, "Input prototype inspection failed.");
    state.stopped = true;
    return;
  }
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) {
      issue(diagnostics, "non-deterministic", path, "Array subclasses are not canonical input.");
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        issue(diagnostics, "non-deterministic", `${path}.${index}`, "Sparse arrays are not canonical input.");
      }
    }
  } else if (prototype !== Object.prototype && prototype !== null) {
    issue(diagnostics, "non-deterministic", path, "Only plain records are accepted.");
  }
  inspectObject(value, path, depth, diagnostics, state);
}

export function inspectCanonicalShaderInput(input: unknown, diagnostics: ShaderDiagnostic[], rootPath = "$"): boolean {
  const before = diagnostics.length;
  inspectValue(input, rootPath, 0, diagnostics, { nodes: 0, stopped: false, seen: new WeakSet() });
  return diagnostics.length === before;
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exactFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: ShaderDiagnostic[],
): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) issue(diagnostics, "unknown-field", `${path}.${key}`, "Unknown field.");
  }
}
