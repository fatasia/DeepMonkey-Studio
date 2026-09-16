import { describe, expect, it } from "vitest";
import { resolveTemporalAaCpu } from "./temporalAaCpu.js";
import type { TemporalAaCpuInput } from "./temporalAaTypes.js";

const options = { feedback: 0.9, depthThreshold: 0.125, relativeDepthThreshold: 0 };
const rgba = (values: number[]) => values.flatMap(value => [value, value, value, 1]);
function fixture(deltaX = 0, deltaY = 0): TemporalAaCpuInput {
  return { width: 3, height: 3, color: rgba([0, 0, 0, 0, 1, 0, 0, 0, 0]),
    depth: Array(9).fill(4), motion: Array(18).fill(0),
    previousColor: rgba([0, 0, 0, 0, 1, 0, 0, 0, 0]), previousDepth: Array(9).fill(4),
    currentJitter: [-deltaX / 2, -deltaY / 2], previousJitter: [deltaX / 2, deltaY / 2], historyValid: true };
}
const center = (input: TemporalAaCpuInput) => resolveTemporalAaCpu(input, options)[16]!;

describe("depth-aware bilinear TAA history", () => {
  it.each([0, 0.01, 0.49, 0.5, 0.51, 0.99, 1])("interpolates continuously across half-pixel boundary (%s)", delta => {
    expect(center(fixture(delta))).toBeCloseTo(0.1 + 0.9 * (1 - delta), 6);
  });
  it("weights all four taps in two dimensions", () => {
    expect(center(fixture(0.25, 0.75))).toBeCloseTo(0.1 + 0.9 * 0.75 * 0.25, 6);
    expect(center(fixture(-0.25, -0.75))).toBeCloseTo(0.1 + 0.9 * 0.75 * 0.25, 6);
  });
  it.each([0, -1, 8])("rejects incompatible tap depth %s and renormalizes accepted taps", rejected => {
    const input = fixture(0.5, 0.5), depths = Array(9).fill(rejected);
    depths[4] = 4;
    expect(center({ ...input, previousDepth: depths })).toBeCloseTo(1, 6);
  });
  it("retains the current sample when every weighted tap is rejected", () => {
    const input = fixture(0.5, 0.5);
    expect(center({ ...input, previousDepth: Array(9).fill(8) })).toBe(1);
  });
  it("preserves exact absolute depth threshold inclusion", () => {
    const input = fixture(0.5), depths = Array(9).fill(4.125);
    expect(center({ ...input, previousDepth: depths })).toBeCloseTo(0.55, 6);
    expect(center({ ...input, previousDepth: Array(9).fill(4.126) })).toBe(1);
  });
  it("preserves relative depth rejection without expanding the threshold", () => {
    const input = fixture(0.5), relative = { ...options, depthThreshold: 0, relativeDepthThreshold: 0.25 };
    expect(resolveTemporalAaCpu({ ...input, previousDepth: Array(9).fill(5) }, relative)[16]).toBeCloseTo(0.55, 6);
    expect(resolveTemporalAaCpu({ ...input, previousDepth: Array(9).fill(5.01) }, relative)[16]).toBe(1);
  });
  it("does not admit a compatible but zero-weight tap", () => {
    const input = fixture(), depths = Array(9).fill(4);
    depths[4] = 8;
    expect(center({ ...input, previousDepth: depths })).toBe(1);
  });
  it("retains background rejection and current alpha", () => {
    const input = fixture(0.5), depth = [...input.depth], color = [...input.color];
    depth[4] = 0; color[19] = 0.4;
    const output = resolveTemporalAaCpu({ ...input, depth, color }, options);
    expect(output[16]).toBe(1); expect(output[19]).toBeCloseTo(0.4, 6);
  });
  it("clamps taps at texture borders without darkening constant history", () => {
    const input = fixture(-0.25, -0.25);
    const output = resolveTemporalAaCpu({ ...input, previousColor: rgba(Array(9).fill(0.75)) }, options);
    expect(output[0]).toBeCloseTo(0.675, 6);
  });
  it("rejects reprojection centers outside the image", () => {
    const input = fixture(-1, -1);
    const output = resolveTemporalAaCpu({ ...input, previousColor: rgba(Array(9).fill(0.75)) }, options);
    expect(output[0]).toBe(0);
  });
  it("clips reconstructed history to the current YCoCg neighborhood", () => {
    expect(center({ ...fixture(0.5), previousColor: rgba(Array(9).fill(10)) })).toBe(1);
  });
});
