import { describe, expect, it } from "vitest";
import { generateNormals } from "./generatedNormals.js";

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
});
