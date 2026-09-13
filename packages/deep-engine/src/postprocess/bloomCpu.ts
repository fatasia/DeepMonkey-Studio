import type { BloomLevelSize, BloomOptions } from "./bloomTypes.js";

const MAX_HDR_VALUE = 65_504;
const MAX_BLOOM_INTENSITY = 16;
const MIN_LEVELS = 4;
const MAX_LEVELS = 12;

export function validateBloomOptions(options: BloomOptions): void {
  if (!options || !Number.isFinite(options.threshold) || options.threshold < 0 || options.threshold > MAX_HDR_VALUE) {
    throw new Error(`Bloom threshold must be finite and in [0, ${MAX_HDR_VALUE}].`);
  }
  if (!Number.isFinite(options.softKnee) || options.softKnee < 0 || options.softKnee > 1) {
    throw new Error("Bloom softKnee must be finite and in [0, 1].");
  }
  if (!Number.isFinite(options.intensity) || options.intensity < 0 || options.intensity > MAX_BLOOM_INTENSITY) {
    throw new Error(`Bloom intensity must be finite and in [0, ${MAX_BLOOM_INTENSITY}].`);
  }
  if (!Number.isSafeInteger(options.maxLevels) || options.maxLevels < MIN_LEVELS || options.maxLevels > MAX_LEVELS) {
    throw new Error(`Bloom maxLevels must be a safe integer in [${MIN_LEVELS}, ${MAX_LEVELS}].`);
  }
}

export function bloomPyramidSizes(width: number, height: number, maxLevels: number): readonly BloomLevelSize[] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Bloom source dimensions must be positive safe integers.");
  }
  if (!Number.isSafeInteger(maxLevels) || maxLevels < MIN_LEVELS || maxLevels > MAX_LEVELS) {
    throw new Error(`Bloom maxLevels must be a safe integer in [${MIN_LEVELS}, ${MAX_LEVELS}].`);
  }
  const levels: BloomLevelSize[] = [];
  let currentWidth = width, currentHeight = height;
  for (let index = 0; index < maxLevels; index += 1) {
    currentWidth = Math.max(1, Math.ceil(currentWidth / 2));
    currentHeight = Math.max(1, Math.ceil(currentHeight / 2));
    levels.push(Object.freeze({ width: currentWidth, height: currentHeight }));
    if (currentWidth === 1 && currentHeight === 1) break;
  }
  return Object.freeze(levels);
}

/** CPU reference for the threshold and soft-knee extraction transfer function. */
export function extractBloomColor(color: readonly [number, number, number], options: BloomOptions): readonly [number, number, number] {
  validateBloomOptions(options);
  if (!color.every(Number.isFinite)) throw new Error("Bloom source color must be finite.");
  const positive = color.map(value => Math.max(0, value)) as [number, number, number];
  const brightness = Math.max(...positive), knee = options.threshold * options.softKnee;
  let soft = 0;
  if (knee > 0) {
    const transition = Math.min(2 * knee, Math.max(0, brightness - options.threshold + knee));
    soft = transition * transition / (4 * knee);
  }
  const contribution = Math.max(brightness - options.threshold, soft) / Math.max(brightness, 0.00001);
  return Object.freeze(positive.map(value => Math.fround(value * contribution)) as [number, number, number]);
}

/** CPU reference for energy-preserving progressive pyramid reconstruction. */
export function combineBloomLevels(high: readonly [number, number, number], low: readonly [number, number, number]): readonly [number, number, number] {
  if (![...high, ...low].every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error("Bloom pyramid colors must be finite and non-negative.");
  }
  return Object.freeze(high.map((value, index) => Math.fround((value + low[index]!) * 0.5)) as [number, number, number]);
}
