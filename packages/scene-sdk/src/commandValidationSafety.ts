/** 不可信命令载荷的安全遍历与 JSON 限制；禁止执行 getter，避免恶意对象影响编辑器线程。 */
import type { JsonValue } from "@bim-studio/contracts";
import type { InspectedRecord, SceneCommandValidationIssueCode, ValidationContext } from "./commandValidationTypes.js";
import { SCENE_COMMAND_VALIDATION_LIMITS, UNSAFE_JSON_KEYS } from "./commandValidationTypes.js";

export function parseJsonObject(
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

export function parseJsonValue(value: unknown, path: string, context: ValidationContext, depth: number): JsonValue | undefined {
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

export function inspectRecord(value: unknown, path: string, context: ValidationContext): InspectedRecord | undefined {
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

export function inspectArray(value: unknown, path: string, context: ValidationContext): unknown[] | undefined {
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


/** 生成稳定的字段路径，便于前端把校验错误定位到具体属性。 */
export function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? parent + "." + key : parent + "[" + JSON.stringify(key) + "]";
}

export function addIssue(
  context: ValidationContext,
  path: string,
  code: SceneCommandValidationIssueCode,
  message: string
): void {
  context.issues.push({ path, code, message });
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
