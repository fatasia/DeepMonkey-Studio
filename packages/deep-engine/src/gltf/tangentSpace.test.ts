import { describe, expect, it } from "vitest";
import { generateTangents } from "./tangentSpace.js";

const quad = new Float32Array([
  0, 0, 0, 0, 0, 1,
  2, 0, 0, 0, 0, 1,
  2, 3, 0, 0, 0, 1,
  0, 3, 0, 0, 0, 1,
]);
const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);

describe("glTF tangent generation", () => {
  it("derives a normalized area-weighted basis from indexed positions, normals and UV0", () => {
    const tangents = generateTangents(quad, new Float32Array([0, 0, 2, 0, 2, 4, 0, 4]), indices, "mesh");
    for (let vertex = 0; vertex < 4; vertex++) {
      expect([...tangents.slice(vertex * 4, vertex * 4 + 4)]).toEqual([1, 0, 0, 1]);
    }
  });

  it("preserves a mirrored UV chart through -1 handedness", () => {
    const tangents = generateTangents(quad, new Float32Array([0, 0, 0, 4, 2, 4, 2, 0]), indices, "mesh");
    for (let vertex = 0; vertex < 4; vertex++) expect(tangents[vertex * 4 + 3]).toBe(-1);
  });

  it("rejects degenerate UVs instead of publishing an arbitrary axis", () => {
    expect(() => generateTangents(quad, new Float32Array(8), indices, "meshes[0].primitives[0]")).toThrow("Cannot derive a tangent");
  });

  it("rejects opposite UV handedness sharing an unsplit vertex", () => {
    const vertices = new Float32Array([
      0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
      -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 1,
    ]);
    const uv = new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0]);
    expect(() => generateTangents(vertices, uv, new Uint32Array([0, 1, 2, 0, 3, 4]), "mesh"))
      .toThrow("Mirrored UV charts sharing a vertex");
  });
});
