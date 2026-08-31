import type { CapabilityJsonSchema } from "@bim-studio/plugin-runtime";

const signalValue: CapabilityJsonSchema = {
  description: "控制信号值，可为字符串、数字或布尔值。"
};

const timedItemProperties: Record<string, CapabilityJsonSchema> = {
  atMs: { type: "integer", minimum: 0 }
};

export const virtualDebugInputSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    durationMs: { type: "integer", minimum: 1, maximum: 86_400_000 },
    tickMs: { type: "integer", minimum: 1, maximum: 10_000 },
    initialSignals: { type: "object", additionalProperties: true },
    commands: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...timedItemProperties,
          type: { type: "string", enum: ["start", "stop", "reset", "set"] },
          key: { type: "string", minLength: 1 },
          value: signalValue
        },
        required: ["atMs", "type"]
      }
    },
    faults: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          ...timedItemProperties,
          code: { type: "string", minLength: 1 },
          signal: { type: "string", minLength: 1 },
          value: signalValue
        },
        required: ["atMs", "code"]
      }
    },
    assertions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          atMs: { type: "integer", minimum: 0 },
          expression: { type: "string", enum: ["running-implies-motor", "fault-implies-alarm", "signal-equals"] },
          signal: { type: "string", minLength: 1 },
          value: signalValue
        },
        required: ["id", "expression"]
      }
    },
    bindings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          signal: { type: "string", minLength: 1 },
          label: { type: "string" },
          presentation: { type: "string", enum: ["running", "alarm", "value"] },
          target: {
            type: "object",
            additionalProperties: false,
            properties: {
              sceneId: { type: "string", minLength: 1 },
              objectId: { type: "string", minLength: 1 },
              objectKind: { type: "string", enum: ["model", "primitive"] }
            },
            required: ["sceneId", "objectId", "objectKind"]
          }
        },
        required: ["id", "signal", "presentation", "target"]
      }
    }
  },
  required: ["id", "durationMs"]
};

export const virtualDebugOutputSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { type: "string", enum: ["passed", "failed"] },
    scenarioId: { type: "string" },
    evidenceFingerprint: { type: "string", minLength: 1 }
  },
  required: ["status", "scenarioId", "evidenceFingerprint"]
};

export const virtualDebugSuiteInputSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    label: { type: "string", minLength: 1 },
    cases: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          expectedStatus: { type: "string", enum: ["passed", "failed"] },
          scenario: virtualDebugInputSchema,
        },
        required: ["id", "label", "expectedStatus", "scenario"],
      },
    },
  },
  required: ["id", "label", "cases"],
};

export const virtualDebugSuiteOutputSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    status: { type: "string", enum: ["passed", "failed"] },
    suiteId: { type: "string", minLength: 1 },
    totalCases: { type: "integer", minimum: 1 },
    matchedCases: { type: "integer", minimum: 0 },
    evidenceFingerprint: { type: "string", minLength: 1 },
  },
  required: ["status", "suiteId", "totalCases", "matchedCases", "evidenceFingerprint"],
};
