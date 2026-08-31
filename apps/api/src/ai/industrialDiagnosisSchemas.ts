import type { CapabilityJsonSchema } from "@bim-studio/plugin-runtime";

const nonEmptyString = {
  type: "string",
  minLength: 1,
} as const satisfies CapabilityJsonSchema;
const probability = {
  type: "number",
  minimum: 0,
  maximum: 1,
} as const satisfies CapabilityJsonSchema;

const contributorSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["feature", "value"],
  properties: { feature: nonEmptyString, value: { type: "number" } },
};

const assessmentSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "projectId",
    "deploymentId",
    "modelId",
    "modelVersion",
    "generatedAt",
    "decisionStatus",
    "riskLevel",
    "dataQuality",
    "driftScore",
    "sampleCount",
    "topContributors",
    "message",
    "evidenceFingerprint",
  ],
  properties: {
    id: nonEmptyString,
    projectId: nonEmptyString,
    deploymentId: nonEmptyString,
    modelId: nonEmptyString,
    modelVersion: nonEmptyString,
    generatedAt: nonEmptyString,
    decisionStatus: {
      type: "string",
      enum: ["insufficient-data", "drift-blocked", "shadow", "validated"],
    },
    score: probability,
    riskLevel: {
      type: "string",
      enum: ["unknown", "normal", "warning", "critical"],
    },
    dataQuality: probability,
    driftScore: { type: "number", minimum: 0 },
    sampleCount: { type: "integer", minimum: 0 },
    topContributors: { type: "array", maxItems: 64, items: contributorSchema },
    message: { type: "string" },
    evidenceFingerprint: nonEmptyString,
  },
};

const modelSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "version", "algorithm", "modelKind", "benchmarkOnly", "productionEligible"],
  properties: {
    id: nonEmptyString,
    name: nonEmptyString,
    version: nonEmptyString,
    algorithm: nonEmptyString,
    modelKind: nonEmptyString,
    benchmarkOnly: { type: "boolean" },
    productionEligible: { type: "boolean" },
  },
};

const assetSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "objectIds"],
  properties: {
    id: nonEmptyString,
    name: nonEmptyString,
    sceneId: nonEmptyString,
    objectIds: { type: "array", maxItems: 256, items: nonEmptyString },
  },
};

const hypothesisSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "rank", "title", "rationale", "evidence", "status"],
  properties: {
    id: nonEmptyString,
    rank: { type: "integer", minimum: 1 },
    title: nonEmptyString,
    rationale: nonEmptyString,
    evidence: { type: "array", items: nonEmptyString },
    status: { type: "string", enum: ["candidate"] },
  },
};

const actionSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "priority", "label", "reason"],
  properties: {
    id: nonEmptyString,
    kind: {
      type: "string",
      enum: ["inspect", "validate-data", "simulate", "create-case", "monitor"],
    },
    priority: { type: "string", enum: ["now", "next", "observe"] },
    label: nonEmptyString,
    reason: nonEmptyString,
  },
};

const validationDraftSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["sourceAssessmentId", "objective", "signals", "acceptanceCriteria"],
  properties: {
    sourceAssessmentId: nonEmptyString,
    objective: nonEmptyString,
    signals: { type: "array", minItems: 1, items: nonEmptyString },
    acceptanceCriteria: { type: "array", minItems: 1, items: nonEmptyString },
    sceneId: nonEmptyString,
    objectId: nonEmptyString,
  },
};

const semanticNodeSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "label"],
  properties: {
    id: nonEmptyString,
    kind: {
      type: "string",
      enum: ["asset", "signal", "model", "assessment", "evidence"],
    },
    label: nonEmptyString,
  },
};

const semanticEdgeSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["from", "to", "relation"],
  properties: {
    from: nonEmptyString,
    to: nonEmptyString,
    relation: {
      type: "string",
      enum: ["observes", "assessed-by", "derived-from", "located-in"],
    },
  },
};

export const industrialDiagnosisInputSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["assessment", "model"],
  properties: {
    assessment: assessmentSchema,
    model: modelSchema,
    asset: assetSchema,
  },
};

export const industrialDiagnosisOutputSchema: CapabilityJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "generatedBy",
    "reasoningMode",
    "severity",
    "decisionStatus",
    "confidence",
    "headline",
    "summary",
    "facts",
    "hypotheses",
    "actions",
    "validationDraft",
    "semanticGraph",
    "limitations",
    "evidenceFingerprint",
  ],
  properties: {
    generatedBy: { type: "string", enum: ["industrial-diagnosis-plugin"] },
    reasoningMode: { type: "string", enum: ["evidence-orchestration"] },
    severity: {
      type: "string",
      enum: ["unknown", "normal", "warning", "critical"],
    },
    decisionStatus: {
      type: "string",
      enum: ["insufficient-data", "drift-blocked", "shadow", "validated"],
    },
    confidence: probability,
    headline: nonEmptyString,
    summary: nonEmptyString,
    facts: { type: "array", items: nonEmptyString },
    hypotheses: { type: "array", items: hypothesisSchema },
    actions: { type: "array", items: actionSchema },
    validationDraft: validationDraftSchema,
    semanticGraph: {
      type: "object",
      additionalProperties: false,
      required: ["nodes", "edges"],
      properties: {
        nodes: { type: "array", items: semanticNodeSchema },
        edges: { type: "array", items: semanticEdgeSchema },
      },
    },
    limitations: { type: "array", items: nonEmptyString },
    evidenceFingerprint: nonEmptyString,
  },
};
