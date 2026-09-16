import { describe, expect, it } from "vitest";
import { cpuSkinVertices, prepareSkinningInput } from "./gpuSkinningPacking.js";
import { prepareMorphSkinningInput } from "./gpuMorphSkinningPacking.js";
import type { SkinningSource } from "./gpuSkinningTypes.js";

const source = (weightMode?: SkinningSource["weightMode"]): SkinningSource => ({
  revision: 1, positions: new Float32Array([1, 0, 0]), normals: new Float32Array([0, 1, 0]),
  joints: new Uint16Array([0, 0, 0, 0]), weights: new Float32Array([0.25, 0.25, 0, 0]), weightMode,
});
const palette = { revision: 1, matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]) };

describe("explicit author skin weights", () => {
  it("preserves original magnitudes without changing the legacy default", () => {
    expect(cpuSkinVertices(prepareSkinningInput(source(), palette))[0]).toBe(3);
    expect(cpuSkinVertices(prepareSkinningInput(source("normalize"), palette))[0]).toBe(3);
    const author = source("preserve"), prepared = prepareSkinningInput(author, palette);
    expect([...new Float32Array(prepared.vertices).slice(12, 16)]).toEqual([0.25, 0.25, 0, 0]);
    expect(cpuSkinVertices(prepared)[0]).toBe(1.5);
    author.weights.fill(1);
    expect(cpuSkinVertices(prepared)[0]).toBe(1.5);
  });

  it("carries preserved influences into the fused morph-skin GPU layout", () => {
    const skin = source("preserve");
    const prepared = prepareMorphSkinningInput({ revision: 1, positions: skin.positions, normals: skin.normals,
      primitive: { id: "pose", sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1,
        targets: [{ index: 0, name: "move", positionDeltas: new Float32Array([1, 0, 0]) }] } },
    skin, { revision: 1, values: new Float32Array([1]) }, palette);
    expect([...new Float32Array(prepared.influences).slice(4, 8)]).toEqual([0.25, 0.25, 0, 0]);
  });

  it("rejects unknown modes and keeps malformed weights explicit", () => {
    expect(() => prepareSkinningInput(source("invalid" as "preserve"), palette)).toThrow("weight mode");
    for (const weights of [[0, 0, 0, 0], [-1, 1, 0, 0], [NaN, 1, 0, 0]]) {
      expect(() => prepareSkinningInput({ ...source("preserve"), weights: new Float32Array(weights) }, palette)).toThrow();
    }
  });
});
