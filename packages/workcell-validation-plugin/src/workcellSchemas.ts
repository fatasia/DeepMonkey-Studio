import type { CapabilityJsonSchema } from "@bim-studio/plugin-runtime";

const vectorSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
  required: ["x", "y", "z"],
};

const evidenceSourceSchema: CapabilityJsonSchema = {
  type: "string",
  enum: ["configured-prefab", "author-confirmed", "imported"],
};

const robotLoadCapabilitySchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    ratedPayloadKg: { type: "number", minimum: 0.000001, maximum: 1_000_000 },
    maximumLoadCenterDistanceMeters: { type: "number", minimum: 0.000001, maximum: 100 },
    source: evidenceSourceSchema,
    reference: { type: "string", minLength: 1 },
  },
};

const robotToolLoadSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    tcpPositionMeters: vectorSchema,
    tcpOrientationEulerDeg: vectorSchema,
    toolMassKg: { type: "number", minimum: 0, maximum: 1_000_000 },
    carriedPayloadKg: { type: "number", minimum: 0, maximum: 1_000_000 },
    combinedCenterOfMassMeters: vectorSchema,
    source: evidenceSourceSchema,
    reference: { type: "string", minLength: 1 },
  },
};

const ergonomicsProfileSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    operatorObjectId: { type: "string", minLength: 1 },
    anthropometry: {
      type: "object",
      additionalProperties: false,
      properties: {
        method: { type: "string", enum: ["percentile", "explicit"] },
        percentile: { type: "number", minimum: 1, maximum: 99 },
        statureMeters: { type: "number", minimum: 0.1, maximum: 3 },
        shoulderHeightMeters: { type: "number", minimum: 0.1, maximum: 3 },
        elbowHeightMeters: { type: "number", minimum: 0.1, maximum: 3 },
        functionalReachMeters: { type: "number", minimum: 0.01, maximum: 3 },
        source: { type: "string", enum: ["author-confirmed", "imported", "reference-table"] },
        reference: { type: "string", minLength: 1 },
      },
    },
    task: {
      type: "object",
      additionalProperties: false,
      properties: {
        workPointObjectId: { type: "string", minLength: 1 },
        workPoint: vectorSchema,
        loadMassKg: { type: "number", minimum: 0, maximum: 1_000 },
        repetitionsPerHour: { type: "number", minimum: 0, maximum: 10_000 },
        durationMinutes: { type: "number", minimum: 0.001, maximum: 10_080 },
        source: { type: "string", enum: ["author-confirmed", "imported", "scene-geometry"] },
        reference: { type: "string", minLength: 1 },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      properties: {
        maximumLoadKg: { type: "number", minimum: 0.001, maximum: 1_000 },
        maximumRepetitionsPerHour: { type: "number", minimum: 0.001, maximum: 10_000 },
        maximumDurationMinutes: { type: "number", minimum: 0.001, maximum: 10_080 },
        neutralHeightToleranceMeters: { type: "number", minimum: 0.001, maximum: 3 },
        warningUtilizationRatio: { type: "number", minimum: 0.01, maximum: 1 },
        source: { type: "string", enum: ["author-confirmed", "imported", "reference-table"] },
        reference: { type: "string", minLength: 1 },
      },
    },
  },
  required: ["id", "name"],
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
    planningAssumptions: {
      type: "object",
      additionalProperties: false,
      properties: {
        origin: { type: "string", enum: ["starter-values", "authored", "imported"] },
        status: { type: "string", enum: ["unconfirmed", "engineer-confirmed"] },
        generatedTrajectorySpeedMps: { type: "number", minimum: 0.000001, maximum: 1_000 },
        generatedTrajectoryTcpRadiusMeters: { type: "number", minimum: 0.000001, maximum: 100 },
        reference: { type: "string", minLength: 1 },
      },
      required: ["origin", "status"],
    },
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
              loadCapability: robotLoadCapabilitySchema,
              toolLoad: robotToolLoadSchema,
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
    ergonomicsProfiles: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: ergonomicsProfileSchema,
    },
  },
  required: ["sceneId", "objects"],
};

export const workcellAuditOutputSchema = openOutput;
