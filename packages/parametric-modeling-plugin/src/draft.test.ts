import { describe, expect, it } from "vitest";
import { PARAMETRIC_CAD_TEMPLATES } from "./templates.js";
import { parseParametricDraft } from "./draft.js";

describe("parseParametricDraft", () => {
  it("accepts plain or fenced JSON and returns a validated clone", () => {
    const json = JSON.stringify(PARAMETRIC_CAD_TEMPLATES[0]!.definition);
    expect(parseParametricDraft(json).name).toBe("设备安装板");
    expect(parseParametricDraft(`\`\`\`json\n${json}\n\`\`\``).features).toHaveLength(5);
  });

  it("rejects prose, executable expressions and invalid feature order", () => {
    expect(() => parseParametricDraft("这是一个草案")).toThrow("有效 JSON");
    const executable = structuredClone(PARAMETRIC_CAD_TEMPLATES[0]!.definition);
    executable.features[0]!.size![0] = "globalThis.fetch('x')";
    expect(() => parseParametricDraft(JSON.stringify(executable))).toThrow("表达式");
    const invalidOrder = structuredClone(PARAMETRIC_CAD_TEMPLATES[0]!.definition);
    invalidOrder.features[0]!.operation = "cut";
    expect(() => parseParametricDraft(JSON.stringify(invalidOrder))).toThrow("base");
  });
});
