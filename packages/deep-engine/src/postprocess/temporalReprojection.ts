import type { TemporalAaOptions } from "./temporalAaTypes.js";

/**
 * Per-pixel temporal reprojection reference with an explicit decision layer:
 * trusted temporal accumulation versus a 3x3 neighborhood fallback.
 *
 * The accumulation path is formula-identical to resolveTemporalAaCpu (depth-aware
 * bilinear history + YCoCg AABB clamp), and the default policy disables every
 * decision trigger, so the baseline output is bit-identical to the shipped TAA.
 * The decision layer adds the two ghost-fighting triggers the acceptance target
 * needs: low accepted-tap ratio (disocclusion with surviving taps) falls back to a
 * 3x3 box filter, and a large clamped-history error (content change on matching
 * depth, where depth rejection is blind) decays the feedback.
 */
export type ReprojectionMode = "temporal" | "temporal-decayed" | "neighborhood-fallback" | "current-only";

export interface ReprojectionPolicy {
  /** Accepted-weight ratio below this uses the 3x3 box fallback (disocclusion). */
  readonly fallbackAcceptedRatio: number;
  /** Mean |clampedHistory - current| (RGB) above this decays the feedback. */
  readonly maxHistoryError: number;
  /** Feedback multiplier applied while decayed; 0.35^3 keeps 3-frame ghost under 5%. */
  readonly decayFactor: number;
}

/** Disables every trigger: output is bit-identical to resolveTemporalAaCpu. */
export const BASELINE_REPROJECTION_POLICY: ReprojectionPolicy = Object.freeze({
  fallbackAcceptedRatio: 0, maxHistoryError: Infinity, decayFactor: 1 });
/**
 * Strong-contrast ghost policy: the decay threshold equals the 5%-of-contrast
 * acceptance line, so once the decaying residual (feedback * decayFactor per frame)
 * crosses it, full feedback resumes below the acceptance bound instead of rebounding.
 */
export const GHOST_GUARD_REPROJECTION_POLICY: ReprojectionPolicy = Object.freeze({
  fallbackAcceptedRatio: 0.25, maxHistoryError: 0.05, decayFactor: 0.35 });

export interface ReprojectionDecision {
  readonly mode: ReprojectionMode;
  readonly effectiveFeedback: number;
  readonly acceptedRatio: number;
  readonly neighborhoodVariance: number;
  readonly historyError: number;
}

export interface TemporalAccumulationInput {
  readonly width: number;
  readonly height: number;
  readonly color: readonly number[];
  readonly depth: readonly number[];
  readonly motion: readonly number[];
  readonly previousColor?: readonly number[];
  readonly previousDepth?: readonly number[];
  readonly currentJitter: readonly [number, number];
  readonly previousJitter: readonly [number, number];
  readonly historyValid: boolean;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const rgbToY = (r: number, g: number, b: number) => r * 0.25 + g * 0.5 + b * 0.25;
const rgbToYCoCg = (r: number, g: number, b: number): [number, number, number] => [r * .25 + g * .5 + b * .25, r * .5 - b * .5, -r * .25 + g * .5 - b * .25];
const yCoCgToRgb = (y: number, co: number, cg: number): [number, number, number] => [y + co - cg, y + cg, y - co - cg];

export function neighborhoodVarianceLuma(color: readonly number[], width: number, height: number, x: number, y: number): number {
  let mean = 0, square = 0;
  for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
    const offset = (clamp(y + oy, 0, height - 1) * width + clamp(x + ox, 0, width - 1)) * 4;
    const luma = rgbToY(color[offset]!, color[offset + 1]!, color[offset + 2]!);
    mean += luma / 9; square += luma * luma / 9;
  }
  return Math.max(0, square - mean * mean);
}

function sampleHistory(input: TemporalAccumulationInput, px: number, py: number, depth: number, threshold: number):
  { color: [number, number, number] | undefined; acceptedRatio: number } {
  const sx = px - 0.5, sy = py - 0.5, x0 = Math.floor(sx), y0 = Math.floor(sy);
  const fx = sx - x0, fy = sy - y0;
  const color: [number, number, number] = [0, 0, 0];
  let acceptedWeight = 0, totalWeight = 0;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const weight = (x === 0 ? 1 - fx : fx) * (y === 0 ? 1 - fy : fy);
    if (weight <= 0) continue;
    totalWeight += weight;
    const pixel = clamp(y0 + y, 0, input.height - 1) * input.width + clamp(x0 + x, 0, input.width - 1);
    const historicalDepth = input.previousDepth![pixel]!;
    if (historicalDepth <= 0 || Math.abs(historicalDepth - depth) > threshold) continue;
    for (let channel = 0; channel < 3; channel++) color[channel] = color[channel]! + input.previousColor![pixel * 4 + channel]! * weight;
    acceptedWeight += weight;
  }
  return { color: acceptedWeight <= 0 ? undefined : color.map(value => value / acceptedWeight) as [number, number, number],
    acceptedRatio: totalWeight <= 0 ? 0 : acceptedWeight / totalWeight };
}

/** One resolved frame with the reprojection decision layer applied per pixel. */
export function accumulateTemporalFrame(input: TemporalAccumulationInput, options: TemporalAaOptions,
  policy: ReprojectionPolicy = BASELINE_REPROJECTION_POLICY): Float32Array {
  return accumulateTemporalFrameDetailed(input, options, policy).output;
}

/** Same accumulation, also returning the per-pixel decision table for audit and tests. */
export function accumulateTemporalFrameDetailed(input: TemporalAccumulationInput, options: TemporalAaOptions,
  policy: ReprojectionPolicy = BASELINE_REPROJECTION_POLICY): { output: Float32Array; decisions: ReprojectionDecision[] } {
  const width = input.width, height = input.height;
  const output = new Float32Array(input.color);
  const decisions: ReprojectionDecision[] = [];
  if (!input.historyValid) return { output, decisions };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const pixel = y * width + x, depth = input.depth[pixel]!; if (depth <= 0) continue;
    const px = x + .5 + input.motion[pixel * 2]! * width + input.previousJitter[0] - input.currentJitter[0];
    const py = y + .5 + input.motion[pixel * 2 + 1]! * height + input.previousJitter[1] - input.currentJitter[1];
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const threshold = Math.max(options.depthThreshold, depth * options.relativeDepthThreshold);
    const { color: historicalColor, acceptedRatio } = sampleHistory(input, px, py, depth, threshold);
    const offset = pixel * 4, current = [input.color[offset]!, input.color[offset + 1]!, input.color[offset + 2]!];
    if (!historicalColor) continue;
    const minimum = [1e20, 1e20, 1e20], maximum = [-1e20, -1e20, -1e20];
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const neighbor = clamp(y + oy, 0, height - 1) * width + clamp(x + ox, 0, width - 1), neighborOffset = neighbor * 4;
      const value = rgbToYCoCg(input.color[neighborOffset]!, input.color[neighborOffset + 1]!, input.color[neighborOffset + 2]!);
      for (let channel = 0; channel < 3; channel++) { minimum[channel] = Math.min(minimum[channel]!, value[channel]!); maximum[channel] = Math.max(maximum[channel]!, value[channel]!); }
    }
    const history = rgbToYCoCg(...historicalColor);
    const clamped = yCoCgToRgb(...history.map((value, channel) => clamp(value, minimum[channel]!, maximum[channel]!)) as [number, number, number]);
    const historyError = (Math.abs(clamped[0] - current[0]!) + Math.abs(clamped[1] - current[1]!) + Math.abs(clamped[2] - current[2]!)) / 3;
    const variance = neighborhoodVarianceLuma(input.color, width, height, x, y);
    let feedback = options.feedback, mode: ReprojectionMode = "temporal";
    if (acceptedRatio < policy.fallbackAcceptedRatio) {
      mode = "neighborhood-fallback";
      const boxMean = [0, 0, 0];
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const neighbor = (clamp(y + oy, 0, height - 1) * width + clamp(x + ox, 0, width - 1)) * 4;
        for (let channel = 0; channel < 3; channel++) boxMean[channel] = (boxMean[channel] ?? 0) + input.color[neighbor + channel]! / 9;
      }
      for (let channel = 0; channel < 3; channel++) output[offset + channel] = Math.max(0, boxMean[channel] ?? 0);
    } else {
      if (historyError > policy.maxHistoryError) { mode = "temporal-decayed"; feedback *= policy.decayFactor; }
      for (let channel = 0; channel < 3; channel++) {
        output[offset + channel] = Math.max(0, current[channel]! * (1 - feedback) + clamped[channel]! * feedback);
      }
    }
    decisions.push({ mode, effectiveFeedback: feedback, acceptedRatio, neighborhoodVariance: variance, historyError });
  }
  return { output, decisions };
}

/** Mean normalized |output - ideal| over RGB divided by the source contrast. */
export function ghostEnergy(output: ArrayLike<number>, ideal: ArrayLike<number>, sourceContrast: number): number {
  if (sourceContrast <= 0 || !Number.isFinite(sourceContrast)) throw new Error("Ghost energy source contrast is invalid.");
  if (output.length !== ideal.length) throw new Error("Ghost energy buffers differ in size.");
  let residual = 0, samples = 0;
  for (let offset = 0; offset < output.length; offset += 4) {
    for (let channel = 0; channel < 3; channel++) residual += Math.abs(output[offset + channel]! - ideal[offset + channel]!);
    samples++;
  }
  return samples === 0 ? 0 : residual / (samples * 3 * sourceContrast);
}

export interface GhostSequenceReport {
  readonly energies: readonly number[];
  readonly sourceContrast: number;
  readonly threshold: number;
  readonly passesWithin3Frames: boolean;
  readonly firstPassingFrame: number | undefined;
}

/**
 * Ghost energies for a content-change sequence; frame 0 is the first frame after the
 * change. Acceptance ("3 帧内低于源对比度 5%") requires the third post-change frame
 * (index 2) below 0.05; a sequence passes early as soon as some frame meets it.
 */
export function measureGhostSequence(resolved: readonly Float32Array[], ideal: readonly (readonly number[])[],
  sourceContrast: number, threshold = 0.05): GhostSequenceReport {
  if (resolved.length !== ideal.length || resolved.length === 0) throw new Error("Ghost sequence frame counts differ.");
  const energies = resolved.map((frame, index) => ghostEnergy(frame, ideal[index]!, sourceContrast));
  const firstPassingFrame = energies.findIndex(energy => energy < threshold);
  return Object.freeze({ energies: Object.freeze(energies), sourceContrast, threshold,
    passesWithin3Frames: firstPassingFrame >= 0 && firstPassingFrame <= 2,
    firstPassingFrame: firstPassingFrame >= 0 ? firstPassingFrame : undefined });
}
