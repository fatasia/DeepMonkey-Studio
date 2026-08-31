import type { CapabilityJsonSchema } from "@bim-studio/plugin-runtime";

const vectorSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
  required: ["x", "y", "z"],
};

const openOutput: CapabilityJsonSchema = {
  type: "object",
  description: "确定性工位体检结果；字段由能力版本和共享合同共同管理。",
  additionalProperties: true,
};

export const workcellAuditInputSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sceneId: { type: "string", minLength: 1 },
    clearanceThreshold: { type: "number", minimum: 0, maximum: 100 },
    objects: {
      type: "array",
      minItems: 1,
      maxItems: 200,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          role: { type: "string", enum: ["robot", "tool", "target", "equipment", "obstacle", "unknown"] },
          position: vectorSchema,
          bounds: {
            type: "object",
            additionalProperties: false,
            properties: { min: vectorSchema, max: vectorSchema },
            required: ["min", "max"],
          },
          robot: {
            type: "object",
            additionalProperties: false,
            properties: {
              base: vectorSchema,
              toolObjectId: { type: "string", minLength: 1 },
              targetObjectIds: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
              links: {
                type: "array",
                minItems: 1,
                maxItems: 16,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    id: { type: "string", minLength: 1 },
                    name: { type: "string", minLength: 1 },
                    length: { type: "number", minimum: 0.001 },
                    minAngleDeg: { type: "number", minimum: -360, maximum: 360 },
                    maxAngleDeg: { type: "number", minimum: -360, maximum: 360 },
                    maxSpeedDegPerSec: { type: "number", minimum: 0.000001 },
                  },
                  required: ["id", "name", "length", "minAngleDeg", "maxAngleDeg"],
                },
              },
            },
            required: ["base", "links"],
          },
        },
        required: ["id", "name", "role", "position"],
      },
    },
    trajectories: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          robotId: { type: "string", minLength: 1 },
          tcpRadius: { type: "number", minimum: 0.000001 },
          precision: {
            type: "object",
            additionalProperties: false,
            properties: {
              source: { type: "string", enum: ["scene-transform", "author-confirmed", "imported"] },
              positionToleranceMeters: { type: "number", minimum: 0 },
              timeToleranceSeconds: { type: "number", minimum: 0 },
              jointToleranceDeg: { type: "number", minimum: 0 },
            },
            required: ["source"],
          },
          waypoints: {
            type: "array",
            minItems: 2,
            maxItems: 100,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "string", minLength: 1 },
                timeSec: { type: "number", minimum: 0 },
                position: vectorSchema,
                jointAnglesDeg: { type: "array", maxItems: 16, items: { type: "number" } },
              },
              required: ["id", "timeSec", "position"],
            },
          },
        },
        required: ["id", "name", "robotId", "waypoints"],
      },
    },
  },
  required: ["sceneId", "objects"],
};

export const workcellAuditOutputSchema = openOutput;
