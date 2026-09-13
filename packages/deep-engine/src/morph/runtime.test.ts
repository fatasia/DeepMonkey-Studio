import { describe, expect, it } from "vitest";
import { blendMorphTargetDeltas, sampleMorphWeightTrack } from "./runtime.js";
import { MorphRuntimeError, type MorphPrimitiveSource, type MorphWeightTrack } from "./types.js";

describe("morph runtime", () => {
  it("samples STEP, LINEAR, and CUBICSPLINE tracks with clamp/loop and reusable output", () => {
    const linear = track("LINEAR", [0, 0, 1, 0.5]), output = new Float32Array(2);
    expect(sampleMorphWeightTrack(linear, 0.5, { wrapMode: "clamp" }, output)).toBe(output);
    expect([...output]).toEqual([0.5, 0.25]);
    expect([...sampleMorphWeightTrack(linear, 1.5)]).toEqual([0.5, 0.25]);
    expect([...sampleMorphWeightTrack(track("STEP", [0, 0, 1, 0.5]), 0.75, { wrapMode: "clamp" })]).toEqual([0, 0]);
    const cubic = track("CUBICSPLINE", [0, 0, 0, 0, 0, 0, 0, 0, 1, 0.5, 0, 0]);
    expect([...sampleMorphWeightTrack(cubic, 0.5, { wrapMode: "clamp" })]).toEqual([0.5, 0.25]);
  });

  it("mixes multiple target semantics into caller-owned reusable buffers", () => {
    const primitive = source(), position = new Float32Array(6), normal = new Float32Array(6);
    const output = { positionDeltas: position, normalDeltas: normal };
    expect(blendMorphTargetDeltas(primitive, [0.5, 0.25], output)).toBe(output);
    expect([...position]).toEqual([0.5, 0.5, 0, 0.5, 0.5, 0]);
    expect([...normal]).toEqual([0, 0.5, 0, 0, 0.5, 0]);
    blendMorphTargetDeltas(primitive, [0, 1], output);
    expect([...position]).toEqual([0, 2, 0, 0, 2, 0]);
    expect([...normal]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("fails before mutating outputs for invalid weights, layouts, aliases, time, or output size", () => {
    const primitive = source(), position = new Float32Array(6).fill(7), normal = new Float32Array(6).fill(8);
    expectCode(() => blendMorphTargetDeltas(primitive, [Number.NaN, 0], { positionDeltas: position, normalDeltas: normal }), "invalid-source");
    expect([...position]).toEqual(Array(6).fill(7));
    expect([...normal]).toEqual(Array(6).fill(8));
    expectCode(() => blendMorphTargetDeltas(primitive, [0, 0], { positionDeltas: position, normalDeltas: position }), "invalid-output");
    expectCode(() => blendMorphTargetDeltas(primitive, [0, 0], { positionDeltas: position }), "invalid-output");
    expectCode(() => blendMorphTargetDeltas(primitive, [0, 0], { positionDeltas: new Float32Array(1), normalDeltas: normal }), "invalid-output");
    const overflow = source(); overflow.targets[0]!.positionDeltas![0] = 3e38;
    expectCode(() => blendMorphTargetDeltas(overflow, [3e38, 0], { positionDeltas: position, normalDeltas: normal }), "invalid-source");
    expect([...position]).toEqual(Array(6).fill(7));
    expectCode(() => sampleMorphWeightTrack(track("LINEAR", [0, 0, 1, 0.5]), Number.NaN), "invalid-time");
    expectCode(() => sampleMorphWeightTrack({ ...track("LINEAR", [0, 0, 1, 0.5]), values: new Float32Array(1) }, 0), "invalid-source");
  });
});

function track(interpolation: MorphWeightTrack["interpolation"], values: number[]): MorphWeightTrack<number> {
  return { nodeId: 1, targetCount: 2, interpolation, times: new Float32Array([0, 1]), values: new Float32Array(values) };
}
function source(): MorphPrimitiveSource {
  return { id: "face", sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 2, targets: [
    { index: 0, name: "x", positionDeltas: new Float32Array([1, 0, 0, 1, 0, 0]), normalDeltas: new Float32Array([0, 1, 0, 0, 1, 0]) },
    { index: 1, name: "y", positionDeltas: new Float32Array([0, 2, 0, 0, 2, 0]) },
  ] };
}
function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected morph runtime error."); }
  catch (error) { expect(error).toBeInstanceOf(MorphRuntimeError); expect((error as MorphRuntimeError).code).toBe(code); }
}
