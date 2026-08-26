import type { JsonValue } from "@bim-studio/contracts";
import type { SceneCommand, SceneObjectRef } from "./protocol.js";

export const SCENE_COMMAND_VALIDATION_LIMITS = {
  maxIdentifierLength: 1_024,
  maxDataStringLength: 65_536,
  maxJsonDepth: 32,
  maxJsonNodes: 10_000,
  maxArrayItems: 4_096,
  maxObjectProperties: 1_024
} as const;

export type SceneCommandValidationIssueCode =
  | "invalid-type"
  | "invalid-value"
  | "limit-exceeded"
  | "missing-property"
  | "unknown-property"
  | "unsafe-object";

export interface SceneCommandValidationIssue {
  path: string;
  code: SceneCommandValidationIssueCode;
  message: string;
}

export type SceneCommandValidationResult =
  | { valid: true; command: SceneCommand; issues: [] }
  | { valid: false; issues: SceneCommandValidationIssue[] };

/** Error thrown by {@link parseSceneCommand} for untrusted command payloads. */
export class SceneCommandValidationError extends TypeError {
  readonly issues: SceneCommandValidationIssue[];

  constructor(issues: SceneCommandValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "SceneCommandValidationError";
    this.issues = issues.map((issue) => ({ ...issue }));
  }
}

interface ValidationContext {
  issues: SceneCommandValidationIssue[];
  jsonNodes: number;
  jsonAncestors: WeakSet<object>;
}

interface InspectedRecord {
  keys: string[];
  values: Map<string, unknown>;
}

const COMMAND_TYPES = [
  "object.set-visibility",
  "object.set-transform",
  "selection.set",
  "camera.set",
  "camera.fly-to",
  "animation.control",
  "data.apply",
  "component.update"
] as const;

const ANIMATION_ACTIONS = ["play", "pause", "stop", "seek"] as const;
const UNSAFE_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Validates untrusted input and, on success, returns a detached command made only
 * from validated data. The input is never mutated and property accessors are not
 * executed.
 */
export function validateSceneCommand(input: unknown): SceneCommandValidationResult {
  const context: ValidationContext = {
    issues: [],
    jsonNodes: 0,
    jsonAncestors: new WeakSet<object>()
  };
  const record = inspectRecord(input, "$", context);
  if (!record) return { valid: false, issues: context.issues };

  const id = parseRequiredIdentifier(record, "id", "$", context);
  const typeValue = readRequired(record, "type", "$", context);
  const type = typeof typeValue === "string" ? typeValue : undefined;
  if (typeValue !== undefined && type === undefined) {
    addIssue(context, "$.type", "invalid-type", "Expected a command type string.");
  } else if (type !== undefined && !isOneOf(type, COMMAND_TYPES)) {
    addIssue(
      context,
      "$.type",
      "invalid-value",
      `Unsupported command type ${JSON.stringify(type)}. Expected one of: ${COMMAND_TYPES.join(", ")}.`
    );
  }

  let command: SceneCommand | undefined;
  if (id !== undefined && type !== undefined && isOneOf(type, COMMAND_TYPES)) {
    command = parseCommandByType(id, type, record, context);
  }

  if (!command || context.issues.length > 0) return { valid: false, issues: context.issues };
  return { valid: true, command, issues: [] };
}

/** Parses a command or throws a {@link SceneCommandValidationError} with path-based issues. */
export function parseSceneCommand(input: unknown): SceneCommand {
  const result = validateSceneCommand(input);
  if (!result.valid) throw new SceneCommandValidationError(result.issues);
  return result.command;
}

/** Boolean convenience API for narrowing values at host boundaries. */
export function isSceneCommand(input: unknown): input is SceneCommand {
  return validateSceneCommand(input).valid;
}

function parseCommandByType(
  id: string,
  type: typeof COMMAND_TYPES[number],
  record: InspectedRecord,
  context: ValidationContext
): SceneCommand | undefined {
  switch (type) {
    case "object.set-visibility": {
      rejectUnknownProperties(record, ["id", "type", "target", "visible"], "$", context);
      const target = parseObjectRef(readRequired(record, "target", "$", context), "$.target", context);
      const visible = parseBoolean(readRequired(record, "visible", "$", context), "$.visible", context);
      return target && visible !== undefined ? { id, type, target, visible } : undefined;
    }
    case "object.set-transform": {
      rejectUnknownProperties(record, ["id", "type", "target", "position", "rotation", "scale"], "$", context);
      const target = parseObjectRef(readRequired(record, "target", "$", context), "$.target", context);
      const position = parseOptionalVector(record, "position", "$", context);
      const rotation = parseOptionalVector(record, "rotation", "$", context);
      const scale = parseOptionalVector(record, "scale", "$", context);
      if (!target) return undefined;
      return {
        id,
        type,
        target,
        ...(position === undefined ? {} : { position }),
        ...(rotation === undefined ? {} : { rotation }),
        ...(scale === undefined ? {} : { scale })
      };
    }
    case "selection.set": {
      rejectUnknownProperties(record, ["id", "type", "targets"], "$", context);
      const targets = parseObjectRefArray(readRequired(record, "targets", "$", context), "$.targets", context);
      return targets ? { id, type, targets } : undefined;
    }
    case "camera.set": {
      rejectUnknownProperties(record, ["id", "type", "sceneId", "position", "target", "near", "far", "fov"], "$", context);
      const sceneId = parseRequiredIdentifier(record, "sceneId", "$", context);
      const position = parseVector(readRequired(record, "position", "$", context), "$.position", context);
      const target = parseVector(readRequired(record, "target", "$", context), "$.target", context);
      const near = parseOptionalNumber(record, "near", "$", context, { greaterThan: 0 });
      const far = parseOptionalNumber(record, "far", "$", context, { greaterThan: 0 });
      const fov = parseOptionalNumber(record, "fov", "$", context, { greaterThan: 0, lessThan: 180 });
      if (near !== undefined && far !== undefined && far <= near) {
        addIssue(context, "$.far", "invalid-value", "Expected far to be greater than near.");
      }
      if (!sceneId || !position || !target) return undefined;
      return {
        id,
        type,
        sceneId,
        position,
        target,
        ...(near === undefined ? {} : { near }),
        ...(far === undefined ? {} : { far }),
        ...(fov === undefined ? {} : { fov })
      };
    }
    case "camera.fly-to": {
      rejectUnknownProperties(record, ["id", "type", "sceneId", "target", "durationMs"], "$", context);
      const sceneId = parseRequiredIdentifier(record, "sceneId", "$", context);
      const target = parseFlyToTarget(readRequired(record, "target", "$", context), "$.target", context);
      const durationMs = parseNumber(readRequired(record, "durationMs", "$", context), "$.durationMs", context, { atLeast: 0 });
      return sceneId && target && durationMs !== undefined ? { id, type, sceneId, target, durationMs } : undefined;
    }
    case "animation.control": {
      rejectUnknownProperties(record, ["id", "type", "target", "action", "clipId", "time"], "$", context);
      const target = parseObjectRef(readRequired(record, "target", "$", context), "$.target", context);
      const actionValue = readRequired(record, "action", "$", context);
      const action = typeof actionValue === "string" && isOneOf(actionValue, ANIMATION_ACTIONS)
        ? actionValue
        : undefined;
      if (actionValue !== undefined && action === undefined) {
        addIssue(context, "$.action", "invalid-value", `Expected one of: ${ANIMATION_ACTIONS.join(", ")}.`);
      }
      const clipId = parseOptionalIdentifier(record, "clipId", "$", context);
      const time = parseOptionalNumber(record, "time", "$", context, { atLeast: 0 });
      if (!target || !action) return undefined;
      return {
        id,
        type,
        target,
        action,
        ...(clipId === undefined ? {} : { clipId }),
        ...(time === undefined ? {} : { time })
      };
    }
    case "data.apply": {
      rejectUnknownProperties(record, ["id", "type", "target", "values", "timestamp"], "$", context);
      const target = parseObjectRef(readRequired(record, "target", "$", context), "$.target", context);
      const values = parseJsonObject(readRequired(record, "values", "$", context), "$.values", context, 0);
      const timestamp = parseRequiredIdentifier(record, "timestamp", "$", context);
      return target && values && timestamp ? { id, type, target, values, timestamp } : undefined;
    }
    case "component.update": {
      rejectUnknownProperties(record, ["id", "type", "componentId", "patch"], "$", context);
      const componentId = parseRequiredIdentifier(record, "componentId", "$", context);
      const patch = parseJsonObject(readRequired(record, "patch", "$", context), "$.patch", context, 0);
      return componentId && patch ? { id, type, componentId, patch } : undefined;
    }
  }
}

function parseObjectRef(value: unknown, path: string, context: ValidationContext): SceneObjectRef | undefined {
  const record = inspectRecord(value, path, context);
  if (!record) return undefined;
  const kindValue = readRequired(record, "kind", path, context);
  if (kindValue !== "scene" && kindValue !== "object" && kindValue !== "mesh") {
    if (kindValue !== undefined) addIssue(context, `${path}.kind`, "invalid-value", "Expected scene, object, or mesh.");
    return undefined;
  }

  if (kindValue === "scene") {
    rejectUnknownProperties(record, ["kind", "sceneId"], path, context);
    const sceneId = parseRequiredIdentifier(record, "sceneId", path, context);
    return sceneId ? { kind: "scene", sceneId } : undefined;
  }
  if (kindValue === "object") {
    rejectUnknownProperties(record, ["kind", "sceneId", "objectId"], path, context);
    const sceneId = parseRequiredIdentifier(record, "sceneId", path, context);
    const objectId = parseRequiredIdentifier(record, "objectId", path, context);
    return sceneId && objectId ? { kind: "object", sceneId, objectId } : undefined;
  }

  rejectUnknownProperties(record, ["kind", "sceneId", "objectId", "meshId"], path, context);
  const sceneId = parseRequiredIdentifier(record, "sceneId", path, context);
  const objectId = parseRequiredIdentifier(record, "objectId", path, context);
  const meshId = parseRequiredIdentifier(record, "meshId", path, context);
  return sceneId && objectId && meshId ? { kind: "mesh", sceneId, objectId, meshId } : undefined;
}

function parseObjectRefArray(value: unknown, path: string, context: ValidationContext): SceneObjectRef[] | undefined {
  const array = inspectArray(value, path, context);
  if (!array) return undefined;
  if (array.length > SCENE_COMMAND_VALIDATION_LIMITS.maxArrayItems) {
    addIssue(context, path, "limit-exceeded", `Expected at most ${SCENE_COMMAND_VALIDATION_LIMITS.maxArrayItems} targets.`);
    return undefined;
  }
  const targets: SceneObjectRef[] = [];
  for (let index = 0; index < array.length; index += 1) {
    const target = parseObjectRef(array[index], `${path}[${index}]`, context);
    if (target) targets.push(target);
  }
  return targets.length === array.length ? targets : undefined;
}

function parseFlyToTarget(
  value: unknown,
  path: string,
  context: ValidationContext
): SceneObjectRef | { position: [number, number, number] } | undefined {
  const record = inspectRecord(value, path, context);
  if (!record) return undefined;
  if (record.values.has("position")) {
    rejectUnknownProperties(record, ["position"], path, context);
    const position = parseVector(readRequired(record, "position", path, context), `${path}.position`, context);
    return position ? { position } : undefined;
  }
  return parseObjectRef(value, path, context);
}

function parseOptionalVector(
  record: InspectedRecord,
  key: string,
  parentPath: string,
  context: ValidationContext
): [number, number, number] | undefined {
  if (!record.values.has(key)) return undefined;
  return parseVector(record.values.get(key), propertyPath(parentPath, key), context);
}

function parseVector(value: unknown, path: string, context: ValidationContext): [number, number, number] | undefined {
  const array = inspectArray(value, path, context);
  if (!array) return undefined;
  if (array.length !== 3) {
    addIssue(context, path, "invalid-value", "Expected exactly three numeric components.");
    return undefined;
  }
  const components = array.map((component, index) => parseNumber(component, `${path}[${index}]`, context));
  return components.every((component) => component !== undefined)
    ? [components[0]!, components[1]!, components[2]!]
    : undefined;
}

function parseBoolean(value: unknown, path: string, context: ValidationContext): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value !== undefined) addIssue(context, path, "invalid-type", "Expected a boolean.");
  return undefined;
}

function parseOptionalNumber(
  record: InspectedRecord,
  key: string,
  parentPath: string,
  context: ValidationContext,
  bounds: NumberBounds = {}
): number | undefined {
  if (!record.values.has(key)) return undefined;
  const value = record.values.get(key);
  if (value === undefined) {
    addIssue(context, propertyPath(parentPath, key), "invalid-type", "Expected a finite number.");
    return undefined;
  }
  return parseNumber(value, propertyPath(parentPath, key), context, bounds);
}

interface NumberBounds {
  atLeast?: number;
  greaterThan?: number;
  lessThan?: number;
}

function parseNumber(
  value: unknown,
  path: string,
  context: ValidationContext,
  bounds: NumberBounds = {}
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (value !== undefined) addIssue(context, path, "invalid-type", "Expected a finite number.");
    return undefined;
  }
  if (bounds.atLeast !== undefined && value < bounds.atLeast) {
    addIssue(context, path, "invalid-value", `Expected a value greater than or equal to ${bounds.atLeast}.`);
    return undefined;
  }
  if (bounds.greaterThan !== undefined && value <= bounds.greaterThan) {
    addIssue(context, path, "invalid-value", `Expected a value greater than ${bounds.greaterThan}.`);
    return undefined;
  }
  if (bounds.lessThan !== undefined && value >= bounds.lessThan) {
    addIssue(context, path, "invalid-value", `Expected a value less than ${bounds.lessThan}.`);
    return undefined;
  }
  return value;
}

function parseRequiredIdentifier(
  record: InspectedRecord,
  key: string,
  parentPath: string,
  context: ValidationContext
): string | undefined {
  return parseIdentifier(readRequired(record, key, parentPath, context), propertyPath(parentPath, key), context);
}

function parseOptionalIdentifier(
  record: InspectedRecord,
  key: string,
  parentPath: string,
  context: ValidationContext
): string | undefined {
  if (!record.values.has(key)) return undefined;
  const value = record.values.get(key);
  if (value === undefined) {
    addIssue(context, propertyPath(parentPath, key), "invalid-type", "Expected a string.");
    return undefined;
  }
  return parseIdentifier(value, propertyPath(parentPath, key), context);
}

function parseIdentifier(value: unknown, path: string, context: ValidationContext): string | undefined {
  if (typeof value !== "string") {
    if (value !== undefined) addIssue(context, path, "invalid-type", "Expected a string.");
    return undefined;
  }
  if (value.trim().length === 0) {
    addIssue(context, path, "invalid-value", "Expected a non-empty string.");
    return undefined;
  }
  if (value.length > SCENE_COMMAND_VALIDATION_LIMITS.maxIdentifierLength) {
    addIssue(
      context,
      path,
      "limit-exceeded",
      `Expected at most ${SCENE_COMMAND_VALIDATION_LIMITS.maxIdentifierLength} characters.`
    );
    return undefined;
  }
  return value;
}

function parseJsonObject(
  value: unknown,
  path: string,
  context: ValidationContext,
  depth: number
): Record<string, JsonValue> | undefined {
  if (!isPlainRecord(value)) {
    addIssue(context, path, "invalid-type", "Expected a JSON object.");
    return undefined;
  }
  const parsed = parseJsonValue(value, path, context, depth);
  return parsed !== undefined && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, JsonValue>
    : undefined;
}

function parseJsonValue(value: unknown, path: string, context: ValidationContext, depth: number): JsonValue | undefined {
  context.jsonNodes += 1;
  if (context.jsonNodes > SCENE_COMMAND_VALIDATION_LIMITS.maxJsonNodes) {
    addIssue(context, path, "limit-exceeded", `JSON payload exceeds ${SCENE_COMMAND_VALIDATION_LIMITS.maxJsonNodes} values.`);
    return undefined;
  }
  if (depth > SCENE_COMMAND_VALIDATION_LIMITS.maxJsonDepth) {
    addIssue(context, path, "limit-exceeded", `JSON payload exceeds ${SCENE_COMMAND_VALIDATION_LIMITS.maxJsonDepth} levels.`);
    return undefined;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    addIssue(context, path, "invalid-value", "JSON numbers must be finite.");
    return undefined;
  }
  if (typeof value === "string") {
    if (value.length <= SCENE_COMMAND_VALIDATION_LIMITS.maxDataStringLength) return value;
    addIssue(
      context,
      path,
      "limit-exceeded",
      `JSON strings must not exceed ${SCENE_COMMAND_VALIDATION_LIMITS.maxDataStringLength} characters.`
    );
    return undefined;
  }
  if (value === null || typeof value !== "object") {
    addIssue(context, path, "invalid-type", "Expected a JSON value.");
    return undefined;
  }
  if (context.jsonAncestors.has(value)) {
    addIssue(context, path, "invalid-value", "JSON payload must not contain cycles.");
    return undefined;
  }
  context.jsonAncestors.add(value);
  try {
    if (safeIsArray(value)) {
      const array = inspectArray(value, path, context);
      if (!array) return undefined;
      if (array.length > SCENE_COMMAND_VALIDATION_LIMITS.maxArrayItems) {
        addIssue(context, path, "limit-exceeded", `Expected at most ${SCENE_COMMAND_VALIDATION_LIMITS.maxArrayItems} array items.`);
        return undefined;
      }
      const output: JsonValue[] = [];
      for (let index = 0; index < array.length; index += 1) {
        const item = parseJsonValue(array[index], `${path}[${index}]`, context, depth + 1);
        if (item !== undefined) output.push(item);
      }
      return output.length === array.length ? output : undefined;
    }

    const record = inspectRecord(value, path, context);
    if (!record) return undefined;
    if (record.keys.length > SCENE_COMMAND_VALIDATION_LIMITS.maxObjectProperties) {
      addIssue(
        context,
        path,
        "limit-exceeded",
        `Expected at most ${SCENE_COMMAND_VALIDATION_LIMITS.maxObjectProperties} object properties.`
      );
      return undefined;
    }
    const output: Record<string, JsonValue> = {};
    for (const key of record.keys) {
      const childPath = propertyPath(path, key);
      if (UNSAFE_JSON_KEYS.has(key)) {
        addIssue(context, childPath, "unsafe-object", `Property ${JSON.stringify(key)} is not allowed in JSON command data.`);
        continue;
      }
      if (!record.values.has(key)) continue;
      const child = parseJsonValue(record.values.get(key), childPath, context, depth + 1);
      if (child !== undefined) output[key] = child;
    }
    return Object.keys(output).length === record.keys.length ? output : undefined;
  } finally {
    context.jsonAncestors.delete(value);
  }
}

function inspectRecord(value: unknown, path: string, context: ValidationContext): InspectedRecord | undefined {
  if (!isPlainRecord(value)) {
    addIssue(context, path, "invalid-type", "Expected a plain object.");
    return undefined;
  }
  const keys = safeOwnKeys(value, path, context);
  if (!keys) return undefined;
  const stringKeys: string[] = [];
  const values = new Map<string, unknown>();
  for (const key of keys) {
    if (typeof key !== "string") {
      addIssue(context, path, "unsafe-object", "Symbol properties are not allowed.");
      continue;
    }
    stringKeys.push(key);
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      addIssue(context, propertyPath(path, key), "unsafe-object", "Unable to inspect property safely.");
      continue;
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      addIssue(context, propertyPath(path, key), "unsafe-object", "Expected an enumerable data property.");
      continue;
    }
    values.set(key, descriptor.value);
  }
  return { keys: stringKeys, values };
}

function inspectArray(value: unknown, path: string, context: ValidationContext): unknown[] | undefined {
  if (!safeIsArray(value)) {
    addIssue(context, path, "invalid-type", "Expected an array.");
    return undefined;
  }
  let length: number;
  let keys: PropertyKey[];
  try {
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(value, "length");
    if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
      addIssue(context, path, "unsafe-object", "Unable to inspect array length safely.");
      return undefined;
    }
    length = lengthDescriptor.value;
    keys = Reflect.ownKeys(value);
  } catch {
    addIssue(context, path, "unsafe-object", "Unable to inspect array safely.");
    return undefined;
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > SCENE_COMMAND_VALIDATION_LIMITS.maxArrayItems) {
    addIssue(context, path, "limit-exceeded", `Expected at most ${SCENE_COMMAND_VALIDATION_LIMITS.maxArrayItems} array items.`);
    return undefined;
  }
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length) {
      addIssue(context, path, "unsafe-object", "Array contains unsupported custom properties.");
      return undefined;
    }
  }
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, String(index));
    } catch {
      addIssue(context, `${path}[${index}]`, "unsafe-object", "Unable to inspect array item safely.");
      return undefined;
    }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      addIssue(context, `${path}[${index}]`, "unsafe-object", "Expected a dense array of data values.");
      return undefined;
    }
    output.push(descriptor.value);
  }
  return output;
}

function readRequired(
  record: InspectedRecord,
  key: string,
  parentPath: string,
  context: ValidationContext
): unknown {
  if (!record.values.has(key)) {
    addIssue(context, propertyPath(parentPath, key), "missing-property", `Missing required property ${JSON.stringify(key)}.`);
    return undefined;
  }
  const value = record.values.get(key);
  if (value === undefined) {
    addIssue(context, propertyPath(parentPath, key), "invalid-type", `Required property ${JSON.stringify(key)} must not be undefined.`);
  }
  return value;
}

function rejectUnknownProperties(
  record: InspectedRecord,
  allowed: readonly string[],
  path: string,
  context: ValidationContext
): void {
  const allowedSet = new Set(allowed);
  for (const key of record.keys) {
    if (!allowedSet.has(key)) {
      addIssue(context, propertyPath(path, key), "unknown-property", `Unknown property ${JSON.stringify(key)}.`);
    }
  }
}

function safeOwnKeys(value: object, path: string, context: ValidationContext): PropertyKey[] | undefined {
  try {
    return Reflect.ownKeys(value);
  } catch {
    addIssue(context, path, "unsafe-object", "Unable to inspect object properties safely.");
    return undefined;
  }
}

function isPlainRecord(value: unknown): value is object {
  if (value === null || typeof value !== "object" || safeIsArray(value)) return false;
  try {
    const prototype = Reflect.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function safeIsArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

function isOneOf<const T extends readonly string[]>(value: string, values: T): value is T[number] {
  return (values as readonly string[]).includes(value);
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function addIssue(
  context: ValidationContext,
  path: string,
  code: SceneCommandValidationIssueCode,
  message: string
): void {
  context.issues.push({ path, code, message });
}
