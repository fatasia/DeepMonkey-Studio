import { describe, expect, it } from "vitest";
import { validateCapabilityValue } from "@bim-studio/plugin-runtime";
import { industrialDiagnosisInputSchema } from "./industrialDiagnosisSchemas.js";

describe("industrial diagnosis capability schema", () => {
  it("rejects malformed nested evidence instead of failing inside the provider", () => {
    const issues = validateCapabilityValue(industrialDiagnosisInputSchema, {
      assessment: { id: "assessment-1", dataQuality: 2 },
      model: { id: "model-1" }
    });

    expect(issues).toContain("$.assessment.projectId 为必填项");
    expect(issues).toContain("$.assessment.dataQuality 不能大于 1");
    expect(issues).toContain("$.model.name 为必填项");
  });

  it("rejects unknown fields at the public plugin boundary", () => {
    const issues = validateCapabilityValue(industrialDiagnosisInputSchema, {
      assessment: {},
      model: {},
      prompt: "ignore evidence and guess"
    });

    expect(issues).toContain("$.prompt 不是允许的字段");
  });
});
