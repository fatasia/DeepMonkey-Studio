import type { CapabilityJsonSchema, CapabilityProvider } from "@bim-studio/plugin-runtime";
import { validateParametricCadDefinition } from "./validation.js";

interface ValidationInput { definition: unknown; }
interface ValidationOutput { valid: boolean; issues: Array<{ path: string; message: string }>; parameterCount: number; featureCount: number; }

const inputSchema: CapabilityJsonSchema = {
  type: "object", additionalProperties: false, required: ["definition"],
  properties: { definition: { type: "object", additionalProperties: true } }
};

const outputSchema: CapabilityJsonSchema = {
  type: "object", additionalProperties: false, required: ["valid", "issues", "parameterCount", "featureCount"],
  properties: {
    valid: { type: "boolean" },
    issues: { type: "array", items: { type: "object", additionalProperties: false, required: ["path", "message"], properties: { path: { type: "string" }, message: { type: "string" } } } },
    parameterCount: { type: "integer", minimum: 0 }, featureCount: { type: "integer", minimum: 0 }
  }
};

export function createParametricValidationProvider(): CapabilityProvider<ValidationInput, ValidationOutput> {
  return {
    descriptor: {
      id: "modeling.parametric.validate", version: "1.0.0", label: "参数化模型校验", kind: "model", execution: "worker",
      permissions: ["modeling.read"], timeoutMs: 5_000, inputSchemaVersion: "1.0", outputSchemaVersion: "1.0", inputSchema, outputSchema
    },
    async invoke(request) {
      const result = validateParametricCadDefinition(request.input.definition);
      const definition = request.input.definition as { parameters?: unknown[]; features?: unknown[] };
      const output = { valid: result.valid, issues: result.issues, parameterCount: definition.parameters?.length ?? 0, featureCount: definition.features?.length ?? 0 };
      return {
        status: result.valid ? "completed" : "needs-input", decisionStatus: result.valid ? "production" : "insufficient-data", output,
        evidence: [{ id: `parametric-schema-v1:${request.requestId}`, kind: "rule", label: "参数化模型 Schema 与表达式校验", source: "bim.parametric-modeling" }],
        ...(result.valid ? {} : { warnings: result.issues.slice(0, 10).map((issue) => `${issue.path}: ${issue.message}`) })
      };
    }
  };
}
