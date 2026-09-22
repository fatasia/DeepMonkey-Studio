import type { SceneMaterialCommandPatch } from "./protocol.js";
import type {
  InspectedRecord,
  NumberBounds,
  ValidationContext,
} from "./commandValidationTypes.js";
import { SCENE_COMMAND_VALIDATION_LIMITS } from "./commandValidationTypes.js";
import { addIssue, inspectRecord, propertyPath } from "./commandValidationSafety.js";

export function parseBoolean(
  value: unknown,
  path: string,
  context: ValidationContext,
): boolean | undefined {
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

export function parseMaterialPatch(
  value: unknown,
  path: string,
  context: ValidationContext,
): SceneMaterialCommandPatch | undefined {
  const record = inspectRecord(value, path, context);
  if (!record) return undefined;
  const allowed = [
    "color",
    "emissive",
    "wireframe",
    "doubleSided",
    ...MATERIAL_NUMBER_KEYS,
  ] as const;
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

function parseMaterialColor(
  value: unknown,
  path: string,
  context: ValidationContext,
): string | undefined {
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
  const number = parseOptionalNumber(
    record,
    key,
    path,
    context,
    nonNegative ? { atLeast: 0 } : {},
  );
  if (
    number !== undefined &&
    (key === "roughness" || key === "metalness") &&
    (number < 0 || number > 1)
  ) {
    addIssue(context, propertyPath(path, key), "invalid-value", "Expected a value from 0 to 1.");
    return undefined;
  }
  return number;
}

export function parseOptionalNumber(
  record: InspectedRecord,
  key: string,
  parentPath: string,
  context: ValidationContext,
  bounds: NumberBounds = {},
): number | undefined {
  if (!record.values.has(key)) return undefined;
  const value = record.values.get(key);
  if (value === undefined) {
    addIssue(context, propertyPath(parentPath, key), "invalid-type", "Expected a finite number.");
    return undefined;
  }
  return parseNumber(value, propertyPath(parentPath, key), context, bounds);
}

export function parseNumber(
  value: unknown,
  path: string,
  context: ValidationContext,
  bounds: NumberBounds = {},
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    if (value !== undefined) addIssue(context, path, "invalid-type", "Expected a finite number.");
    return undefined;
  }
  if (bounds.atLeast !== undefined && value < bounds.atLeast) {
    addIssue(
      context,
      path,
      "invalid-value",
      `Expected a value greater than or equal to ${bounds.atLeast}.`,
    );
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

export function parseRequiredIdentifier(
  record: InspectedRecord,
  key: string,
  parentPath: string,
  context: ValidationContext,
): string | undefined {
  return parseIdentifier(
    readRequired(record, key, parentPath, context),
    propertyPath(parentPath, key),
    context,
  );
}

export function parseOptionalIdentifier(
  record: InspectedRecord,
  key: string,
  parentPath: string,
  context: ValidationContext,
): string | undefined {
  if (!record.values.has(key)) return undefined;
  const value = record.values.get(key);
  if (value === undefined) {
    addIssue(context, propertyPath(parentPath, key), "invalid-type", "Expected a string.");
    return undefined;
  }
  return parseIdentifier(value, propertyPath(parentPath, key), context);
}

function parseIdentifier(
  value: unknown,
  path: string,
  context: ValidationContext,
): string | undefined {
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
      `Expected at most ${SCENE_COMMAND_VALIDATION_LIMITS.maxIdentifierLength} characters.`,
    );
    return undefined;
  }
  return value;
}

export function readRequired(
  record: InspectedRecord,
  key: string,
  parentPath: string,
  context: ValidationContext,
): unknown {
  if (!record.values.has(key)) {
    addIssue(
      context,
      propertyPath(parentPath, key),
      "missing-property",
      `Missing required property ${JSON.stringify(key)}.`,
    );
    return undefined;
  }
  const value = record.values.get(key);
  if (value === undefined) {
    addIssue(
      context,
      propertyPath(parentPath, key),
      "invalid-type",
      `Required property ${JSON.stringify(key)} must not be undefined.`,
    );
  }
  return value;
}

export function rejectUnknownProperties(
  record: InspectedRecord,
  allowed: readonly string[],
  path: string,
  context: ValidationContext,
): void {
  const allowedSet = new Set(allowed);
  for (const key of record.keys) {
    if (!allowedSet.has(key)) {
      addIssue(
        context,
        propertyPath(path, key),
        "unknown-property",
        `Unknown property ${JSON.stringify(key)}.`,
      );
    }
  }
}

export function isOneOf<const T extends readonly string[]>(
  value: string,
  values: T,
): value is T[number] {
  return (values as readonly string[]).includes(value);
}
