export type DirectBindingTemplateScalar = string | number | boolean | null;
export type DirectBindingTemplateValue =
  | DirectBindingTemplateScalar
  | DirectBindingTemplateValue[]
  | { [key: string]: DirectBindingTemplateValue };

export type DirectBindingHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface DirectBindingSelection {
  /** A small, deterministic JSONPath subset rooted at $, for example $.data.items[0].value. */
  jsonPath?: string;
  /** Optional object field selected after jsonPath has been evaluated. */
  field?: string;
}

export interface DirectBindingRefreshPolicy {
  intervalMs: number;
  immediate?: boolean;
}

export interface DirectBindingReconnectPolicy {
  enabled: boolean;
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

export interface DirectBindingHttpOptions {
  method: DirectBindingHttpMethod;
  params?: Record<string, DirectBindingTemplateScalar>;
  bodyTemplate?: DirectBindingTemplateValue;
  refresh: DirectBindingRefreshPolicy;
}

export interface DirectBindingWebSocketOptions {
  protocols?: string[];
  subscribeMessageTemplate?: DirectBindingTemplateValue;
  reconnect: DirectBindingReconnectPolicy;
}

/**
 * A data source consumed through the BIM Studio server gateway. Browsers must
 * never connect to endpoint directly; credentialRef is resolved server-side.
 */
export interface DirectBindingSpec {
  version: 1;
  gateway: "server";
  transport: "http" | "websocket";
  endpoint: string;
  credentialRef?: string;
  /** Omitted means read-only. No writable mode is currently accepted. */
  access?: "read-only";
  selection?: DirectBindingSelection;
  http?: DirectBindingHttpOptions;
  websocket?: DirectBindingWebSocketOptions;
}

type JsonObject = Record<string, unknown>;

export function assertDirectBindingSpec(value: unknown, path = "directBinding"): asserts value is DirectBindingSpec {
  const binding = object(value, path);
  literal(binding.version, [1], `${path}.version`);
  literal(binding.gateway, ["server"], `${path}.gateway`);
  literal(binding.transport, ["http", "websocket"], `${path}.transport`);
  string(binding.endpoint, `${path}.endpoint`);
  optional(binding, "credentialRef", string, path);
  optionalLiteral(binding, "access", ["read-only"], path);
  optional(binding, "selection", validateSelection, path);

  if (binding.transport === "http") {
    required(binding, "http", validateHttp, path);
    if (has(binding, "websocket")) invalid(`${path}.websocket`, "不能用于 HTTP 绑定");
  } else {
    required(binding, "websocket", validateWebSocket, path);
    if (has(binding, "http")) invalid(`${path}.http`, "不能用于 WebSocket 绑定");
  }
}

function validateSelection(value: unknown, path: string): void {
  const selection = object(value, path);
  optional(selection, "jsonPath", (jsonPath, jsonPathPath) => {
    string(jsonPath, jsonPathPath);
    if (!isSupportedJsonPath(jsonPath as string)) invalid(jsonPathPath, "仅支持以 $ 开头的属性和数组下标");
  }, path);
  optional(selection, "field", string, path);
  if (!has(selection, "jsonPath") && !has(selection, "field")) invalid(path, "至少需要 jsonPath 或 field");
}

function isSupportedJsonPath(path: string): boolean {
  if (path === "$") return true;
  if (!path.startsWith("$")) return false;
  const tokens = path.slice(1).match(/\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\["([^"\\]+)"\]|\['([^'\\]+)'\]/g);
  return Boolean(tokens && tokens.join("") === path.slice(1));
}

function validateHttp(value: unknown, path: string): void {
  const http = object(value, path);
  requiredLiteral(http, "method", ["GET", "POST", "PUT", "PATCH", "DELETE"], path);
  optional(http, "params", (params, paramsPath) => {
    const entries = object(params, paramsPath);
    for (const [key, item] of Object.entries(entries)) {
      if (!key) invalid(paramsPath, "参数名不能为空");
      scalar(item, `${paramsPath}.${key}`);
    }
  }, path);
  optional(http, "bodyTemplate", templateValue, path);
  required(http, "refresh", (refresh, refreshPath) => {
    const policy = object(refresh, refreshPath);
    required(policy, "intervalMs", positiveInteger, refreshPath);
    optional(policy, "immediate", boolean, refreshPath);
  }, path);
}

function validateWebSocket(value: unknown, path: string): void {
  const websocket = object(value, path);
  optional(websocket, "protocols", (protocols, protocolsPath) => array(protocols, protocolsPath, string), path);
  optional(websocket, "subscribeMessageTemplate", templateValue, path);
  required(websocket, "reconnect", (reconnect, reconnectPath) => {
    const policy = object(reconnect, reconnectPath);
    required(policy, "enabled", boolean, reconnectPath);
    required(policy, "initialDelayMs", nonNegativeInteger, reconnectPath);
    required(policy, "maxDelayMs", nonNegativeInteger, reconnectPath);
    required(policy, "multiplier", positiveNumber, reconnectPath);
    if (typeof policy.initialDelayMs === "number" && typeof policy.maxDelayMs === "number" && policy.maxDelayMs < policy.initialDelayMs) {
      invalid(`${reconnectPath}.maxDelayMs`, "不能小于 initialDelayMs");
    }
  }, path);
}

function templateValue(value: unknown, path: string): void {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value === "number" && !Number.isFinite(value)) invalid(path, "必须是有限数字");
    return;
  }
  if (Array.isArray(value)) return array(value, path, templateValue);
  const record = object(value, path);
  for (const [key, item] of Object.entries(record)) templateValue(item, `${path}.${key}`);
}

function scalar(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  invalid(path, "必须是字符串、有限数字、布尔值或 null");
}

function object(value: unknown, path: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path, "必须是对象");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, "必须是普通对象");
  return value as JsonObject;
}

function array(value: unknown, path: string, validate: (item: unknown, itemPath: string) => void): void {
  if (!Array.isArray(value)) invalid(path, "必须是数组");
  value.forEach((item, index) => validate(item, `${path}[${index}]`));
}

function string(value: unknown, path: string): void {
  if (typeof value !== "string" || value.length === 0) invalid(path, "必须是非空字符串");
}

function boolean(value: unknown, path: string): void {
  if (typeof value !== "boolean") invalid(path, "必须是布尔值");
}

function positiveInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 1) invalid(path, "必须是正整数");
}

function nonNegativeInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) < 0) invalid(path, "必须是非负整数");
}

function positiveNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(path, "必须是正数");
}

function required(object: JsonObject, key: string, validate: (value: unknown, path: string) => void, path: string): void {
  if (!has(object, key)) invalid(`${path}.${key}`, "不能为空");
  validate(object[key], `${path}.${key}`);
}

function optional(object: JsonObject, key: string, validate: (value: unknown, path: string) => void, path: string): void {
  if (has(object, key)) validate(object[key], `${path}.${key}`);
}

function requiredLiteral(object: JsonObject, key: string, values: readonly unknown[], path: string): void {
  required(object, key, (value, valuePath) => literal(value, values, valuePath), path);
}

function optionalLiteral(object: JsonObject, key: string, values: readonly unknown[], path: string): void {
  optional(object, key, (value, valuePath) => literal(value, values, valuePath), path);
}

function literal(value: unknown, values: readonly unknown[], path: string): void {
  if (!values.includes(value)) invalid(path, `必须是 ${values.join("、")} 之一`);
}

function has(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function invalid(path: string, reason: string): never {
  throw new Error(`${path} ${reason}`);
}
