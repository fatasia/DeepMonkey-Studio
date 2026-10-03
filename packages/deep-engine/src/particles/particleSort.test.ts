import { describe, expect, it } from "vitest";
import { createParticleSortScratch, sortParticlesBackToFront } from "./particleSort.js";

function distance(positions: Float32Array, index: number, eye: readonly [number, number, number]): number {
  return Math.hypot(positions[index * 3]! - eye[0], positions[index * 3 + 1]! - eye[1], positions[index * 3 + 2]! - eye[2]);
}

describe("particleSort", () => {
  it("orders particles far-to-near with a permutation of all indices", () => {
    const count = 500;
    const positions = new Float32Array(count * 3);
    let seed = 7;
    const rand = () => (seed = (seed * 1_664_525 + 1_013_904_223) >>> 0) / 0x1_0000_0000;
    for (let index = 0; index < positions.length; index++) positions[index] = (rand() - 0.5) * 40;
    const eye = [3, 5, -9] as const;
    const order = new Uint32Array(count);
    const scratch = createParticleSortScratch(count, 4_096);
    expect(sortParticlesBackToFront(positions, count, eye, order, scratch)).toBe(count);
    expect(new Set(order).size).toBe(count);
    let tolerance = 0;
    const all = Array.from({ length: count }, (_, i) => distance(positions, i, eye));
    tolerance = (Math.max(...all) - Math.min(...all)) / 4_095 + 1e-6;
    for (let rank = 1; rank < count; rank++) {
      expect(all[order[rank - 1]!]!).toBeGreaterThanOrEqual(all[order[rank]!]! - tolerance);
    }
  });

  it("is stable for equal distances and deterministic across runs", () => {
    const positions = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1]);
    const first = new Uint32Array(4), second = new Uint32Array(4);
    sortParticlesBackToFront(positions, 4, [0, 0, 0], first, createParticleSortScratch(4));
    sortParticlesBackToFront(positions, 4, [0, 0, 0], second, createParticleSortScratch(4));
    expect(Array.from(first)).toEqual([0, 1, 2, 3]);
    expect(Array.from(second)).toEqual(Array.from(first));
  });

  it("handles empty input, non-finite coordinates and capacity errors", () => {
    const scratch = createParticleSortScratch(3);
    expect(sortParticlesBackToFront(new Float32Array(0), 0, [0, 0, 0], new Uint32Array(0), scratch)).toBe(0);
    const order = new Uint32Array(3);
    sortParticlesBackToFront(new Float32Array([Number.NaN, 0, 0, 5, 0, 0, 1, 0, 0]), 3, [0, 0, 0], order, scratch);
    expect(order[0]).toBe(1);
    expect(new Set(order).size).toBe(3);
    expect(() => sortParticlesBackToFront(new Float32Array(9), 3, [0, 0, 0], new Uint32Array(2), scratch)).toThrow(RangeError);
    expect(() => sortParticlesBackToFront(new Float32Array(3), 3, [0, 0, 0], order, scratch)).toThrow(RangeError);
  });
});
