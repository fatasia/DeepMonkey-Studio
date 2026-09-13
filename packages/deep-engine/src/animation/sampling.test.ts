import { describe, expect, it } from "vitest";
import { sampleAnimationTrack } from "./sampling.js";
import { validateClip, validateMixerOptions } from "./validation.js";
import { AnimationError, type AnimationInterpolation, type AnimationTargetPath } from "./types.js";

const limits = validateMixerOptions({});

describe("animation track sampling", () => {
  it.each([
    ["STEP", 0],
    ["LINEAR", 5],
  ] as const)("samples %s vectors", (interpolation, expected) => {
    const track = clip("translation", interpolation, [0, 1], [0, 0, 0, 10, 0, 0]).tracks[0]!;
    const output = new Float64Array(4);
    sampleAnimationTrack(track, 0.5, output);
    expect(output[0]).toBeCloseTo(expected);
  });

  it("evaluates glTF cubic spline tangents using segment duration", () => {
    const track = clip("translation", "CUBICSPLINE", [0, 1], [
      0, 0, 0, 0, 0, 0, 10, 0, 0,
      10, 0, 0, 10, 0, 0, 0, 0, 0,
    ]).tracks[0]!;
    const output = new Float64Array(4);
    sampleAnimationTrack(track, 0.5, output);
    expect([...output.slice(0, 3)]).toEqual([5, 0, 0]);
  });

  it("normalizes quaternions and follows the shortest arc", () => {
    const sine = Math.sin(Math.PI / 4), cosine = Math.cos(Math.PI / 4);
    const track = clip("rotation", "LINEAR", [0, 1], [0, 0, 0, 2, 0, -sine, 0, -cosine]).tracks[0]!;
    const output = new Float64Array(4);
    sampleAnimationTrack(track, 0.5, output);
    expect(output[1]).toBeCloseTo(Math.sin(Math.PI / 8), 8);
    expect(output[3]).toBeCloseTo(Math.cos(Math.PI / 8), 8);
    expect(Math.hypot(...output)).toBeCloseTo(1, 12);
  });

  it("normalizes cubic quaternion output", () => {
    const track = clip("rotation", "CUBICSPLINE", [0, 1], [
      0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0,
    ]).tracks[0]!;
    const output = new Float64Array(4);
    sampleAnimationTrack(track, 0.5, output);
    expect(Math.hypot(...output)).toBeCloseTo(1, 12);
  });
});

describe("animation clip validation", () => {
  it("rejects duplicate tracks, unordered keys, invalid layouts, and non-finite values", () => {
    const track = { nodeId: "node", path: "translation" as const, interpolation: "LINEAR" as const,
      times: [0, 1], values: [0, 0, 0, 1, 0, 0] };
    expectCode(() => validateClip({ id: "duplicate", duration: 1, tracks: [track, track] }, limits), "duplicate-track");
    expectCode(() => validateClip({ id: "times", duration: 1, tracks: [{ ...track, times: [1, 0] }] }, limits), "invalid-track");
    expectCode(() => validateClip({ id: "range", duration: 1, tracks: [{ ...track, times: [0, 2] }] }, limits), "invalid-track");
    expectCode(() => validateClip({ id: "layout", duration: 1, tracks: [{ ...track, values: [0] }] }, limits), "invalid-track");
    expectCode(() => validateClip({ id: "nan", duration: 1, tracks: [{ ...track, values: [0, 0, 0, Number.NaN, 0, 0] }] }, limits), "invalid-track");
    expectCode(() => clip("rotation", "LINEAR", [0], [0, 0, 0, 0]), "invalid-track");
  });

  it("copies and freezes caller-owned clip arrays", () => {
    const times = [0, 1], values = [0, 0, 0, 1, 0, 0];
    const validated = validateClip({ id: "copy", duration: 1, tracks: [
      { nodeId: "node", path: "translation", interpolation: "LINEAR", times, values },
    ] }, limits);
    times[0] = 99; values[0] = 99;
    expect(validated.tracks[0]?.times[0]).toBe(0);
    expect(validated.tracks[0]?.values[0]).toBe(0);
    expect(Object.isFrozen(validated.tracks[0]?.values)).toBe(true);
  });
});

function clip(path: AnimationTargetPath, interpolation: AnimationInterpolation, times: number[], values: number[]) {
  return validateClip({ id: "clip", duration: times.at(-1) ?? 0, tracks: [
    { nodeId: "node", path, interpolation, times, values },
  ] }, limits);
}

function expectCode(run: () => unknown, code: string): void {
  try { run(); throw new Error("Expected animation operation to fail."); }
  catch (error) { expect(error).toBeInstanceOf(AnimationError); expect((error as AnimationError).code).toBe(code); }
}
