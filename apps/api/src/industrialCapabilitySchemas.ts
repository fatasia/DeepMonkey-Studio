import type { CapabilityJsonSchema } from "@bim-studio/plugin-runtime";

const numericRowSchema: CapabilityJsonSchema = {
  type: "object",
  description: "一行数值特征；字段名由已部署模型或数据集定义。",
  additionalProperties: { type: "number" }
};

const openObjectOutput: CapabilityJsonSchema = {
  type: "object",
  description: "领域服务返回的结构化结果；具体字段由能力版本管理。",
  additionalProperties: true
};

export const INDUSTRIAL_CAPABILITY_SCHEMAS = {
  maintenanceAssess: {
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        deploymentId: { type: "string", minLength: 1, description: "维护模型部署标识。" },
        rows: { type: "array", minItems: 1, items: numericRowSchema, description: "待评估的数值特征行。" }
      },
      required: ["deploymentId", "rows"]
    },
    output: openObjectOutput
  },
  maintenanceShadowEvaluate: {
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        modelId: { type: "string", minLength: 1, description: "待影子评测的模型标识。" },
        labelColumn: { type: "string", minLength: 1, description: "固定评测集的真实标签列。" },
        rows: { type: "array", minItems: 1, items: numericRowSchema },
        threshold: { type: "number", minimum: 0, maximum: 1 },
        timeColumn: { type: "string", minLength: 1 }
      },
      required: ["modelId", "labelColumn", "rows"]
    },
    output: openObjectOutput
  },
  energyAnalyze: {
    input: {
      type: "object",
      additionalProperties: false,
      properties: {
        observations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              timestamp: { type: "string", minLength: 1 },
              output: { type: "number" },
              energyKwh: { type: "number", minimum: 0 }
            },
            required: ["timestamp", "output", "energyKwh"]
          }
        }
      },
      required: ["observations"]
    },
    output: openObjectOutput
  }
} as const satisfies Record<string, { input: CapabilityJsonSchema; output: CapabilityJsonSchema }>;
