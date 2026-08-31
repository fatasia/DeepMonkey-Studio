import type { SceneCommand, SceneMaterialCommandPatch, SceneObjectRef } from "./protocol.js";

import {
  SCENE_COMMAND_VALIDATION_LIMITS,
  type InspectedRecord,
  type NumberBounds,
  type SceneCommandValidationIssue,
  type SceneCommandValidationResult,
  type ValidationContext
} from "./commandValidationTypes.js";
import { addIssue, inspectArray, inspectRecord, parseJsonObject, parseJsonValue, propertyPath } from "./commandValidationSafety.js";

export { SCENE_COMMAND_VALIDATION_LIMITS } from "./commandValidationTypes.js";
export type {
  SceneCommandValidationIssue,
  SceneCommandValidationIssueCode,
  SceneCommandValidationResult
} from "./commandValidationTypes.js";

/** Error thrown by {@link parseSceneCommand} for untrusted command payloads. */
export class SceneCommandValidationError extends TypeError {
  readonly issues: SceneCommandValidationIssue[];

  constructor(issues: SceneCommandValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "SceneCommandValidationError";
    this.issues = issues.map((issue) => ({ ...issue }));
  }
}

const COMMAND_TYPES = [
  "object.set-visibility",
  "object.set-transform",
  "material.set",
  "selection.set",
  "camera.set",
  "camera.fly-to",
  "animation.control",
  "data.apply",
  "component.update",
  "unity.properties.set",
  "unity.action.invoke",
  "unity.scene.switch"
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
    case "material.set": {
      rejectUnknownProperties(record, ["id", "type", "target", "patch"], "$", context);
      const target = parseObjectRef(readRequired(record, "target", "$", context), "$.target", context);
      const patch = parseMaterialPatch(readRequired(record, "patch", "$", context), "$.patch", context);
      return target && patch ? { id, type, target, patch } : undefined;
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
    case "unity.properties.set": {
      rejectUnknownProperties(record, ["id", "type", "componentId", "values"], "$", context);
      const componentId = parseRequiredIdentifier(record, "componentId", "$", context);
      const values = parseJsonObject(readRequired(record, "values", "$", context), "$.values", context, 0);
      return componentId && values ? { id, type, componentId, values } : undefined;
    }
    case "unity.action.invoke": {
      rejectUnknownProperties(record, ["id", "type", "componentId", "action", "objectId", "value"], "$", context);
      const componentId = parseRequiredIdentifier(record, "componentId", "$", context);
      const action = parseRequiredIdentifier(record, "action", "$", context);
      const objectId = parseOptionalIdentifier(record, "objectId", "$", context);
      const value = record.values.has("value")
        ? parseJsonValue(record.values.get("value"), "$.value", context, 0)
        : undefined;
      if (!componentId || !action) return undefined;
      return {
        id,
        type,
        componentId,
        action,
        ...(objectId === undefined ? {} : { objectId }),
        ...(value === undefined ? {} : { value }),
      };
    }
    case "unity.scene.switch": {
      rejectUnknownProperties(record, ["id", "type", "componentId", "scene"], "$", context);
      const componentId = parseRequiredIdentifier(record, "componentId", "$", context);
      const scene = parseRequiredIdentifier(record, "scene", "$", context);
      return componentId && scene ? { id, type, componentId, scene } : undefined;
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

const MATERIAL_NUMBER_KEYS = [
  "emissiveIntensity",
  "roughness",
  "metalness",
  "normalScale",
  "textureRepeat",
  "textureRepeatX",
  "textureRepeatY",
  "textureOffsetX",
  "textureOffsetY",
  "textureRotation",
] as const;

function parseMaterialPatch(
  value: unknown,
  path: string,
  context: ValidationContext,
): SceneMaterialCommandPatch | undefined {
  const record = inspectRecord(value, path, context);
  if (!record) return undefined;
  const allowed = ["color", "emissive", "wireframe", "doubleSided", ...MATERIAL_NUMBER_KEYS] as const;
  rejectUnknownProperties(record, allowed, path, context);
  if (record.keys.length === 0) {
    addIssue(context, path, "invalid-value", "Expected at least one material property.");
    return undefined;
  }

  const patch: SceneMaterialCommandPatch = {};
  for (const key of ["color", "emissive"] as const) {
    if (!record.values.has(key)) continue;
    const color = parseMaterialColor(record.values.get(key), propertyPath(path, key), context);
    if (color !== undefined) patch[key] = color;
  }
  for (const key of ["wireframe", "doubleSided"] as const) {
    if (!record.values.has(key)) continue;
    const flag = parseBoolean(record.values.get(key), propertyPath(path, key), context);
    if (flag !== undefined) patch[key] = flag;
  }
  for (const key of MATERIAL_NUMBER_KEYS) {
    const number = parseMaterialNumber(record, key, path, context);
    if (number !== undefined) patch[key] = number;
  }
  return patch;
}

function parseMaterialColor(value: unknown, path: string, context: ValidationContext): string | undefined {
  const color = parseIdentifier(value, path, context);
  if (color && !/^#[0-9a-f]{6}$/i.test(color)) {
    addIssue(context, path, "invalid-value", "Expected a #RRGGBB color.");
    return undefined;
  }
  return color;
}

function parseMaterialNumber(
  record: InspectedRecord,
  key: typeof MATERIAL_NUMBER_KEYS[number],
  path: string,
  context: ValidationContext,
): number | undefined {
  const nonNegative = [
    "emissiveIntensity",
    "normalScale",
    "textureRepeat",
    "textureRepeatX",
    "textureRepeatY",
  ].includes(key);
  const number = parseOptionalNumber(record, key, path, context, nonNegative ? { atLeast: 0 } : {});
  if (number !== undefined && (key === "roughness" || key === "metalness") && (number < 0 || number > 1)) {
    addIssue(context, propertyPath(path, key), "invalid-value", "Expected a value from 0 to 1.");
    return undefined;
  }
  return number;
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

function isOneOf<const T extends readonly string[]>(value: string, values: T): value is T[number] {
  return (values as readonly string[]).includes(value);
}
