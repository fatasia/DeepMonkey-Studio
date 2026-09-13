import { DEEP_SHADER_PACKAGE_BUDGETS } from "./constants.js";
import type { ShaderPackageDiagnostic } from "./types.js";

interface WalkState { nodes: number; stopped: boolean; readonly seen: WeakSet<object> }

function issue(diagnostics: ShaderPackageDiagnostic[], code: ShaderPackageDiagnostic["code"], path: string, message: string): void {
  if (diagnostics.length < DEEP_SHADER_PACKAGE_BUDGETS.maxIssues) diagnostics.push({ code, path, message });
}

function inspect(value: unknown, path: string, depth: number, diagnostics: ShaderPackageDiagnostic[], state: WalkState): void {
  if (state.stopped) return;
  state.nodes += 1;
  if (state.nodes > DEEP_SHADER_PACKAGE_BUDGETS.maxInputNodes) {
    issue(diagnostics, "budget-exceeded", path, "Input exceeds the global node budget.");
    state.stopped = true;
    return;
  }
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    issue(diagnostics, "non-canonical", path, "Numbers must be finite and must not be negative zero.");
    return;
  }
  if (typeof value === "string" && value.normalize("NFC") !== value) {
    issue(diagnostics, "non-canonical", path, "Strings must use NFC normalization.");
    return;
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (typeof value !== "object") {
    issue(diagnostics, "invalid-type", path, "Only canonical JSON data is accepted.");
    return;
  }
  if (depth > DEEP_SHADER_PACKAGE_BUDGETS.maxDepth) {
    issue(diagnostics, "budget-exceeded", path, "Input exceeds the nesting-depth budget.");
    state.stopped = true;
    return;
  }
  if (state.seen.has(value)) {
    issue(diagnostics, "non-canonical", path, "Shared or cyclic object graphs are not accepted.");
    return;
  }
  state.seen.add(value);
  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  let keys: readonly PropertyKey[];
  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    if (isArray) {
      const length = Reflect.getOwnPropertyDescriptor(value, "length")?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > DEEP_SHADER_PACKAGE_BUDGETS.maxInputNodes) {
        issue(diagnostics, "budget-exceeded", `${path}.length`, "Array length exceeds the input budget.");
        state.stopped = true;
        return;
      }
    }
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    issue(diagnostics, "non-canonical", path, "Input reflection failed; proxies are not accepted.");
    state.stopped = true;
    return;
  }
  if ((isArray && prototype !== Array.prototype) || (!isArray && prototype !== Object.prototype && prototype !== null)) {
    issue(diagnostics, "non-canonical", path, "Only plain records and arrays are accepted.");
  }
  if (keys.some((key) => typeof key === "symbol")) issue(diagnostics, "non-canonical", path, "Symbol properties are not accepted.");
  if (isArray) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0) {
      issue(diagnostics, "non-canonical", `${path}.length`, "Array length is not canonical.");
      state.stopped = true;
      return;
    }
    for (let index = 0; index < length; index += 1) {
      if (!descriptors[String(index)]) issue(diagnostics, "non-canonical", `${path}.${index}`, "Sparse arrays are not accepted.");
    }
    for (const key of keys) {
      if (typeof key === "string" && key !== "length" && !/^(0|[1-9]\d*)$/.test(key)) issue(diagnostics, "non-canonical", `${path}.${key}`, "Named array properties are not canonical.");
    }
  }
  for (const key of keys) {
    if (typeof key !== "string" || (isArray && key === "length")) continue;
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || !("value" in descriptor)) {
      issue(diagnostics, "non-canonical", `${path}.${key}`, "Accessors are not accepted.");
      continue;
    }
    inspect(descriptor.value, `${path}.${key}`, depth + 1, diagnostics, state);
  }
}

export function inspectShaderPackageInput(value: unknown): readonly ShaderPackageDiagnostic[] {
  const diagnostics: ShaderPackageDiagnostic[] = [];
  inspect(value, "$", 0, diagnostics, { nodes: 0, stopped: false, seen: new WeakSet() });
  return Object.freeze(diagnostics.map((entry) => Object.freeze(entry)));
}
