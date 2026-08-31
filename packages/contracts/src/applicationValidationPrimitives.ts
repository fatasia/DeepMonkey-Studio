import { assertPathSafeResourceId } from "./resourceId.js";
type JsonObject = Record<string, unknown>;
export type Validator = (value: unknown, path: string) => void;

/** ApplicationDocument 各领域校验器共用的安全原语，统一处理普通对象、数组和 JSON 深度。 */
export function validateJsonObject(value: unknown, path: string): void {
  const object = expectObject(value, path);
  const ancestors = new WeakSet<object>([object]);
  validateJsonObjectProperties(object, path, ancestors);
}

export function validateJsonValue(value: unknown, path: string, ancestors = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    invalid(path, "必须是有限 JSON 数字");
  }
  if (typeof value !== "object") invalid(path, "必须是 JSON 值");
  if (ancestors.has(value)) invalid(path, "不能包含循环引用");
  ancestors.add(value);
  if (Array.isArray(value)) {
    validateJsonArray(value, path, ancestors);
  } else {
    const object = expectObject(value, path);
    validateJsonObjectProperties(object, path, ancestors);
  }
  ancestors.delete(value);
}

function validateJsonObjectProperties(object: JsonObject, path: string, ancestors: WeakSet<object>): void {
  rejectJsonSymbolProperties(object, path);
  for (const key of Object.getOwnPropertyNames(object)) {
    validateJsonValue(object[key], `${path}.${key}`, ancestors);
  }
}

function validateJsonArray(array: unknown[], path: string, ancestors: WeakSet<object>): void {
  rejectJsonSymbolProperties(array, path);
  for (const key of Object.getOwnPropertyNames(array)) {
    if (key === "length") continue;
    if (!isArrayIndex(key, array.length)) invalid(`${path}.${key}`, "不是有效的 JSON 数组索引");
  }
  for (let index = 0; index < array.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(array, index)) invalid(`${path}[${index}]`, "不能是稀疏数组项");
    validateJsonValue(array[index], `${path}[${index}]`, ancestors);
  }
}

function rejectJsonSymbolProperties(object: object, path: string): void {
  if (Object.getOwnPropertySymbols(object).length > 0) invalid(path, "不能包含 Symbol 属性");
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

export function validateArrayProperty(object: JsonObject, key: string, validator: Validator): void {
  required(object, key, (value, path) => expectArray(value, path, validator), "应用");
}

export function validateStringArray(value: unknown, path: string): void {
  expectArray(value, path, expectString);
}

export function validateLiteralArray(value: unknown, path: string, values: readonly string[]): void {
  expectArray(value, path, (item, itemPath) => expectLiteral(item, values, itemPath));
}

export function expectArray(value: unknown, path: string, validator: Validator): void {
  if (!Array.isArray(value)) invalid(path, "必须是数组");
  rejectJsonSymbolProperties(value, path);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "length") continue;
    if (!isArrayIndex(key, value.length)) invalid(`${path}.${key}`, "不是有效的数组索引");
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) invalid(`${path}[${index}]`, "不能是稀疏数组项");
    validator(value[index], `${path}[${index}]`);
  }
}

export function expectObject(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "必须是对象");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "必须是普通对象");
  return value as JsonObject;
}

export function expectString(value: unknown, path: string): void {
  if (typeof value !== "string") invalid(path, "必须是字符串");
}

export function expectPathSafeResourceId(value: unknown, path: string): void {
  try {
    assertPathSafeResourceId(value, path);
  } catch (error) {
    invalid(path, error instanceof Error ? error.message.replace(`${path} `, "") : "必须是路径安全 ID");
  }
}

export function expectBoolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") invalid(path, "必须是布尔值");
}

export function expectNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(path, "必须是有限数字");
}

export function expectPositiveInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 1) invalid(path, "必须是大于等于 1 的整数");
}

export function expectNonNegativeInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) invalid(path, "必须是大于等于 0 的整数");
}

export function expectStringNumberOrBoolean(value: unknown, path: string): void {
  if (typeof value === "number") return expectNumber(value, path);
  if (typeof value !== "string" && typeof value !== "boolean") invalid(path, "必须是字符串、数字或布尔值");
}

export function required(object: JsonObject, key: string, validator: Validator, path: string): void {
  if (!hasOwn(object, key)) invalid(`${path}.${key}`, "不能为空");
  validator(object[key], `${path}.${key}`);
}

export function optional(object: JsonObject, key: string, validator: Validator, path: string): void {
  if (hasOwn(object, key)) validator(object[key], `${path}.${key}`);
}

export function optionalAllowUndefined(object: JsonObject, key: string, validator: Validator, path: string): void {
  if (hasOwn(object, key) && object[key] !== undefined) validator(object[key], `${path}.${key}`);
}

export function requiredLiteral(object: JsonObject, key: string, values: readonly unknown[], path: string): void {
  required(object, key, (value, valuePath) => expectLiteral(value, values, valuePath), path);
}

export function optionalLiteral(object: JsonObject, key: string, values: readonly unknown[], path: string): void {
  optional(object, key, (value, valuePath) => expectLiteral(value, values, valuePath), path);
}

export function expectLiteral(value: unknown, values: readonly unknown[], path: string): void {
  if (!values.includes(value)) invalid(path, `必须是 ${values.join("、")} 之一`);
}

export function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export function invalid(path: string, reason: string): never {
  throw new Error(`${path} ${reason}`);
}

