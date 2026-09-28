import { describe, expect, it } from "vitest";
import { resolveTemporalAaCpu } from "./temporalAaCpu.js";
import { accumulateTemporalFrame, accumulateTemporalFrameDetailed, BASELINE_REPROJECTION_POLICY,
  GHOST_GUARD_REPROJECTION_POLICY, ghostEnergy, measureGhostSequence, neighborhoodVarianceLuma,
  type ReprojectionPolicy, type TemporalAccumulationInput } from "./temporalReprojection.js";

const options = { feedback: 0.9, depthThreshold: 0.1, relativeDepthThreshold: 0.02 } as const;
const jitter: readonly [number, number] = [0, 0];

describe("temporal reprojection reference (T07)", () => {
  it("is bit-identical to the shipped TAA CPU reference under the baseline policy", () => {
    const width = 12, height = 8, pixels = width * height;
    const color = Array.from({ length: pixels * 4 }, (_, i) => (i % 4 === 3 ? 1 : ((i / 4 | 0) * 0.37) % 1));
    const depth = Array.from({ length: pixels }, (_, i) => 3 + (i % width) * 0.25);
    const motion = Array.from({ length: pixels * 2 }, (_, i) => i % 2 === 0 ? 0.5 / width : -0.25 / height);
    const previousColor = Array.from({ length: pixels * 4 }, (_, i) => (i % 4 === 3 ? 1 : ((i / 4 | 0) * 0.61) % 1));
    const previousDepth = depth.map(value => value + 0.02);
    const input: TemporalAccumulationInput = { width, height, color, depth, motion, previousColor, previousDepth,
      currentJitter: jitter, previousJitter: jitter, historyValid: true };
    const shipped = resolveTemporalAaCpu({ width, height, color, depth, motion, previousColor, previousDepth,
      currentJitter: jitter, previousJitter: jitter, historyValid: true }, options);
    const baseline = accumulateTemporalFrame(input, options, BASELINE_REPROJECTION_POLICY);
    expect(Array.from(baseline)).toEqual(Array.from(shipped));
    expect(accumulateTemporalFrame(input, options).every((value, index) => value === baseline[index])).toBe(true);
  });

  it("reports neighborhood variance only across strong edges", () => {
    const width = 4, height = 1, flatColor = Array<number>(16).fill(0).map((_, i) => i % 4 === 3 ? 1 : 0.5);
    expect(neighborhoodVarianceLuma(flatColor, width, height, 1, 0)).toBe(0);
    const edgeColor = [0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    expect(neighborhoodVarianceLuma(edgeColor, width, height, 1, 0)).toBeGreaterThan(0.01);
  });

  it("decays feedback where clamped history disagrees with matching-depth content changes", () => {
    const width = 4, height = 4, pixels = width * height;
    // Per-pixel checkerboard: every 3x3 neighborhood contains both colors, so the
    // YCoCg clamp never tightens and depth rejection is blind — the decay trigger's case.
    const checker = (phase: number) => Array.from({ length: pixels * 4 }, (_, i) => {
      if (i % 4 === 3) return 1;
      const pixel = i / 4 | 0;
      return ((pixel % width) + (pixel / width | 0)) % 2 === phase ? 1 : 0;
    });
    const color = checker(1), previousColor = checker(0);
    const depth = Array<number>(pixels).fill(4);
    const motion = Array<number>(pixels * 2).fill(0);
    const input: TemporalAccumulationInput = { width, height, color, depth, motion, previousColor, previousDepth: depth,
      currentJitter: jitter, previousJitter: jitter, historyValid: true };
    const baseline = accumulateTemporalFrameDetailed(input, options, BASELINE_REPROJECTION_POLICY);
    // Baseline keeps full feedback: the clamp stays open and the flip passes through.
    expect(baseline.decisions.every(decision => decision.mode === "temporal")).toBe(true);
    expect(accumulateTemporalFrame(input, options, BASELINE_REPROJECTION_POLICY)[0]).toBeCloseTo(0.9, 6);
    const guarded = accumulateTemporalFrameDetailed(input, options, GHOST_GUARD_REPROJECTION_POLICY);
    expect(guarded.decisions.every(decision => decision.mode === "temporal-decayed")).toBe(true);
    expect(guarded.output[0]).toBeCloseTo(0.9 * 0.35, 6);
    expect(guarded.decisions[0]!.effectiveFeedback).toBeCloseTo(options.feedback * GHOST_GUARD_REPROJECTION_POLICY.decayFactor, 12);
  });

  it("falls back to the 3x3 box when almost every tap is depth-rejected", () => {
    const width = 4, height = 4, pixels = width * height;
    const color = Array<number>(pixels * 4).fill(0.25);
    const depth = Array<number>(pixels).fill(8), previousDepth = Array<number>(pixels).fill(4);
    const input: TemporalAccumulationInput = { width, height, color, depth, motion: Array<number>(pixels * 2).fill(0),
      previousColor: Array<number>(pixels * 4).fill(1), previousDepth,
      currentJitter: jitter, previousJitter: jitter, historyValid: true };
    const policy = { ...GHOST_GUARD_REPROJECTION_POLICY };
    const detail = accumulateTemporalFrameDetailed(input, options, policy);
    expect(detail.decisions.every(decision => decision.mode === "neighborhood-fallback")).toBe(true);
    // Box mean over the constant field equals the field itself.
    expect(detail.output[0]).toBeCloseTo(0.25, 12);
    // A static matching-depth scene never triggers the fallback (acceptedRatio is 1).
    const stable = accumulateTemporalFrameDetailed({ ...input, depth: Array<number>(pixels).fill(4) }, options, policy);
    expect(stable.decisions.every(decision => decision.mode === "temporal")).toBe(true);
  });

  it("keeps strong-contrast ghost energy under 5% of source contrast within 3 frames", () => {
    const width = 32, height = 8, pixels = width * height, bar = 8;
    // Scene A: acceptance-critical strong-contrast switch. A 2px-period picket fence
    // flips to its inverse in one frame (lighting/content change) and then holds still;
    // the clamp stays open everywhere, so depth rejection is blind and only the decay
    // trigger drives the residual down within the 3-frame acceptance budget.
    const fence = (phase: number) => ({ color: Array.from({ length: pixels * 4 }, (_, i) =>
      i % 4 === 3 ? 1 : ((((i / 4 | 0) % width) - 2 * phase) % 4 + 4) % 4 < 2 ? 1 : 0),
      depth: Array<number>(pixels).fill(4) });
    const run = (policy: ReprojectionPolicy) => {
      const target = fence(0);
      let previousColor: ArrayLike<number> | undefined = fence(1).color, previousDepth: ArrayLike<number> = fence(1).depth;
      const resolved: Float32Array[] = [], ideal: Array<readonly number[]> = [];
      for (let frame = 0; frame < 3; frame++) {
        const out = accumulateTemporalFrame({ width, height, ...target, motion: Array<number>(pixels * 2).fill(0),
          ...(previousColor ? { previousColor, previousDepth } : {}), currentJitter: jitter, previousJitter: jitter,
          historyValid: true }, options, policy);
        resolved.push(out); ideal.push(target.color);
        previousColor = Array.from(out); previousDepth = target.depth;
      }
      return measureGhostSequence(resolved, ideal, 1);
    };
    const guarded = run(GHOST_GUARD_REPROJECTION_POLICY);
    const baseline = run(BASELINE_REPROJECTION_POLICY);
    expect(guarded.passesWithin3Frames).toBe(true);
    // Interior pixels decay by feedback*decayFactor each frame; border pixels whose 3x3
    // window leaves the image clamp tighter, so frame 0 sits just below the pure product.
    expect(guarded.energies[0]).toBeGreaterThan(0.2);
    expect(guarded.energies[0]).toBeLessThan(options.feedback * GHOST_GUARD_REPROJECTION_POLICY.decayFactor + 1e-6);
    expect(guarded.firstPassingFrame).toBe(2);
    // The baseline must be measurably worse: the decision layer, not the base TAA, delivers the target.
    expect(baseline.energies[2]).toBeGreaterThan(0.05);
    expect(baseline.energies[2]).toBeGreaterThan(guarded.energies[2]);

    // Scene B: sliding bar with correct motion — history rejects cleanly, both pass.
    const scene = (barStart: number) => ({ color: Array.from({ length: pixels * 4 }, (_, i) =>
      i % 4 === 3 ? 1 : (((i / 4 | 0) % width) >= barStart && ((i / 4 | 0) % width) < barStart + bar ? 1 : 0)),
      depth: Array<number>(pixels).fill(4) });
    const motionOf = (shift: number) => Array.from({ length: pixels * 2 }, (_, i) => i % 2 === 0 ? shift / width : 0);
    const starts = [4, 10, 16];
    let previousColor: ArrayLike<number> | undefined, previousDepth: ArrayLike<number> | undefined;
    const resolvedBar: Float32Array[] = [], idealBar: Array<readonly number[]> = [];
    for (let frame = 0; frame < 3; frame++) {
      const current = scene(starts[frame]!);
      resolvedBar.push(accumulateTemporalFrame({ width, height, ...current, motion: motionOf(frame === 0 ? 0 : 6),
        ...(previousColor && previousDepth ? { previousColor, previousDepth } : {}), currentJitter: jitter, previousJitter: jitter,
        historyValid: frame > 0 }, options, GHOST_GUARD_REPROJECTION_POLICY));
      idealBar.push(current.color);
      previousColor = Array.from(resolvedBar[frame]!); previousDepth = current.depth;
    }
    const barReport = measureGhostSequence(resolvedBar, idealBar, 1);
    expect(barReport.passesWithin3Frames).toBe(true);
    expect(barReport.firstPassingFrame).toBeLessThanOrEqual(2);
  });

  it("rejects invalid reprojection inputs", () => {
    expect(() => ghostEnergy([0, 0, 0, 1], [0, 0, 0, 1], 0)).toThrow();
    expect(() => ghostEnergy([0, 0, 0, 1], [0, 0, 0, 1, 0, 1, 0, 1], 1)).toThrow();
    expect(() => measureGhostSequence([], [], 1)).toThrow();
    expect(() => neighborhoodVarianceLuma([0, 0, 0], 4, 1, 0, 0)).not.toThrow();
  });
});
