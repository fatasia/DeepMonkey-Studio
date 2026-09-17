import { describe, expect, it } from "vitest";
import { createJtMaterialResolver } from "./jtMaterialResolution.js";
import type { JtMaterialEvidence } from "./jtInspection.js";

const material = (objectId: number, red = 0.5): JtMaterialEvidence => ({ objectId, diffuse: [red, 0.5, 0.5], opacity: 1, shininess: 15, reflectivity: 0 });
describe("JT source-path materials", () => {
  it("finds ancestor ownership independently of input ordering", () => {
    for (const inputs of [[material(9), material(2)], [material(2), material(9)]]) {
      expect(createJtMaterialResolver(inputs)({ pathObjectIds: [0, 2, 3] })).toMatchObject({ status: "source-path", sourceObjectIds: [2], evidence: { objectId: 2 } });
    }
  });
  it("does not borrow an unrelated material for an unassigned path", () => {
    expect(createJtMaterialResolver([material(9)])({ pathObjectIds: [0, 2, 3] })).toEqual({ status: "missing", sourceObjectIds: [], key: "unassigned" });
  });
  it("preserves ambiguous overrides until source override flags are supported", () => {
    expect(createJtMaterialResolver([material(0), material(2, 1)])({ pathObjectIds: [0, 2, 3] })).toEqual({ status: "ambiguous", sourceObjectIds: [0, 2], key: "unassigned" });
    expect(createJtMaterialResolver([material(0), material(2)])({ pathObjectIds: [0, 2, 3] })).toMatchObject({ status: "source-path", sourceObjectIds: [0, 2] });
  });
  it("rejects duplicate source definitions", () => {
    expect(() => createJtMaterialResolver([material(2), material(2)])).toThrow("材质源节点重复");
  });
});
