import type { PprBopVersionDraft } from "@bim-studio/contracts";
import { validateCapabilityValue, type CapabilityJsonSchema } from "@bim-studio/plugin-runtime";

const nonEmptyText: CapabilityJsonSchema = { type: "string", minLength: 1 };
const textList: CapabilityJsonSchema = { type: "array", items: nonEmptyText };

const conditionSchema = strictObject({
  expression: nonEmptyText,
  description: { type: "string" },
}, ["expression"]);

const externalReferenceSchema = strictObject({
  kind: { type: "string", enum: ["scene", "object", "script", "study"] },
  id: nonEmptyText,
}, ["kind", "id"]);

const visualReferenceSchema = strictObject({
  kind: { type: "string", enum: ["scene", "object"] },
  id: nonEmptyText,
}, ["kind", "id"]);

const componentSchema = strictObject({
  id: nonEmptyText,
  name: nonEmptyText,
  kind: { type: "string", enum: ["product", "part"] },
  parentComponentId: nonEmptyText,
  variantIds: textList,
  condition: conditionSchema,
  references: { type: "array", items: externalReferenceSchema },
}, ["id", "name", "kind"]);

const operationComponentReferenceSchema = strictObject({
  componentId: nonEmptyText,
  role: { type: "string", enum: ["input", "output", "in-process"] },
  quantity: { type: "number" },
}, ["componentId", "role"]);

const workInstructionStepSchema = strictObject({
  id: nonEmptyText,
  instruction: nonEmptyText,
}, ["id", "instruction"]);

const workInstructionSafetyNoteSchema = strictObject({
  id: nonEmptyText,
  note: nonEmptyText,
}, ["id", "note"]);

const qualitySamplingFrequencySchema = strictObject({
  mode: { type: "string", enum: ["every-item", "first-off", "every-n-items", "per-batch", "once-per-shift"] },
  interval: { type: "integer", minimum: 1 },
}, ["mode"]);

const workInstructionQualityCheckSchema = strictObject({
  id: nonEmptyText,
  checkpoint: nonEmptyText,
  acceptanceCriteria: nonEmptyText,
  specificationKind: { type: "string", enum: ["limits", "tolerance"] },
  targetValue: { type: "number" },
  lowerLimit: { type: "number" },
  upperLimit: { type: "number" },
  tolerance: { type: "number" },
  unit: nonEmptyText,
  inspectionMethod: nonEmptyText,
  samplingFrequency: qualitySamplingFrequencySchema,
  outOfControlReaction: nonEmptyText,
}, ["id", "checkpoint"]);

const workInstructionSchema = strictObject({
  steps: { type: "array", minItems: 1, items: workInstructionStepSchema },
  safetyNotes: { type: "array", items: workInstructionSafetyNoteSchema },
  qualityChecks: { type: "array", items: workInstructionQualityCheckSchema },
  visualReferences: { type: "array", items: visualReferenceSchema },
}, ["steps", "safetyNotes", "qualityChecks"]);

const operationSchema = strictObject({
  id: nonEmptyText,
  name: nonEmptyText,
  standardTimeMinutes: { type: "number" },
  componentRefs: { type: "array", minItems: 1, items: operationComponentReferenceSchema },
  workInstruction: workInstructionSchema,
  variantIds: textList,
  condition: conditionSchema,
  references: { type: "array", items: externalReferenceSchema },
}, ["id", "name", "standardTimeMinutes", "componentRefs"]);

const precedenceRelationSchema = strictObject({
  id: nonEmptyText,
  predecessorOperationId: nonEmptyText,
  successorOperationId: nonEmptyText,
  minimumLagMinutes: { type: "number" },
  condition: conditionSchema,
}, ["id", "predecessorOperationId", "successorOperationId"]);

const resourceSchema = strictObject({
  id: nonEmptyText,
  name: nonEmptyText,
  kind: { type: "string", enum: ["station", "equipment", "robot", "tool", "person"] },
  capacity: { type: "number" },
  variantIds: textList,
  condition: conditionSchema,
  references: { type: "array", items: externalReferenceSchema },
}, ["id", "name", "kind"]);

const resourceAssignmentSchema = strictObject({
  id: nonEmptyText,
  operationId: nonEmptyText,
  resourceId: nonEmptyText,
  requiredCapacity: { type: "number" },
}, ["id", "operationId", "resourceId"]);

const pprBopVersionDraftSchema = strictObject({
  planId: nonEmptyText,
  version: { type: "string" },
  name: nonEmptyText,
  basedOnVersionId: nonEmptyText,
  targetTaktMinutes: { type: "number" },
  components: { type: "array", items: componentSchema },
  operations: { type: "array", items: operationSchema },
  precedenceRelations: { type: "array", items: precedenceRelationSchema },
  resources: { type: "array", items: resourceSchema },
  resourceAssignments: { type: "array", items: resourceAssignmentSchema },
  variantIds: textList,
  condition: conditionSchema,
  references: { type: "array", items: externalReferenceSchema },
}, ["planId", "name", "components", "operations", "precedenceRelations", "resources", "resourceAssignments"]);

/** Runtime boundary for the HTTP payload before the typed PPR engine is invoked. */
export function requirePprBopVersionDraft(value: unknown): PprBopVersionDraft {
  const issues = validateCapabilityValue(pprBopVersionDraftSchema, value);
  if (issues.length) {
    const shown = issues.slice(0, 8).join("；");
    const remainder = issues.length > 8 ? `；另有 ${issues.length - 8} 项结构错误` : "";
    throw new Error(`PPR/BOP 草稿结构无效：${shown}${remainder}`);
  }
  return value as PprBopVersionDraft;
}

function strictObject(properties: Record<string, CapabilityJsonSchema>, required: string[] = []): CapabilityJsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    ...(required.length ? { required } : {}),
  };
}
