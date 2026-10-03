import type { PathTraceReferenceKernel } from "./pathTraceReferenceKernel.js";
import { sampleBrightness } from "./pathTraceReferenceKernel.js";
import { validatePathTraceRgb } from "./pathTraceCpuTypes.js";

/** Half-open row interval [start, end). */
export interface PathTraceRowRange { readonly start: number; readonly end: number }

/**
 * Round-robin stripes balance cost across bands (sky rows are cheap, geometry rows are not).
 * One band collapses to the single range [0, height), preserving the legacy pixel order.
 */
export function partitionPathTraceRows(height: number, bands: number, stripeRows = 4): readonly (readonly PathTraceRowRange[])[] {
  if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(bands) || bands < 1
    || !Number.isSafeInteger(stripeRows) || stripeRows < 1) {
    throw new RangeError("Path trace row partition requires positive integer height, bands and stripeRows.");
  }
  const stripeCount = Math.ceil(height / stripeRows), count = Math.min(bands, stripeCount);
  const result: PathTraceRowRange[][] = Array.from({ length: count }, () => []);
  for (let stripe = 0; stripe < stripeCount; stripe++) {
    const start = stripe * stripeRows, end = Math.min(height, start + stripeRows), owner = result[stripe % count]!;
    const last = owner[owner.length - 1];
    if (last && last.end === start) owner[owner.length - 1] = { start: last.start, end };
    else owner.push({ start, end });
  }
  return result;
}

export function pathTraceBandRowCount(ranges: readonly PathTraceRowRange[]): number {
  return ranges.reduce((sum, range) => sum + range.end - range.start, 0);
}

/** Copies packed band rows (row-major, `channels` per pixel) into their place in a full-frame plane. */
export function scatterPathTraceBandRows<T extends Float32Array | Uint8ClampedArray>(
  ranges: readonly PathTraceRowRange[], packed: T, width: number, channels: number, target: T): void {
  let source = 0;
  for (const range of ranges) {
    const length = (range.end - range.start) * width * channels;
    target.set(packed.subarray(source, source + length), range.start * width * channels);
    source += length;
  }
}

export interface PathTraceCpuBandOptions {
  readonly width: number;
  readonly height: number;
  readonly ranges: readonly PathTraceRowRange[];
  readonly sampleSeed?: number;
  /** Resolved brightnessFloor of the owning session config. */
  readonly brightnessFloor: number;
}

/**
 * Row-subset twin of PathTraceCpuRender.advance(1): same per-pixel Welford update, same kernel call
 * (x, y, ordinal, seed), so every pixel is bit-identical to the full-frame render for any partition.
 * Convergence/session accounting stays with the coordinator, which sums `advanceSample()` partials.
 */
export class PathTraceCpuBand {
  private mean: Float32Array<ArrayBuffer> | undefined;
  private m2: Float32Array<ArrayBuffer> | undefined;
  private samples = 0;
  readonly pixelCount: number;

  constructor(private readonly kernel: PathTraceReferenceKernel, private readonly options: PathTraceCpuBandOptions) {
    if (!kernel || typeof kernel.traceSample !== "function") throw new TypeError("CPU path trace kernel is required.");
    this.pixelCount = pathTraceBandRowCount(options.ranges) * options.width;
    this.mean = new Float32Array(this.pixelCount * 3);
    this.m2 = new Float32Array(this.mean.length);
  }

  get sampleCount(): number { return this.samples; }

  /** Traces one sample ordinal for every owned pixel; returns this band's share of the full-frame brightness. */
  advanceSample(signal?: AbortSignal): number {
    if (!this.mean || !this.m2) throw new Error("CPU path trace band is disposed.");
    const { width, height, ranges, sampleSeed = 0 } = this.options, ordinal = this.samples;
    let brightness = 0, offset = 0;
    for (const range of ranges) for (let y = range.start; y < range.end; y++) {
      signal?.throwIfAborted();
      for (let x = 0; x < width; x++, offset += 3) {
        const rgb = this.kernel.traceSample(x, y, ordinal, sampleSeed);
        validatePathTraceRgb(rgb, "sample");
        brightness += sampleBrightness(rgb) / (width * height);
        for (let channel = 0; channel < 3; channel++) {
          const index = offset + channel, delta = rgb[channel]! - this.mean[index]!;
          this.mean[index]! += delta / (ordinal + 1);
          this.m2[index]! += delta * (rgb[channel]! - this.mean[index]!);
          if (!Number.isFinite(this.mean[index]) || !Number.isFinite(this.m2[index])) {
            throw new RangeError("CPU path trace accumulation exceeds float32 range.");
          }
        }
      }
    }
    this.samples++;
    return brightness;
  }

  /** Per-pixel gate input; the frame gate takes the maximum over all bands. */
  get maxRelativeStandardError(): number {
    const n = this.samples;
    if (!this.mean || !this.m2 || n < 2) return Infinity;
    let maximum = 0;
    for (let i = 0; i < this.mean.length; i++) {
      const error = Math.sqrt(Math.max(0, this.m2[i]!) / (n - 1) / n) / Math.max(this.mean[i]!, this.options.brightnessFloor);
      maximum = Math.max(maximum, error);
    }
    return maximum;
  }

  /** Packed copy (band rows in range order) so callers never retain the live plane. */
  meanRows(): Float32Array<ArrayBuffer> {
    if (!this.mean) throw new Error("CPU path trace band is disposed.");
    return this.mean.slice();
  }

  dispose(): void { this.mean = undefined; this.m2 = undefined; }
}
