import { describe, expect, it } from "vitest";
import { generateNormals, repairZeroNormals } from "./generatedNormals.js";

describe("glTF generated normals", () => {
  it("generates area-weighted normals for indexed shared vertices", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect([...generateNormals(positions, new Uint32Array([0, 1, 2, 0, 2, 3]), "mesh")])
      .toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  });

  it("respects triangle winding", () => {
    const positions = new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0]);
    expect([...generateNormals(positions, new Uint32Array([0, 1, 2]), "mesh")])
      .toEqual([0, 0, -1, 0, 0, -1, 0, 0, -1]);
  });

  it("fails closed when a vertex has no valid triangle contribution", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    expect(() => generateNormals(positions, new Uint32Array([0, 1, 2]), "mesh.normal"))
      .toThrow("Cannot generate a normal");
  });

  it("repairZeroNormals keeps valid normals and repairs only broken ones", () => {
    // 三角形(0,1,2)朝 +Z;顶点 3 是孤立顶点(不在索引里,绘制不到)。
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 5]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0]);
    const repaired = repairZeroNormals(normals, positions, new Uint32Array([0, 1, 2]), "mesh.normal");
    expect([...repaired.subarray(0, 9)]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect([...repaired.subarray(9)]).toEqual([0, 0, 1]);
  });

  it("repairZeroNormals falls back to +Z for a zero-normal vertex inside a degenerate triangle, and returns the same array when healthy", () => {
    // 顶点 1 带零法线,且它所在的三角形退化(共线)→ 几何法线无法生成 → fallback +Z。
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    const degenerate = repairZeroNormals(new Float32Array([0, 0, 1, 0, 0, 0, 0, 0, 1]),
      positions, new Uint32Array([0, 1, 2]), "mesh.normal");
    expect([...degenerate.subarray(3, 6)]).toEqual([0, 0, 1]);

    const healthy = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    expect(repairZeroNormals(healthy, positions, new Uint32Array([0, 1, 2]), "mesh.normal")).toBe(healthy);
  });
});
