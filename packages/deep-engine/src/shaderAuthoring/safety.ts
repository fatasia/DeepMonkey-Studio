import { SHADER_AUTHORING_BUDGETS } from "./types.js";

export interface CanonicalInputIssue {
  readonly code: "invalid-type" | "non-deterministic" | "budget-exceeded";
  readonly path: string;
  readonly message: string;
}

interface ReadState {
  nodes: number;
  stopped: boolean;
  readonly seen: WeakSet<object>;
  readonly issues: CanonicalInputIssue[];
}

function report(state: ReadState, issue: CanonicalInputIssue): void {
  if (state.issues.length >= SHADER_AUTHORING_BUDGETS.maxIssues) return;
  state.issues.push(Object.freeze(issue));
}

function readObject(value: object, path: string, depth: number, state: ReadState): unknown {
  if (state.seen.has(value)) {
    report(state, { code: "non-deterministic", path, message: "Cyclic input is not accepted." });
    return undefined;
  }
  state.seen.add(value);
  let prototype: object | null;
  let keys: PropertyKey[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    report(state, { code: "non-deterministic", path, message: "Input object inspection failed." });
    state.stopped = true;
    return undefined;
  }
  const array = Array.isArray(value);
  if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
    report(state, { code: "non-deterministic", path, message: "Only plain JSON records and arrays are accepted." });
  }
  if (keys.some((key) => typeof key === "symbol")) {
    report(state, { code: "non-deterministic", path, message: "Symbol keys are not canonical input." });
  }
  const result: unknown[] | Record<string, unknown> = array ? [] : {};
  const stringKeys = keys.filter((key): key is string => typeof key === "string" && (!array || key !== "length"));
  if (array) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      report(state, { code: "non-deterministic", path, message: "Array length is not canonical." });
      state.seen.delete(value);
      return result;
    }
    for (const key of stringKeys) {
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
        report(state, { code: "non-deterministic", path: `${path}.${key}`, message: "Arrays cannot contain named fields." });
      }
    }
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) {
        report(state, { code: "non-deterministic", path: `${path}.${index}`, message: "Sparse arrays are not canonical input." });
      }
    }
  }
  for (const key of stringKeys.sort()) {
    if (state.stopped) break;
    const descriptor = descriptors[key];
    const keyPath = array ? `${path}.${key}` : `${path}.${key}`;
    if (!descriptor || descriptor.get || descriptor.set) {
      report(state, { code: "non-deterministic", path: keyPath, message: "Accessors are not accepted." });
      continue;
    }
    if (!descriptor.enumerable) {
      report(state, { code: "non-deterministic", path: keyPath, message: "Non-enumerable fields are not canonical input." });
      continue;
    }
    const child = readValue(descriptor.value, keyPath, depth + 1, state);
    if (array) {
      const index = Number(key);
      if (Number.isSafeInteger(index) && index >= 0) (result as unknown[])[index] = child;
    }
    else (result as Record<string, unknown>)[key] = child;
  }
  state.seen.delete(value);
  return result;
}

function readValue(value: unknown, path: string, depth: number, state: ReadState): unknown {
  if (state.stopped) return undefined;
  state.nodes += 1;
  if (state.nodes > SHADER_AUTHORING_BUDGETS.maxInputNodes) {
    report(state, { code: "budget-exceeded", path, message: "Input exceeds the authoring node budget." });
    state.stopped = true;
    return undefined;
  }
  if (depth > SHADER_AUTHORING_BUDGETS.maxDepth) {
    report(state, { code: "budget-exceeded", path, message: "Input exceeds the authoring depth budget." });
    state.stopped = true;
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      report(state, { code: "non-deterministic", path, message: "Numbers must be finite and cannot be negative zero." });
    }
    return value;
  }
  if (typeof value === "string") {
    if (value.length > SHADER_AUTHORING_BUDGETS.maxSourceLength) {
      report(state, { code: "budget-exceeded", path, message: "String exceeds the authoring size limit." });
    } else if (value.normalize("NFC") !== value) {
      report(state, { code: "non-deterministic", path, message: "Strings must use NFC normalization." });
    }
    return value;
  }
  if (typeof value !== "object") {
    report(state, { code: "invalid-type", path, message: "Only canonical JSON data is accepted." });
    return undefined;
  }
  return readObject(value, path, depth, state);
}

export function readCanonicalInput(input: unknown): Readonly<{
  success: boolean;
  value?: unknown;
  issues: readonly CanonicalInputIssue[];
}> {
  const state: ReadState = { nodes: 0, stopped: false, seen: new WeakSet(), issues: [] };
  const value = readValue(input, "$", 0, state);
  return Object.freeze({
    success: state.issues.length === 0,
    ...(state.issues.length === 0 ? { value } : {}),
    issues: Object.freeze(state.issues),
  });
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
