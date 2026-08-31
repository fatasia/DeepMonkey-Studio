import { describe, expect, it } from "vitest";
import { evaluateParametricValue } from "./expression.js";
import { cloneParametricDefinition, PARAMETRIC_CAD_TEMPLATES } from "./templates.js";
import { validateParametricCadDefinition } from "./validation.js";

describe("parametric expression", () => {
  it("evaluates deterministic parameter arithmetic", () => {
    expect(evaluateParametricValue("width/2-offset", { width: 120, offset: 12 })).toBe(48);
  });

  it("rejects scripts, unknown names and division by zero", () => {
    expect(() => evaluateParametricValue("globalThis.alert(1)", {})).toThrow();
    expect(() => evaluateParametricValue("missing+1", {})).toThrow("参数不存在");
    expect(() => evaluateParametricValue("1/0", {})).toThrow("除以零");
  });
});

describe("parametric definition validation", () => {
  it.each(PARAMETRIC_CAD_TEMPLATES.map((template) => [template.id, template.definition] as const))("accepts template %s", (_id, definition) => {
    expect(validateParametricCadDefinition(definition)).toMatchObject({ valid: true });
  });

  it("rejects out-of-range parameters and invalid feature order", () => {
    const definition = cloneParametricDefinition(PARAMETRIC_CAD_TEMPLATES[0]!.definition);
    definition.parameters[0]!.value = 999;
    definition.features[1]!.operation = "base";
    const result = validateParametricCadDefinition(definition);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining(["$.parameters[0].value", "$.features[1].operation"]));
  });

  it("rejects semantic bindings to missing parameters", () => {
    const definition = cloneParametricDefinition(PARAMETRIC_CAD_TEMPLATES[2]!.definition);
    definition.semanticBindings = [{ parameterId: "missing", source: "asset", meaning: "invalid" }];
    expect(validateParametricCadDefinition(definition)).toMatchObject({ valid: false, issues: [{ path: "$.semanticBindings[0].parameterId" }] });
  });
});
