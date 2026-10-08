import { describe, expect, it } from "vitest";
import { packJointPalette, validateJointPalette } from "./gpuSkinningPacking.js";
import type { SkinningPalette } from "./gpuSkinningTypes.js";

const matrix = () => new Float32Array([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 5, 6, 7, 1]);
const palette = (): SkinningPalette => ({ revision: 1, matrices: matrix(),
  normalMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) });

describe("dynamic palette validation and GPU packing share the numeric contract", () => {
  it("validates authored normals and preserves their 28-float GPU layout", () => {
    const input = palette(), packed = packJointPalette(input);
    expect(validateJointPalette(input)).toBe(1);
    expect(Array.from(packed)).toEqual([...input.matrices, ...input.normalMatrices!]);
    input.matrices[12] = 20;
    expect(packed[12]).toBe(5);
    expect(validateJointPalette(input)).toBe(1);
    expect(packJointPalette(input)[12]).toBe(20);
  });

  it("validates derived inverse-transpose normals without requiring authored normals", () => {
    const input = { revision: 2, matrices: matrix() };
    expect(validateJointPalette(input)).toBe(1);
    const packed = packJointPalette(input);
    expect(packed[16]).toBeCloseTo(0.5);
    expect(packed[21]).toBeCloseTo(1 / 3);
    expect(packed[26]).toBeCloseTo(0.25);
  });

  it("rechecks same-reference mutations and rejects every malformed layout before upload", () => {
    const input = palette();
    expect(validateJointPalette(input)).toBe(1);
    input.matrices[0] = NaN;
    for (const check of [validateJointPalette, packJointPalette]) expect(() => check(input)).toThrow("non-finite");
    const badNormal = palette(); badNormal.normalMatrices![5] = Infinity;
    const singular = { revision: 1, matrices: new Float32Array(16) };
    const malformed: SkinningPalette[] = [badNormal, singular, { ...palette(), revision: -1 },
      { ...palette(), matrices: new Float32Array(15) }, { ...palette(), matrices: new Float32Array() },
      { ...palette(), normalMatrices: new Float32Array(11) },
      { ...palette(), matrices: new Float32Array(new SharedArrayBuffer(64)) }];
    for (const item of malformed) for (const check of [validateJointPalette, packJointPalette])
      expect(() => check(item)).toThrow();
  });
});
