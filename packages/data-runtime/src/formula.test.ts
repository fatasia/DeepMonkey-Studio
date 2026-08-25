import { describe, expect, it } from "vitest";
import { compileFormula, evaluateFormula, FormulaError } from "./formula.js";

describe("formula runtime", () => {
  it("evaluates arithmetic, field paths, conditions, and fixed functions", () => {
    const formula = compileFormula('IF(device.running && temperature > 20, ROUND(temperature * 1.8 + 32, 1), 0)');
    expect(formula.dependencies).toEqual(["device.running", "temperature"]);
    expect(evaluateFormula(formula, { temperature: 23.25, device: { running: true } })).toBe(73.9);
    expect(evaluateFormula(formula, { temperature: 23.25, device: { running: false } })).toBe(0);
    expect(evaluateFormula(compileFormula('CONCAT(UPPER(code), "-", COALESCE(name, "UNKNOWN"))'), { code: "agv", name: null })).toBe("AGV-UNKNOWN");
  });

  it("reports exact syntax and runtime positions without evaluating JavaScript", () => {
    expect(() => compileFormula("temperature + )")).toThrow(FormulaError);
    expect(() => compileFormula("constructor.value")).toThrow("禁止访问");
    expect(() => evaluateFormula(compileFormula("pressure / divisor"), { pressure: 2, divisor: 0 })).toThrow("位置 12");
  });
});
