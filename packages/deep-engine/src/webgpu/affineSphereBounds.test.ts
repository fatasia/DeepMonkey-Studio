import { describe, expect, it } from "vitest";
import { conservativeAffineScale } from "./affineSphereBounds.js";
import { packGpuLodScene } from "./gpuLodPacking.js";

function rows(matrix: readonly number[]): Float32Array {
  return new Float32Array([matrix[0]!, matrix[1]!, matrix[2]!, 0,
    matrix[3]!, matrix[4]!, matrix[5]!, 0, matrix[6]!, matrix[7]!, matrix[8]!, 0]);
}

function stretch(matrix: Float32Array, x: number, y: number, z: number): number {
  return Math.hypot(matrix[0]! * x + matrix[1]! * y + matrix[2]! * z,
    matrix[4]! * x + matrix[5]! * y + matrix[6]! * z,
    matrix[8]! * x + matrix[9]! * y + matrix[10]! * z);
}

describe("conservative affine LOD sphere", () => {
  it.each([0, 0.1, Math.PI / 4, Math.PI / 3, Math.PI, -0.7])("keeps rotation %s at unit scale", angle => {
    const c = Math.cos(angle), s = Math.sin(angle), matrix = rows([c, -s, 0, s, c, 0, 0, 0, 1]);
    expect(conservativeAffineScale(matrix, 0)).toBeCloseTo(1, 6);
  });

  it.each([1, -1])("bounds the analytic strongest shear direction with handedness %s", sign => {
    const matrix = rows([sign, 1, 0, 0, 1, 0, 0, 0, 1]);
    const bound = conservativeAffineScale(matrix, 0), phi = (1 + Math.sqrt(5)) / 2;
    const length = Math.hypot(1, phi);
    expect(stretch(matrix, sign / length, phi / length, 0)).toBeCloseTo(phi, 12);
    expect(bound).toBeGreaterThanOrEqual(phi);
    expect(bound).toBeCloseTo(Math.sqrt(3), 12);
    expect(bound).toBeLessThan(2); // Previous row/column product bound.
  });

  it("retains rotated nonuniform scale and ignores translation and adjacent instances", () => {
    const r = Math.SQRT1_2, matrix = rows([3 * r, -r, 0, 3 * r, r, 0, 0, 0, -2]);
    const data = new Float32Array(72); data.fill(1e8); data.set(matrix, 36);
    data[39] = 1e12; data[43] = -1e12; data[47] = 1e12;
    const bound = conservativeAffineScale(data, 36);
    expect(bound).toBeCloseTo(3, 6);
    expect(bound).toBeGreaterThanOrEqual(stretch(matrix, 1, 0, 0));
  });

  it("bounds sampled directions for deterministic arbitrary shear, reflection and singular bases", () => {
    let seed = 317;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
    for (let trial = 0; trial < 96; trial++) {
      const matrix = rows(Array.from({ length: 9 }, () => (random() - 0.5) * 32));
      if (trial % 7 === 0) matrix.fill(0, 8, 11);
      const bound = conservativeAffineScale(matrix, 0);
      for (let index = 0; index < 256; index++) {
        const z = 1 - 2 * (index + 0.5) / 256, radius = Math.sqrt(1 - z * z);
        const angle = index * Math.PI * (3 - Math.sqrt(5));
        expect(stretch(matrix, radius * Math.cos(angle), radius * Math.sin(angle), z)).toBeLessThanOrEqual(bound);
      }
    }
    expect(conservativeAffineScale(new Float32Array(12), 0)).toBe(0);
  });

  it("rounds tiny positive GPU radii outwards instead of erasing their bounds", () => {
    const packed = packGpuLodScene([{ sphere: [0, 0, 0, 1e-50], instanceIndex: 0,
      levels: [{ minProjectedDiameterPixels: 0, geometricError: 0, triangles: 1, meshletOffset: 0, meshletCount: 1 }] }]);
    const radius = new Float32Array(packed.objectData)[3]!;
    expect(radius).toBeGreaterThanOrEqual(1e-50);
    expect(radius).toBe(2 ** -149);
  });
});
