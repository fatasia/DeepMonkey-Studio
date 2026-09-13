import {
  SHADER_MIGRATION_MAX_ARRAY_ITEMS,
  SHADER_MIGRATION_MAX_DEPTH,
  SHADER_MIGRATION_MAX_DIAGNOSTICS,
  SHADER_MIGRATION_MAX_NODES,
} from "./constants.js";
import type { ShaderMigrationDiagnostic } from "./types.js";

export interface DiagnosticSink {
  readonly diagnostics: ShaderMigrationDiagnostic[];
  capped: boolean;
}

export function addDiagnostic(
  sink: DiagnosticSink,
  code: string,
  path: string,
  message: string,
): void {
  if (sink.capped) return;
  if (sink.diagnostics.length < SHADER_MIGRATION_MAX_DIAGNOSTICS) {
    sink.diagnostics.push({ code, path, message });
    return;
  }
  sink.diagnostics[SHADER_MIGRATION_MAX_DIAGNOSTICS - 1] = {
    code: "DIAGNOSTIC_LIMIT",
    path: "$",
    message: `diagnostics were capped at ${SHADER_MIGRATION_MAX_DIAGNOSTICS}`,
  };
  sink.capped = true;
}

interface SnapshotState {
  nodes: number;
  budgetReported: boolean;
  exhausted: boolean;
  readonly seen: WeakSet<object>;
  readonly sink: DiagnosticSink;
}

function fail(state: SnapshotState, code: string, path: string, message: string): undefined {
  addDiagnostic(state.sink, code, path, message);
  return undefined;
}

function snapshotArray(value: unknown[], path: string, depth: number, state: SnapshotState): unknown[] | undefined {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    return fail(state, "SYMBOL_KEY", path, "symbol keys are forbidden");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || !Number.isSafeInteger(lengthDescriptor.value)) {
    return fail(state, "NON_JSON_ARRAY", path, "array length must be an inert integer data property");
  }
  const length = lengthDescriptor.value as number;
  if (length > SHADER_MIGRATION_MAX_ARRAY_ITEMS) {
    return fail(state, "ARRAY_BUDGET", path, `array exceeds ${SHADER_MIGRATION_MAX_ARRAY_ITEMS} items`);
  }
  const ownNames = Object.keys(descriptors).filter((key) => key !== "length");
  const expected = Array.from({ length }, (_, index) => String(index));
  if (ownNames.length !== expected.length || expected.some((key) => !(key in descriptors))) {
    return fail(state, "NON_JSON_ARRAY", path, "array must be dense and contain only indexed data properties");
  }
  const output: unknown[] = [];
  for (const key of expected) {
    if (state.exhausted || state.sink.capped) break;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor)) {
      output.push(fail(state, "ACCESSOR", `${path}[${key}]`, "accessor properties are forbidden"));
      continue;
    }
    output.push(snapshotValue(descriptor.value, `${path}[${key}]`, depth + 1, state));
  }
  return output;
}

function snapshotObject(
  value: object,
  path: string,
  depth: number,
  state: SnapshotState,
): Record<string, unknown> | undefined {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(state, "NON_PLAIN_OBJECT", path, "value must be a plain data object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key === "symbol")) {
    return fail(state, "SYMBOL_KEY", path, "symbol keys are forbidden");
  }
  const keys = Object.keys(descriptors).sort();
  if (keys.length > SHADER_MIGRATION_MAX_ARRAY_ITEMS) {
    return fail(state, "OBJECT_BUDGET", path, `object exceeds ${SHADER_MIGRATION_MAX_ARRAY_ITEMS} fields`);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (state.exhausted || state.sink.capped) break;
    const descriptor = descriptors[key];
    const childPath = path === "$" ? `$.${key}` : `${path}.${key}`;
    if (!descriptor || !("value" in descriptor)) {
      fail(state, "ACCESSOR", childPath, "accessor properties are forbidden");
      continue;
    }
    if (!descriptor.enumerable) {
      fail(state, "NON_ENUMERABLE", childPath, "non-enumerable fields are forbidden");
      continue;
    }
    output[key] = snapshotValue(descriptor.value, childPath, depth + 1, state);
  }
  return output;
}

function snapshotValue(value: unknown, path: string, depth: number, state: SnapshotState): unknown {
  if (state.exhausted || state.sink.capped) return undefined;
  state.nodes += 1;
  if (state.nodes > SHADER_MIGRATION_MAX_NODES) {
    state.exhausted = true;
    if (!state.budgetReported) {
      state.budgetReported = true;
      addDiagnostic(state.sink, "NODE_BUDGET", path, `data exceeds ${SHADER_MIGRATION_MAX_NODES} nodes`);
    }
    return undefined;
  }
  if (depth > SHADER_MIGRATION_MAX_DEPTH) {
    return fail(state, "DEPTH_BUDGET", path, `data exceeds depth ${SHADER_MIGRATION_MAX_DEPTH}`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fail(state, "NON_FINITE_NUMBER", path, "number must be finite");
  }
  if (typeof value !== "object") return fail(state, "NON_DATA_VALUE", path, "value is not JSON data");
  if (state.seen.has(value)) return fail(state, "REFERENCE_ALIAS", path, "cycles and repeated object references are forbidden");
  state.seen.add(value);
  return Array.isArray(value)
    ? snapshotArray(value, path, depth, state)
    : snapshotObject(value, path, depth, state);
}

export function safeDataSnapshot(input: unknown, sink: DiagnosticSink): unknown {
  try {
    return snapshotValue(input, "$", 0, {
      nodes: 0,
      budgetReported: false,
      exhausted: false,
      seen: new WeakSet<object>(),
      sink,
    });
  } catch {
    addDiagnostic(sink, "HOSTILE_OBJECT", "$", "input could not be inspected as inert data");
    return undefined;
  }
}
