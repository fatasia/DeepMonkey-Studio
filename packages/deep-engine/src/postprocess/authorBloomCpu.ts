import type { BloomLevelSize, BloomSource } from "./bloomTypes.js";

export interface AuthorBloomOptions { readonly strength: number; readonly threshold: number }
export const AUTHOR_BLOOM_RADII = [6, 10, 14, 18, 22] as const;
export const AUTHOR_BLOOM_WEIGHTS = [0.8, 0.7, 0.6, 0.5, 0.4] as const;

export function validateAuthorBloomOptions(options: AuthorBloomOptions): void {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Author bloom requires options.");
  if (Object.keys(options).some(key => key !== "strength" && key !== "threshold")) throw new TypeError("Unknown author bloom option.");
  for (const [key, maximum] of [["strength", 3], ["threshold", 1]] as const) {
    if (!Number.isFinite(options[key]) || options[key] < 0 || options[key] > maximum) {
      throw new RangeError(`Author bloom ${key} must be finite within 0..${maximum}.`);
    }
  }
}

export function authorBloomSizes(width: number, height: number): readonly BloomLevelSize[] {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError("Author bloom dimensions must be positive integers.");
  return Object.freeze(AUTHOR_BLOOM_RADII.map(() => {
    width = Math.max(1, Math.round(width / 2)); height = Math.max(1, Math.round(height / 2));
    return Object.freeze({ width, height });
  }));
}

export function authorBloomCoefficients(radius: number): readonly number[] {
  if (!(AUTHOR_BLOOM_RADII as readonly number[]).includes(radius)) throw new RangeError("Unknown author bloom kernel radius.");
  const sigma = radius / 3;
  return Object.freeze(Array.from({ length: radius }, (_, index) => 0.39894 * Math.exp(-0.5 * index * index / (sigma * sigma)) / sigma));
}

export function extractAuthorBloomColor(color: readonly [number, number, number], threshold: number): readonly number[] {
  validateAuthorBloomOptions({ strength: 0, threshold });
  if (color.length !== 3 || !color.every(Number.isFinite)) throw new TypeError("Author bloom requires finite RGB.");
  const luminance = color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722;
  const t = Math.max(0, Math.min(1, (luminance - threshold) / 0.01)), alpha = t * t * (3 - 2 * t);
  return Object.freeze(color.map(value => value * alpha));
}

export function validateAuthorBloomSource(device: GPUDevice, source: BloomSource): void {
  if (!source || source.colorEncoding !== "linear-hdr") throw new TypeError("Author bloom requires linear HDR color.");
  if (!Number.isSafeInteger(source.revision) || source.revision < 0) throw new RangeError("Author bloom revision must be a nonnegative safe integer.");
  const texture = source.color;
  if (!texture || texture.format !== "rgba16float") throw new TypeError("Author bloom requires rgba16float.");
  if (texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1) throw new TypeError("Author bloom requires a single-layer non-multisampled 2D texture.");
  if (!(texture.usage & GPUTextureUsage.TEXTURE_BINDING)) throw new TypeError("Author bloom requires TEXTURE_BINDING.");
  authorBloomSizes(texture.width, texture.height);
  if ([texture.width, texture.height].some(value => value > device.limits.maxTextureDimension2D
    || Math.ceil(value / 8) > device.limits.maxComputeWorkgroupsPerDimension)) throw new RangeError("Author bloom exceeds device limits.");
}
