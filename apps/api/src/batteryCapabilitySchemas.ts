import type { CapabilityJsonSchema } from "@bim-studio/plugin-runtime";

const chemistrySchema: CapabilityJsonSchema = { type: "string", enum: ["lfp", "ncm", "na-ion"] };
const socSchema: CapabilityJsonSchema = { type: "number", minimum: 0, maximum: 1 };
const sohSchema: CapabilityJsonSchema = { type: "number", minimum: 0.5, maximum: 1.05 };
const capacitySchema: CapabilityJsonSchema = { type: "number", minimum: 0.000001, maximum: 2000 };
const openOutput: CapabilityJsonSchema = {
  type: "object",
  description: "电池模型服务的结构化输出，字段随能力版本演进。",
  additionalProperties: true
};
const emptyInput: CapabilityJsonSchema = { type: "object", additionalProperties: false };

export const BATTERY_CAPABILITY_SCHEMAS = {
  "battery.model.predict": schema({
    model: { type: "string", enum: ["bmsformer", "socformer", "batterymformer"] },
    variant: { type: "string", enum: ["standard", "physics"] },
    routingMode: { type: "string", enum: ["standard", "physics", "dynamic", "both"] },
    fileName: { type: "string", minLength: 1 },
    records: {
      type: "array",
      minItems: 1,
      items: { type: "object", additionalProperties: true }
    },
    nominalCapacityAh: capacitySchema,
    chemistry: chemistrySchema,
    targetCapacityRetention: { type: "number", minimum: 50, maximum: 100 }
  }, ["model", "fileName", "records"]),
  "battery.twin.status": { input: emptyInput, output: openOutput },
  "battery.twin.initialize": schema({
    chemistry: chemistrySchema,
    nominalCapacityAh: capacitySchema,
    soh: sohSchema,
    soc: socSchema,
    temperatureC: { type: "number", minimum: -30, maximum: 80 },
    transferContext: { type: "object", additionalProperties: true }
  }),
  "battery.twin.simulate": schema({
    twinId: { type: "string", minLength: 1 },
    scenarioName: { type: "string", minLength: 1 },
    resolutionMinutes: { type: "number", minimum: 0.25, maximum: 10 },
    segments: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          durationMinutes: { type: "number", minimum: 0.000001, maximum: 120 },
          currentCRate: { type: "number", minimum: -3, maximum: 3 },
          ambientTemperatureC: { type: "number", minimum: -30, maximum: 80 }
        },
        required: ["durationMinutes", "currentCRate"]
      }
    },
    executionMode: { type: "string", enum: ["both", "dynamic"] },
    commit: { type: "boolean" }
  }, ["twinId", "segments"]),
  "battery.twin.assimilate": schema({
    twinId: { type: "string", minLength: 1 },
    soc: socSchema,
    soh: sohSchema,
    temperatureC: { type: "number", minimum: -30, maximum: 80 }
  }, ["twinId"]),
  "battery.twin.evidence": schema({ twinId: { type: "string", minLength: 1 } }, ["twinId"]),
  "battery.release.status": { input: emptyInput, output: openOutput }
} as const satisfies Record<string, { input: CapabilityJsonSchema; output: CapabilityJsonSchema }>;

function schema(properties: Record<string, CapabilityJsonSchema>, required: string[] = []): { input: CapabilityJsonSchema; output: CapabilityJsonSchema } {
  return {
    input: { type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}) },
    output: openOutput
  };
}
