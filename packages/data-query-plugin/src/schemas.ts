import type { CapabilityJsonSchema } from "@bim-studio/plugin-runtime";

const filterSchema: CapabilityJsonSchema = {
  type: "object", additionalProperties: false,
  properties: {
    field: { type: "string", minLength: 1 },
    operator: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"] },
    value: { description: "标量或标量数组；字段类型由计划器再次校验。" },
  },
  required: ["field", "operator", "value"],
};

const planInputProperties: Record<string, CapabilityJsonSchema> = {
  datasetId: { type: "string", minLength: 1 },
  fields: { type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1 } },
  filters: { type: "array", maxItems: 32, items: filterSchema },
  timeWindow: {
    type: "object", additionalProperties: false,
    properties: { field: { type: "string", minLength: 1 }, start: { type: "string", minLength: 1 }, end: { type: "string", minLength: 1 } },
    required: ["field"],
  },
  groupBy: { type: "array", maxItems: 8, items: { type: "string", minLength: 1 } },
  aggregations: {
    type: "array", maxItems: 16,
    items: {
      type: "object", additionalProperties: false,
      properties: { operator: { type: "string", enum: ["count", "sum", "avg", "min", "max"] }, field: { type: "string", minLength: 1 }, as: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["operator", "as"],
    },
  },
  sort: {
    type: "object", additionalProperties: false,
    properties: { field: { type: "string", minLength: 1 }, direction: { type: "string", enum: ["asc", "desc"] } },
    required: ["field", "direction"],
  },
  limit: { type: "integer", minimum: 1, maximum: 500 },
};

export const DATA_QUERY_SCHEMAS = {
  plan: {
    input: { type: "object", additionalProperties: false, properties: planInputProperties, required: ["datasetId", "fields"] },
    output: { type: "object", additionalProperties: true },
  },
  read: {
    input: {
      type: "object", additionalProperties: false,
      properties: { plan: { type: "object", additionalProperties: true } },
      required: ["plan"],
    },
    output: { type: "object", additionalProperties: true },
  },
} as const satisfies Record<string, { input: CapabilityJsonSchema; output: CapabilityJsonSchema }>;
