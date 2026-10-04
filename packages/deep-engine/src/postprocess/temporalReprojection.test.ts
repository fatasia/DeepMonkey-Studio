import { describe, expect, it } from "vitest";
import { resolveTemporalAaCpu } from "./temporalAaCpu.js";
import { accumulateTemporalFrame, accumulateTemporalFrameDetailed, BASELINE_REPROJECTION_POLICY,
  deriveTemporalGhostGuardWgsl, enableTemporalGhostGuardWgsl, GHOST_GUARD_REPROJECTION_POLICY, ghostEnergy,
  measureGhostSequence, neighborhoodVarianceLuma, TEMPORAL_GHOST_GUARD_CONST_OFF, TEMPORAL_GHOST_GUARD_CONST_ON,
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
    expect(guarded.output[0]).toBeCloseTo(options.feedback * GHOST_GUARD_REPROJECTION_POLICY.decayFactor, 6);
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
    // Interior pixels decay by feedback*decayFactor for the first two frames (the residual
    // stays above maxHistoryError), then frame 3 resumes full feedback with the residual
    // already below the AA-M2 1% gate; border pixels whose 3x3 window leaves the image
    // clamp tighter, so frame 0 sits just below the pure product.
    expect(guarded.energies[0]).toBeGreaterThan(0.05);
    expect(guarded.energies[0]).toBeLessThan(options.feedback * GHOST_GUARD_REPROJECTION_POLICY.decayFactor + 1e-6);
    expect(guarded.firstPassingFrame).toBe(1);
    // AA-M2 hard gate: frame-3 residual under 1% of source contrast (was 2.93% at decayFactor 0.35).
    expect(guarded.energies[2]).toBeLessThan(0.01);
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

  it("keeps a move-then-stop scene under 1% within 3 frames (second motion type)", () => {
    const width = 32, height = 8, pixels = width * height;
    // A 2px-wide bar slides 4px/frame for 4 frames with correct motion vectors and then
    // stops at uniform depth, so depth rejection is blind and the motion trail can only
    // be cleared by the clamp plus the decay trigger — the stop-ghost counterpart of the
    // flip scene above, guarding the AA-M2 gate against flip-scene-only tuning.
    const moveStopFrame = (barStart: number, shift: number) => {
      const inBar = (column: number) => column >= barStart && column < barStart + 2;
      return {
        color: Array.from({ length: pixels * 4 }, (_, i) =>
          i % 4 === 3 ? 1 : inBar((i / 4 | 0) % width) ? 1 : 0),
        depth: Array<number>(pixels).fill(12),
        motion: Array.from({ length: pixels * 2 }, (_, i) =>
          i % 2 === 0 && inBar((i / 2 | 0) % width) ? shift / width : 0) };
    };
    const run = (policy: ReprojectionPolicy) => {
      const starts = [4, 8, 12, 16, 16, 16, 16];
      const resolved: Float32Array[] = [], ideal: Array<readonly number[]> = [];
      let previousColor: ArrayLike<number> | undefined, previousDepth: ArrayLike<number> | undefined;
      for (let frame = 0; frame < 7; frame++) {
        const current = moveStopFrame(starts[frame]!, frame < 4 ? 4 : 0);
        resolved.push(accumulateTemporalFrame({ width, height, ...current,
          ...(previousColor ? { previousColor, previousDepth } : {}), currentJitter: jitter, previousJitter: jitter,
          historyValid: frame > 0 }, options, policy));
        ideal.push(current.color);
        previousColor = Array.from(resolved[frame]!); previousDepth = current.depth;
      }
      return measureGhostSequence(resolved.slice(4), ideal.slice(4), 1);
    };
    const guarded = run(GHOST_GUARD_REPROJECTION_POLICY);
    const baseline = run(BASELINE_REPROJECTION_POLICY);
    // AA-M2 gate on the second scene type; the decision layer must beat the baseline here
    // (the stale motion trail is exactly the matching-depth content change the decay targets).
    expect(guarded.energies[2]).toBeLessThan(0.01);
    expect(guarded.energies[2]).toBeLessThan(baseline.energies[2]);
    expect(guarded.passesWithin3Frames).toBe(true);
  });

  it("rejects invalid reprojection inputs", () => {
    expect(() => ghostEnergy([0, 0, 0, 1], [0, 0, 0, 1], 0)).toThrow();
    expect(() => ghostEnergy([0, 0, 0, 1], [0, 0, 0, 1, 0, 1, 0, 1], 1)).toThrow();
    expect(() => measureGhostSequence([], [], 1)).toThrow();
    expect(() => neighborhoodVarianceLuma([0, 0, 0], 4, 1, 0, 0)).not.toThrow();
  });
});

describe("GHOST_GUARD WGSL wiring single source (AA-M2 follow-up slice)", () => {
  it("derives the decision fragment from the policy constants (no duplicated hardcode)", () => {
    const { fallbackAcceptedRatio, maxHistoryError, decayFactor } = GHOST_GUARD_REPROJECTION_POLICY;
    const fragment = deriveTemporalGhostGuardWgsl("coordinate", "size",
      "            var feedback = temporalParams.tuning.x * (1.0 - reactive);");
    expect(fragment).toContain(`if (acceptedRatio < ${fallbackAcceptedRatio}) {`);
    expect(fragment).toContain(`if (historyError > ${maxHistoryError}) { feedback = feedback * ${decayFactor}; }`);
    // 判据次序与 CPU 决策分支一致:box fallback(disocclusion)优先于 historyError decay。
    expect(fragment.indexOf("acceptedRatio")).toBeLessThan(fragment.indexOf("historyError"));
    // box fallback 不含 feedback(clamp 收紧时直接取当前帧邻域),decay 分支 feedback 先 reactive 后 decay。
    expect(fragment.split("resolved = max(boxMean")).toHaveLength(2);
    expect(fragment).toContain("resolved = mix(color.rgb, clampedHistory, feedback);");
  });

  it("flips the compile-time switch exactly once and fail-fasts on drift", () => {
    expect(TEMPORAL_GHOST_GUARD_CONST_OFF).toBe("const DEEP_TEMPORAL_GHOST_GUARD: u32 = 0u;");
    expect(TEMPORAL_GHOST_GUARD_CONST_ON).toBe("const DEEP_TEMPORAL_GHOST_GUARD: u32 = 1u;");
    const sample = `fn f() {\n  ${TEMPORAL_GHOST_GUARD_CONST_OFF}\n}`;
    const enabled = enableTemporalGhostGuardWgsl(sample);
    expect(enabled).toContain(TEMPORAL_GHOST_GUARD_CONST_ON);
    expect(enabled.length).toBe(sample.length);
    expect(() => enableTemporalGhostGuardWgsl(enabled)).toThrow("drifted");
    expect(() => enableTemporalGhostGuardWgsl("no constant here")).toThrow("drifted");
  });
});
