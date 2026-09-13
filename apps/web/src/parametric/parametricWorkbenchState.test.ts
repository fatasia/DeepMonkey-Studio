import { describe, expect, it } from "vitest";
import { PARAMETRIC_CAD_TEMPLATES } from "@bim-studio/parametric-modeling-plugin";
import { ParametricOperationGate, parametricGeometryKey } from "./parametricWorkbenchState";

describe("parametric result freshness", () => {
  it("preserves geometry for metadata edits and invalidates dimensions and features", () => {
    const definition = structuredClone(PARAMETRIC_CAD_TEMPLATES[0]!.definition);
    const original = parametricGeometryKey(definition);
    definition.name = "Renamed";
    definition.semanticBindings = [];
    expect(parametricGeometryKey(definition)).toBe(original);
    definition.parameters[0]!.value += 1;
    expect(parametricGeometryKey(definition)).not.toBe(original);
    definition.parameters[0]!.value -= 1;
    expect(parametricGeometryKey(definition)).toBe(original);
    definition.features.pop();
    expect(parametricGeometryKey(definition)).not.toBe(original);
  });
  it("rejects duplicate starts and ignores responses after cancellation or unmount", () => {
    const gate = new ParametricOperationGate();
    const first = gate.begin()!;
    expect(gate.begin()).toBeUndefined();
    gate.cancel();
    const second = gate.begin()!;
    expect(gate.current(first)).toBe(false);
    expect(gate.finish(first)).toBe(false);
    expect(gate.current(second)).toBe(true);
    expect(gate.finish(second)).toBe(true);
    expect(gate.begin()).toBeDefined();
  });
});
