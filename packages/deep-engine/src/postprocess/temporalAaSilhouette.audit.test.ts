import { describe, expect, it } from "vitest";
import { resolveTemporalAaCpu, temporalAaJitter } from "./temporalAaCpu.js";

const width = 32, height = 32, pixels = width * height;
const options = { feedback: .9, depthThreshold: .1, relativeDepthThreshold: .01 };
// A geometric half-plane, sampled analytically (not a resized binary image).
const inside = (x: number, y: number) => x < .61 * y + 5.27;
function raster(jitter: readonly [number, number]) {
  const color = Array<number>(pixels * 4).fill(0), depth = Array<number>(pixels).fill(0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x;
    const value = Number(inside(x + .5 - jitter[0], y + .5 - jitter[1]));
    color.splice(i * 4, 4, value, value, value, 1); depth[i] = value * 10;
  }
  return { color, depth };
}
function referenceCoverage() {
  const result = Array<number>(pixels).fill(0), samples = 64;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let covered = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      covered += Number(inside(x + (sx + .5) / samples, y + (sy + .5) / samples));
    }
    result[y * width + x] = covered / (samples * samples);
  }
  return result;
}

describe("TAA silhouette coverage audit (documents current limitation)", () => {
  it("cannot integrate static binary foreground/background coverage over 16 jittered frames", () => {
    const reference = referenceCoverage(), mean = Array<number>(pixels).fill(0);
    let previousColor: number[] | undefined, previousDepth: number[] | undefined;
    let previousJitter: readonly [number, number] = [0, 0];
    let last = Array<number>(pixels).fill(0);
    for (let frame = 0; frame < 16; frame++) {
      const currentJitter = temporalAaJitter(frame), current = raster(currentJitter);
      const resolved = resolveTemporalAaCpu({ width, height, ...current,
        motion: Array<number>(pixels * 2).fill(0), currentJitter, previousJitter,
        historyValid: frame > 0, ...(previousColor && previousDepth ? { previousColor, previousDepth } : {}),
      }, options);
      // Foreground history loses background taps; uncovered background skips history.
      expect(Array.from(resolved)).toEqual(current.color);
      last = Array.from({ length: pixels }, (_, i) => resolved[i * 4]!);
      for (let i = 0; i < pixels; i++) mean[i] = mean[i]! + current.color[i * 4]! / 16;
      previousColor = Array.from(resolved); previousDepth = current.depth; previousJitter = currentJitter;
    }
    const edge = reference.map((v, i) => v > 0 && v < 1 ? i : -1).filter(i => i >= 0);
    const rmse = (values: number[]) => Math.sqrt(edge.reduce((sum, i) => sum + (values[i]! - reference[i]!) ** 2, 0) / edge.length);
    expect(edge).toHaveLength(51);
    expect(last.filter(v => v > 0 && v < 1)).toHaveLength(0);
    expect(rmse(mean)).toBeLessThan(rmse(last) * .3);
    expect(rmse(last)).toBeCloseTo(.4653464023, 8);
    expect(rmse(mean)).toBeCloseTo(.0286305977, 8);
  });

  it("correctly removes history when geometry disappears or a different depth is revealed", () => {
    const previous = raster([0, 0]);
    for (const revealedDepth of [0, 30]) {
      // White neighbors keep the YCoCg clamp open, so only depth rejection
      // prevents stale white foreground from leaking into revealed black pixels.
      const color = Array.from({ length: pixels * 4 }, (_, i) => i % 4 === 3 ? 1 : Math.floor(i / 4) % 2);
      const resolved = resolveTemporalAaCpu({ width, height, color,
        depth: Array<number>(pixels).fill(revealedDepth), motion: Array<number>(pixels * 2).fill(0),
        previousColor: previous.color, previousDepth: previous.depth,
        currentJitter: [0, 0], previousJitter: [0, 0], historyValid: true,
      }, options);
      expect(Array.from(resolved)).toEqual(color);
    }
  });
});
