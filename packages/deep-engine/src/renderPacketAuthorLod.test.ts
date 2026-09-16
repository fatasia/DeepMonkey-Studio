import { describe, expect, it } from "vitest";
import { prepareLodProfile } from "./renderPacketLod.js";
import type { RenderInstance, RenderLodProfile } from "./renderPacketTypes.js";
const material = { id: "m", baseColor: [1,1,1] as const, metallic: 0, roughness: 1 };
const geometries = new Map([ ["a", { uv0: false, uv1: false, tangents: false, triangles: 2 }], ["b", { uv0: false, uv1: false, tangents: false, triangles: 2 }] ]);
const profile = () => ({ strategy: "author-selected" as const, revision: 2, levels: [{ geometry: "a", distance: 0, hysteresis: 0 }, { geometry: "b", distance: 10, hysteresis: 0.8 }], selectedLevels: [1] });
const prepare = (lod: unknown) => prepareLodProfile({ id: "i", geometry: "a", lod: lod as RenderLodProfile } as RenderInstance, geometries, material, undefined);
describe("author LOD packet validation", () => {
  it.each(["levels", "selectedLevels"] as const)("rejects sparse and inherited %s elements", field => {
    const input = profile();
    const values = [...input[field]];
    const index = field === "levels" ? 1 : 0;
    delete values[index];
    expect(() => prepare({ ...input, [field]: values })).toThrow(/dense/);
    const prototype = Object.create(Array.prototype);
    prototype[index] = input[field][index];
    Object.setPrototypeOf(values, prototype);
    expect(() => prepare({ ...input, [field]: values })).toThrow(/dense/);
  });
  it("rejects sparse or inherited legacy screen-space levels", () => {
    const levels = [{ geometry: "a", geometricError: 0, minProjectedDiameterPixels: 10 }, , ];
    expect(() => prepare({ levels })).toThrow(/dense/);
    const prototype = Object.create(Array.prototype);
    prototype[1] = { geometry: "b", geometricError: 1, minProjectedDiameterPixels: 0 };
    Object.setPrototypeOf(levels, prototype);
    expect(() => prepare({ levels })).toThrow(/dense/);
  });
  it("copies metadata and selection without imposing screen-space triangle/error constraints", () => {
    const input = profile(), output = prepare(input)!; input.selectedLevels[0] = 0; input.levels[1]!.distance = 20;
    expect(output).toMatchObject({ strategy: "author-selected", selectedLevels: [1], levels: [{ resident: true }, { distance: 10, triangles: 2 }] });
  });
  it.each([ { strategy: "fake" }, { revision: NaN }, { revision: -1 }, { selectedLevels: [1,1] }, { selectedLevels: [2] }, { selectedLevels: [1,0] }, { nonsense: true } ])("rejects invalid author profile %j", patch => {
    expect(() => prepare({ ...profile(), ...patch })).toThrow();
  });
  it("accepts zero selections and rejects missing level geometry", () => {
    expect(prepare({ ...profile(), selectedLevels: [] })).toMatchObject({ selectedLevels: [] });
    const input = profile(); input.levels[1]!.geometry = "missing"; expect(() => prepare(input)).toThrow();
  });
});
