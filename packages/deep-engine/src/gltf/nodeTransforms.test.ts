import { describe, expect, it } from "vitest";
import { packTransform } from "../instanceTransform.js";
import { identity, sceneMeshNodes } from "./nodeTransforms.js";
import { GltfImportError, type JsonObject } from "./validation.js";

function project(nodes: JsonObject[], roots = [0]) {
  return sceneMeshNodes({ nodes, scenes: [{ nodes: roots }] }, [{}]);
}
function invalid(action: () => unknown, text: string) {
  expect(action).toThrow(GltfImportError); expect(action).toThrow(text);
}

describe("glTF node projection", () => {
  it("composes T R S in column order and parent-before-child order", () => {
    const result = project([{ translation: [10, 20, 30], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 3, 4], children: [1] },
      { mesh: 0, translation: [1, 2, 3], scale: [2, 1, -1] }]);
    expect(result).toHaveLength(1);
    const expected = [0, 4, 0, 0, -3, 0, 0, 0, 0, 0, -4, 0, 4, 22, 42, 1];
    result[0]!.transform.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 6));
    expect(packTransform(result[0]!.transform, new Float32Array(24))).toBe(true);
  });
  it("retains root and child source order and shared node identities across scenes", () => {
    const nodes = [{ mesh: 0, children: [2, 3] }, { mesh: 0 }, { mesh: 0 }, { mesh: 0 }];
    const document = { nodes, scene: 1, scenes: [{ nodes: [0, 1] }, { nodes: [1] }] };
    expect(sceneMeshNodes(document, [{}]).map(node => node.index)).toEqual([1]);
    expect(sceneMeshNodes(document, [{}], 0).map(node => node.index)).toEqual([0, 2, 3, 1]);
  });
  it("uses explicit matrices without mutating caller data", () => {
    const matrix = identity(); matrix[12] = 7;
    const result = project([{ matrix, mesh: 0 }]);
    expect(result[0]!.transform[12]).toBe(7);
    matrix[12] = 99;
    expect(result[0]!.transform[12]).toBe(7);
  });
  it("allows composed world shear from valid parent scale and child rotation", () => {
    const result = project([{ scale: [2, 1, 1], children: [1] }, { mesh: 0, rotation: [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)] }]);
    expect(result[0]!.transform[0]).toBeCloseTo(Math.SQRT2);
    expect(result[0]!.transform[4]).toBeCloseTo(-Math.SQRT2);
    expect(() => packTransform(result[0]!.transform, new Float32Array(24))).not.toThrow();
  });
  it("normalizes bounded exporter rounding in authored quaternions", () => {
    const result = project([{ mesh: 0, rotation: [0, 0, 0.707, 0.707] }]);
    expect(result[0]!.transform[0]).toBeCloseTo(0, 5);
    expect(result[0]!.transform[1]).toBeCloseTo(1, 5);
  });
  it("traverses a deep flat node hierarchy iteratively", () => {
    const nodes = Array.from({ length: 10_000 }, (_, index) => index === 9999 ? { mesh: 0 } : { children: [index + 1] });
    expect(project(nodes)).toEqual([{ index: 9999, mesh: 0, transform: identity() }]);
  });
  it.each([
    [[{ children: [0] }], [0], "cycle"],
    [[{ children: [1] }, { children: [0] }], [], "cycle"],
    [[{}, { children: [2] }, { children: [1] }], [0], "cycle"],
    [[{ children: [2] }, { children: [2] }, {}], [0, 1], "multiple parents"],
    [[{ children: [1, 1] }, {}], [0], "duplicate edges"],
    [[{ children: [1] }, {}], [1], "without parents"],
    [[{}], [0, 0], "distinct"],
    [[{ children: [3] }], [0], "out of range"],
  ] as const)("rejects malformed forests %#", (nodes, roots, text) => {
    invalid(() => project([...nodes], [...roots]), text);
  });
  it.each([
    { matrix: identity(), translation: [0, 0, 0] },
    { matrix: identity().map((value, index) => index === 3 ? 1e-99 : value) },
    { matrix: identity().map((value, index) => index === 4 ? 0.1 : value) },
    { rotation: [0, 0, 0, 2] }, { rotation: [0, 0, 0, 0] }, { scale: [0, 1, 1] }, { scale: [1e50, 1, 1] },
    { translation: null }, { rotation: null }, { scale: null },
  ])("rejects malformed or non-renderable transforms %j", transform => {
    expect(() => project([{ ...transform, mesh: 0 }])).toThrow(GltfImportError);
  });
  it("rejects overflow during world composition even when local matrices fit", () => {
    invalid(() => project([{ scale: [1e30, 1e30, 1e30], children: [1] }, { scale: [1e20, 1e20, 1e20], mesh: 0 }]), "finite float32");
  });
  it.each(["skin", "weights", "camera"])("rejects unsupported node %s even outside the selected scene", field => {
    try { project([{}, { [field]: 0 }]); throw new Error("expected unsupported"); }
    catch (error) { expect(error).toMatchObject({ code: "unsupported", path: `nodes[1].${field}` }); }
  });
  it("validates all scenes and scene selection", () => {
    invalid(() => sceneMeshNodes({ nodes: [{}], scenes: [{ nodes: [0] }, { nodes: [2] }] }, []), "out of range");
    invalid(() => sceneMeshNodes({ nodes: [], scenes: [{}] }, [], 1), "out of range");
    invalid(() => sceneMeshNodes({}, []), "explicit scene");
  });
});
