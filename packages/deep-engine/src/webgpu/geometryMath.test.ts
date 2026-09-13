import { describe, expect, it } from "vitest";
import { lookAt, multiply, orthographic, perspective } from "./cameraMath.js";
import { sphereMesh, groundMesh } from "./primitives.js";
import { surfaceSize } from "./surfaceSize.js";
import { validateInstances } from "./meshBuffers.js";

function transform(matrix: Float32Array, v: number[]): number[] {
  return [0, 1, 2, 3].map((row) => v.reduce((sum, value, column) => sum + matrix[column * 4 + row]! * value, 0));
}

describe("WebGPU projection and geometry contracts", () => {
  it("maps camera near/far to WebGPU 0/1 depths and camera eye to origin", () => {
    for (const matrix of [perspective(Math.PI / 3, 1.5, 1, 100), orthographic(20, 1, 100)]) {
      const near = transform(matrix, [0, 0, -1, 1]), far = transform(matrix, [0, 0, -100, 1]);
      expect(near[2]! / near[3]!).toBeCloseTo(0, 5); expect(far[2]! / far[3]!).toBeCloseTo(1, 5);
    }
    const matrix = lookAt([3, 4, 5], [0, 0, 0]);
    transform(matrix, [3, 4, 5, 1]).forEach((value, index) => expect(value).toBeCloseTo(index === 3 ? 1 : 0, 5));
    const combined = multiply(perspective(Math.PI / 3, 1, 0.1, 100), matrix);
    const center = transform(combined, [0, 0, 0, 1]);
    expect(center[0]).toBeCloseTo(0); expect(center[1]).toBeCloseTo(0); expect(center[3]).toBeGreaterThan(0);
  });

  it("rejects degenerate camera bases and non-finite projections", () => {
    expect(() => lookAt([0, 0, 0], [0, 0, 0])).toThrow("degenerate");
    expect(() => lookAt([0, 2, 0], [0, 0, 0])).toThrow("degenerate");
    expect(() => perspective(0, 1, 1, 100)).toThrow();
    expect(() => perspective(1, 0, 1, 100)).toThrow();
    expect(() => perspective(1, 1, 2, 1)).toThrow();
    expect(() => orthographic(Infinity, 1, 100)).toThrow();
  });

  it("keeps every sphere triangle outward-facing, non-degenerate and in range", () => {
    const { vertices, indices } = sphereMesh(12, 8);
    expect(indices.length).toBe(12 * 7 * 6);
    for (let i = 0; i < indices.length; i += 3) {
      const points = [0, 1, 2].map((offset) => {
        const index = indices[i + offset]! * 6; expect(index + 5).toBeLessThan(vertices.length);
        return [vertices[index]!, vertices[index + 1]!, vertices[index + 2]!];
      });
      const [a, b, c] = points as [number[], number[], number[]];
      const ab = b.map((value, j) => value - a[j]!), ac = c.map((value, j) => value - a[j]!);
      const normal = [ab[1]! * ac[2]! - ab[2]! * ac[1]!, ab[2]! * ac[0]! - ab[0]! * ac[2]!, ab[0]! * ac[1]! - ab[1]! * ac[0]!];
      expect(normal.reduce((sum, value, j) => sum + value * a[j]!, 0)).toBeGreaterThan(0.0001);
    }
    expect(groundMesh().indices.length).toBe(6);
    expect(() => sphereMesh(2, 8)).toThrow(); expect(() => sphereMesh(12, 257)).toThrow();
  });

  it("suspends zero/non-finite surfaces and caps size without distorting aspect", () => {
    for (const width of [0, -1, NaN, Infinity]) expect(surfaceSize(width, 600, 1, 4096)).toBeUndefined();
    expect(surfaceSize(800, 600, 3, 4096)).toEqual({ width: 1600, height: 1200 });
    expect(surfaceSize(8000, 4000, 2, 4096)).toEqual({ width: 4096, height: 2048 });
    expect(surfaceSize(0.1, 0.1, 1, 4096)).toEqual({ width: 1, height: 1 });
    expect(surfaceSize(800, 600, 0, 4096)).toBeUndefined();
  });

  it("accepts an empty scene and rejects malformed instances before any upload", () => {
    expect(validateInstances(new Float32Array())).toBe(0);
    const valid = new Float32Array([0, 1, 0, 1, 0.2, 0.3, 0.4, 0.8, 0.2, 0, 0, 0]);
    expect(validateInstances(valid)).toBe(1);
    for (const [index, value] of [[3, 0], [0, NaN], [7, 2], [8, -0.5]]) {
      const bad = valid.slice(); bad[index!] = value!; expect(() => validateInstances(bad)).toThrow();
    }
    expect(() => validateInstances(new Float32Array(13))).toThrow();
    expect(() => validateInstances(new Float32Array(12 * 16_385))).toThrow();
  });
});
