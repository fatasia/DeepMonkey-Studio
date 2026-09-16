import type { TemporalAaCpuInput, TemporalAaOptions } from "./temporalAaTypes.js";

export function temporalAaJitter(revision: number): readonly [number, number] {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("TAA revision must be a nonnegative safe integer.");
  return Object.freeze([halton(revision + 1, 2) - 0.5, halton(revision + 1, 3) - 0.5]);
}
export function validateTemporalAaJitter(value: readonly [number, number], label = "TAA jitter"): void {
  if (!value || value.length !== 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1])
    || Math.abs(value[0]) > 0.5 || Math.abs(value[1]) > 0.5) throw new Error(`${label} must contain two finite pixel offsets inside [-0.5, 0.5].`);
}
function halton(index: number, base: number): number { let fraction = 1, result = 0; while (index > 0) { fraction /= base; result += fraction * (index % base); index = Math.floor(index / base); } return result; }
export function validateTemporalAaOptions(options: TemporalAaOptions): void {
  if (!Number.isFinite(options.feedback) || options.feedback < 0 || options.feedback > 0.99) throw new Error("TAA feedback must be inside [0, 0.99].");
  if (!Number.isFinite(options.depthThreshold) || options.depthThreshold < 0 || options.depthThreshold > 100) throw new Error("TAA depthThreshold must be inside [0, 100].");
  if (!Number.isFinite(options.relativeDepthThreshold) || options.relativeDepthThreshold < 0 || options.relativeDepthThreshold > 1) throw new Error("TAA relativeDepthThreshold must be inside [0, 1].");
}
const rgbToYCoCg = (r: number, g: number, b: number): [number, number, number] => [r * .25 + g * .5 + b * .25, r * .5 - b * .5, -r * .25 + g * .5 - b * .25];
const yCoCgToRgb = (y: number, co: number, cg: number): [number, number, number] => [y + co - cg, y + cg, y - co - cg];
const clamp = (v: number, low: number, high: number) => Math.max(low, Math.min(high, v));

/** Scalar reference matching depth-aware bilinear history and YCoCg neighborhood clamp. */
export function resolveTemporalAaCpu(input: TemporalAaCpuInput, options: TemporalAaOptions): Float32Array {
  validateTemporalAaOptions(options); validateTemporalAaJitter(input.currentJitter, "TAA currentJitter");
  validateTemporalAaJitter(input.previousJitter, "TAA previousJitter"); const pixels = input.width * input.height;
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1
    || input.color.length !== pixels * 4 || input.depth.length !== pixels || input.motion.length !== pixels * 2
    || !input.color.every(Number.isFinite) || !input.depth.every(value => Number.isFinite(value) && value >= 0) || !input.motion.every(Number.isFinite)) throw new Error("Invalid TAA CPU current-frame buffers.");
  if (input.historyValid && (!input.previousColor || !input.previousDepth || input.previousColor.length !== pixels * 4
    || input.previousDepth.length !== pixels || !input.previousColor.every(Number.isFinite) || !input.previousDepth.every(Number.isFinite))) throw new Error("Valid TAA history requires finite matching previous buffers.");
  const output = new Float32Array(input.color);
  if (!input.historyValid) return output;
  for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
    const pixel = y * input.width + x, depth = input.depth[pixel]!; if (depth <= 0) continue;
    const px = x + .5 + input.motion[pixel * 2]! * input.width + input.previousJitter[0] - input.currentJitter[0];
    const py = y + .5 + input.motion[pixel * 2 + 1]! * input.height + input.previousJitter[1] - input.currentJitter[1];
    if (px < 0 || py < 0 || px >= input.width || py >= input.height) continue;
    const historicalColor = sampleHistory(input, px, py, depth,
      Math.max(options.depthThreshold, depth * options.relativeDepthThreshold));
    if (!historicalColor) continue;
    const minimum = [1e20, 1e20, 1e20], maximum = [-1e20, -1e20, -1e20];
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const neighbor = clamp(y + oy, 0, input.height - 1) * input.width + clamp(x + ox, 0, input.width - 1), offset = neighbor * 4;
      const value = rgbToYCoCg(input.color[offset]!, input.color[offset + 1]!, input.color[offset + 2]!);
      for (let channel = 0; channel < 3; channel++) { minimum[channel] = Math.min(minimum[channel]!, value[channel]!); maximum[channel] = Math.max(maximum[channel]!, value[channel]!); }
    }
    const history = rgbToYCoCg(...historicalColor);
    const clamped = yCoCgToRgb(...history.map((value, channel) => clamp(value, minimum[channel]!, maximum[channel]!)) as [number, number, number]);
    const offset = pixel * 4; for (let channel = 0; channel < 3; channel++) output[offset + channel] = Math.max(0, input.color[offset + channel]! * (1 - options.feedback) + clamped[channel]! * options.feedback);
  }
  return output;
}

function sampleHistory(input: TemporalAaCpuInput, px: number, py: number, depth: number,
  threshold: number): [number, number, number] | undefined {
  const sx = px - 0.5, sy = py - 0.5, x0 = Math.floor(sx), y0 = Math.floor(sy);
  const fx = sx - x0, fy = sy - y0;
  const color: [number, number, number] = [0, 0, 0];
  let acceptedWeight = 0;
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
    const weight = (x === 0 ? 1 - fx : fx) * (y === 0 ? 1 - fy : fy);
    const pixel = clamp(y0 + y, 0, input.height - 1) * input.width + clamp(x0 + x, 0, input.width - 1);
    const historicalDepth = input.previousDepth![pixel]!;
    if (weight <= 0 || historicalDepth <= 0 || Math.abs(historicalDepth - depth) > threshold) continue;
    for (let channel = 0; channel < 3; channel++) color[channel] = color[channel]! + input.previousColor![pixel * 4 + channel]! * weight;
    acceptedWeight += weight;
  }
  if (acceptedWeight <= 0) return undefined;
  return color.map(value => value / acceptedWeight) as [number, number, number];
}
