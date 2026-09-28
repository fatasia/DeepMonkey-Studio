import { describe, expect, it } from "vitest";
import { buildSdfGrid, sampleSdfGrid, type SdfMesh } from "./sdfGrid.js";

function concavePrism(): SdfMesh {
  const perimeter = [[0, 0], [3, 0], [3, 1], [1, 1], [1, 3], [0, 3]];
  const positions = new Float32Array(perimeter.flatMap(([x, y]) => [x, y, 0, x, y, 1]));
  const indices: number[] = [];
  for (let i = 0; i < perimeter.length; i++) {
    const next = (i + 1) % perimeter.length;
    indices.push(i * 2, next * 2, i * 2 + 1, next * 2, next * 2 + 1, i * 2 + 1);
  }
  // L-shaped cap = two non-overlapping rectangles.
  for (const [a, b, c, d] of [[0, 3, 4, 5], [0, 1, 2, 3]]) {
    indices.push(a * 2, b * 2, c * 2, a * 2, c * 2, d * 2);
    indices.push(c * 2 + 1, b * 2 + 1, a * 2 + 1, d * 2 + 1, c * 2 + 1, a * 2 + 1);
  }
  return { positions, indices: Uint32Array.from(indices) };
}

describe("bounded SDF collision reference", () => {
  it("distinguishes a concave cavity from the convex hull's occupied region", () => {
    const mesh = concavePrism();
    const grid = buildSdfGrid(mesh, [-0.125, -0.125, -0.125], [16, 16, 8], 0.25);
    expect(sampleSdfGrid(grid, [0.375, 0.375, 0.375])).toBeLessThan(-0.15);
    expect(sampleSdfGrid(grid, [2.375, 2.375, 0.375])).toBeGreaterThan(0.3);
    expect(grid.maxSamplingError).toBeCloseTo(Math.sqrt(3) / 8);
    expect(grid.distances.byteLength).toBe(16 * 16 * 8 * 4);
    expect(buildSdfGrid(mesh, grid.origin, grid.dimensions, grid.cellSize).distances).toEqual(grid.distances);
  });
  it("rejects invalid input and outside-domain samples instead of silently returning no collision", () => {
    const mesh = concavePrism();
    expect(() => buildSdfGrid(mesh, [0, 0, 0], [1024, 1024, 1024], 0.25)).toThrow(/预算/);
    expect(() => buildSdfGrid({ ...mesh, indices: Uint32Array.of(999, 1, 2) }, [0, 0, 0], [4, 4, 4], 0.25)).toThrow(/索引/);
    const grid = buildSdfGrid(mesh, [-0.125, -0.125, -0.125], [16, 16, 8], 0.25);
    expect(() => sampleSdfGrid(grid, [10, 10, 10])).toThrow(/超出/);
  });
});
