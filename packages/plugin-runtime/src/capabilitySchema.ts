export interface CapabilityJsonSchema {
  $schema?: string;
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  title?: string;
  description?: string;
  properties?: Record<string, CapabilityJsonSchema>;
  required?: string[];
  additionalProperties?: boolean | CapabilityJsonSchema;
  items?: CapabilityJsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
}

/**
 * 运行时执行必要的 JSON Schema 子集，保证 UI、MCP 与 Provider 使用同一输入边界。
 * 复杂组合 schema 留给后续标准验证器；当前不允许“声明了 schema 但完全不校验”。
 */
export function validateCapabilityValue(schema: CapabilityJsonSchema, value: unknown, path = "$", issues: string[] = []): string[] {
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    issues.push(`${path} 必须是允许的枚举值`);
    return issues;
  }
  if (schema.type && !matchesType(schema.type, value)) {
    issues.push(`${path} 必须是 ${schema.type}`);
    return issues;
  }
  if (schema.type === "object" && isRecord(value)) validateObject(schema, value, path, issues);
  if (schema.type === "array" && Array.isArray(value)) validateArray(schema, value, path, issues);
  if (schema.type === "string" && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) issues.push(`${path} 长度不能小于 ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) issues.push(`${path} 长度不能大于 ${schema.maxLength}`);
  }
  if ((schema.type === "number" || schema.type === "integer") && typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) issues.push(`${path} 不能小于 ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) issues.push(`${path} 不能大于 ${schema.maximum}`);
  }
  return issues;
}

export function isCapabilitySchema(schema: unknown): schema is CapabilityJsonSchema {
  return isSchemaNode(schema) && schema.type === "object";
}

function isSchemaNode(value: unknown): value is CapabilityJsonSchema {
  if (!isRecord(value)) return false;
  if (value.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(value.type))) return false;
  if (value.required !== undefined && (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string") || new Set(value.required).size !== value.required.length)) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) return false;
  if (value.properties !== undefined && (!isRecord(value.properties) || Object.values(value.properties).some((schema) => !isSchemaNode(schema)))) return false;
  if (value.items !== undefined && !isSchemaNode(value.items)) return false;
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean" && !isSchemaNode(value.additionalProperties)) return false;
  const numericKeywords = ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const;
  if (numericKeywords.some((keyword) => value[keyword] !== undefined && (typeof value[keyword] !== "number" || !Number.isFinite(value[keyword])))) return false;
  if (!orderedBounds(value.minimum, value.maximum) || !orderedBounds(value.minLength, value.maxLength) || !orderedBounds(value.minItems, value.maxItems)) return false;
  return true;
}

function orderedBounds(minimum: unknown, maximum: unknown): boolean {
  return typeof minimum !== "number" || typeof maximum !== "number" || minimum <= maximum;
}

function validateObject(schema: CapabilityJsonSchema, value: Record<string, unknown>, path: string, issues: string[]): void {
  for (const field of schema.required ?? []) if (!(field in value)) issues.push(`${path}.${field} 为必填项`);
  const properties = schema.properties ?? {};
  for (const [key, item] of Object.entries(value)) {
    const child = properties[key];
    if (child) validateCapabilityValue(child, item, `${path}.${key}`, issues);
    else if (schema.additionalProperties === false) issues.push(`${path}.${key} 不是允许的字段`);
    else if (typeof schema.additionalProperties === "object") validateCapabilityValue(schema.additionalProperties, item, `${path}.${key}`, issues);
  }
}

function validateArray(schema: CapabilityJsonSchema, value: unknown[], path: string, issues: string[]): void {
  if (schema.minItems !== undefined && value.length < schema.minItems) issues.push(`${path} 至少包含 ${schema.minItems} 项`);
  if (schema.maxItems !== undefined && value.length > schema.maxItems) issues.push(`${path} 最多包含 ${schema.maxItems} 项`);
  if (schema.items) value.forEach((item, index) => validateCapabilityValue(schema.items!, item, `${path}[${index}]`, issues));
}

function matchesType(type: NonNullable<CapabilityJsonSchema["type"]>, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
