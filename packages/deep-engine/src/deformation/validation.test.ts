import { describe, expect, it } from "vitest";
import type { DeformationSnapshot } from "./types.js";
import { snapshotDeformation, validateDeformationSnapshot } from "./validation.js";

function fixture(kind: "morph" | "skin" | "morph-skin" = "morph-skin"): DeformationSnapshot {
  return {
    sources: [{ id: "source", geometry: "geometry", revision: 2, kind, semantics: "three-r185",
      ...(kind === "skin" ? {} : { morph: { revision: 3, positions: new Float32Array([1, 0, 0]),
        normals: new Float32Array([0, 1, 0]), tangents: new Float32Array([1, 0, 0, -1]),
        primitive: { id: "primitive", sourceMeshIndex: 0, sourcePrimitiveIndex: 1, vertexCount: 1,
          targets: [{ index: 0, name: "target", positionDeltas: new Float32Array([2, 0, 0]),
            normalDeltas: new Float32Array([0, 1, 0]), tangentDeltas: new Float32Array([1, 0, 0]) }] } } }),
      ...(kind === "morph" ? {} : { skinning: { revision: 4, positions: new Float32Array([1, 0, 0]),
        normals: new Float32Array([0, 1, 0]), joints: new Uint16Array(4), weights: new Float32Array([2, 0, 0, 0]),
        weightMode: "preserve" as const } }) }],
    poses: [{ id: "pose", source: "source", revision: 5,
      ...(kind === "skin" ? {} : { morphWeights: { revision: 6, values: new Float32Array([-0.5]) } }),
      ...(kind === "morph" ? {} : { palette: { revision: 7,
        matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 1]),
        normalMatrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]) } }) }],
  };
}

describe("deformation snapshot contract", () => {
  it.each(["morph", "skin", "morph-skin"] as const)("retains every %s field and owns all arrays", kind => {
    const input = fixture(kind), output = snapshotDeformation(input);
    expect(output).toEqual(input);
    function inspect(a: unknown, b: unknown): void {
      if (ArrayBuffer.isView(a)) {
        expect(b).not.toBe(a);
        expect((b as ArrayBufferView).buffer).not.toBe(a.buffer);
      } else if (a && typeof a === "object") {
        expect(Object.isFrozen(b)).toBe(true);
        for (const key of Object.keys(a)) inspect((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]);
      }
    }
    inspect(input, output);
    input.sources[0]!.skinning?.weights.fill(0);
    if (output.sources[0]!.skinning) expect(output.sources[0]!.skinning.weights[0]).toBe(2);
  });
  it("accepts empty snapshots and multiple poses sharing one source without aliasing dynamic arrays", () => {
    expect(snapshotDeformation({ sources: [], poses: [] })).toEqual({ sources: [], poses: [] });
    const input = fixture();
    const result = snapshotDeformation({ ...input, poses: [input.poses[0]!, { ...input.poses[0]!, id: "other" }] });
    expect(result.poses[0]!.palette!.matrices.buffer).not.toBe(result.poses[1]!.palette!.matrices.buffer);
  });
  it.each([
    ["duplicate source", (s: any) => s.sources.push(s.sources[0])],
    ["duplicate pose", (s: any) => s.poses.push(s.poses[0])],
    ["dangling source", (s: any) => s.poses[0].source = "missing"],
    ["empty id", (s: any) => s.sources[0].id = " "],
    ["source version", (s: any) => s.sources[0].revision = -1],
    ["pose version", (s: any) => s.poses[0].revision = 0.1],
    ["nested version", (s: any) => s.sources[0].morph.revision = NaN],
    ["semantics", (s: any) => s.sources[0].semantics = "legacy"],
    ["kind", (s: any) => s.sources[0].kind = "other"],
    ["source mismatch", (s: any) => delete s.sources[0].skinning],
    ["pose mismatch", (s: any) => delete s.poses[0].palette],
    ["null source", (s: any) => s.sources[0].morph = null],
    ["null pose", (s: any) => s.poses[0].palette = null],
    ["unknown data", (s: any) => s.sources[0].morph.extra = new Float32Array(1)],
    ["nonfinite base", (s: any) => s.sources[0].morph.positions[0] = Infinity],
    ["nonfinite delta", (s: any) => s.sources[0].morph.primitive.targets[0].positionDeltas[0] = NaN],
    ["nonfinite weights", (s: any) => s.poses[0].morphWeights.values[0] = NaN],
    ["nonfinite palette", (s: any) => s.poses[0].palette.matrices[0] = Infinity],
    ["normal palette length", (s: any) => s.poses[0].palette.normalMatrices = new Float32Array(11)],
    ["joint range", (s: any) => s.sources[0].skinning.joints[0] = 1],
    ["zero skin weights", (s: any) => s.sources[0].skinning.weights.fill(0)],
    ["fused base mismatch", (s: any) => s.sources[0].skinning.positions[0] = 3],
    ["vertex count", (s: any) => s.sources[0].morph.primitive.vertexCount = 2],
    ["target count", (s: any) => s.poses[0].morphWeights.values = new Float32Array(2)],
    ["shared static", (s: any) => s.sources[0].morph.positions = new Float32Array(new SharedArrayBuffer(12))],
    ["shared dynamic", (s: any) => s.poses[0].palette.matrices = new Float32Array(new SharedArrayBuffer(64))],
  ])("rejects %s", (_name, mutate) => {
    const input = fixture();
    (mutate as (s: DeformationSnapshot) => void)(input);
    expect(() => snapshotDeformation(input)).toThrow();
  });
  it("validates unused static sources and rejects accessors before reading them", () => {
    const input = fixture("skin");
    input.sources[0]!.skinning!.weights[0] = NaN;
    expect(() => validateDeformationSnapshot({ ...input, poses: [] })).toThrow();
    let reads = 0;
    const accessor = { get sources() { reads++; return []; }, poses: [] };
    expect(() => snapshotDeformation(accessor)).toThrow(/data properties/);
    expect(reads).toBe(0);
  });
});
