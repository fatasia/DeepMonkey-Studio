import { describe, expect, it } from "vitest";
import { createPathTraceCpuKernel } from "./pathTraceCpuKernel.js";
import { PathTraceCpuBand, partitionPathTraceRows, scatterPathTraceBandRows } from "./pathTraceCpuBand.js";
import { PathTraceCpuRender } from "./pathTraceCpuRender.js";
import type { PathTraceRgb } from "./pathTraceCpuTypes.js";

const W = 9, H = 7, SEED = 0xdeadbeef;
const config = { width: W, height: H, maxSamples: 64, minSamples: 4, varianceThreshold: .5,
  maxAccumulationBytes: W * H * 24, sampleSeed: SEED };
const identity = { sceneRevision: 1, materialHash: "m", cameraHash: "c" };
const environment = (d: PathTraceRgb): PathTraceRgb => [Math.abs(d[0]) + .1, Math.abs(d[1]) + .2, Math.abs(d[2]) + .3];
const kernel = () => createPathTraceCpuKernel({ width: W, height: H,
  blas: { id: "empty", vertices: new Float32Array(), indices: new Uint32Array() }, materials: [],
  camera: { origin: [0, 0, 0], target: [0, 0, -1], up: [0, 1, 0], verticalFovDegrees: 60 }, environment });

function reference(samples: number) {
  const render = new PathTraceCpuRender(config);
  render.begin(identity, kernel()); render.advance(samples);
  const result = { image: render.image().data, noise: render.maxRelativeStandardError };
  render.dispose(); return result;
}
function parallel(bands: number, stripeRows: number, samples: number) {
  const parts = partitionPathTraceRows(H, bands, stripeRows), k = kernel();
  const workers = parts.map(ranges => new PathTraceCpuBand(k, { width: W, height: H, ranges, sampleSeed: SEED, brightnessFloor: 1 / 65535 }));
  const frames: number[] = [];
  for (let ordinal = 0; ordinal < samples; ordinal++) frames.push(workers.reduce((sum, band) => sum + band.advanceSample(), 0));
  const image = new Float32Array(W * H * 3);
  parts.forEach((ranges, index) => scatterPathTraceBandRows(ranges, workers[index]!.meanRows(), W, 3, image));
  const noise = Math.max(...workers.map(band => band.maxRelativeStandardError));
  workers.forEach(band => band.dispose());
  return { image, noise, frames };
}

describe("row-partitioned CPU path trace bands", () => {
  it("partitions every row exactly once and collapses one band to a single range", () => {
    expect(partitionPathTraceRows(H, 1)).toEqual([[{ start: 0, end: H }]]);
    const parts = partitionPathTraceRows(37, 5, 3), seen = new Array<number>(37).fill(0);
    for (const ranges of parts) for (const range of ranges) for (let y = range.start; y < range.end; y++) seen[y]!++;
    expect(seen.every(count => count === 1)).toBe(true);
    expect(partitionPathTraceRows(3, 8, 4)).toHaveLength(1);
    expect(() => partitionPathTraceRows(0, 1)).toThrow(RangeError);
  });
  it("one band is bit-identical to PathTraceCpuRender, including the per-pixel noise gate", () => {
    const expected = reference(17), actual = parallel(1, 4, 17);
    expect(actual.image).toEqual(expected.image);
    expect(actual.noise).toBe(expected.noise);
  });
  it.each([[2, 1], [3, 2], [4, 4], [8, 1]])("%i bands (stripe %i) reproduce the full-frame pixels and noise bit-for-bit", (bands, stripe) => {
    const expected = reference(17), actual = parallel(bands, stripe, 17);
    expect(actual.image).toEqual(expected.image);
    expect(actual.noise).toBe(expected.noise);
  });
  it("frame brightness partials sum to the single-band series within float rounding", () => {
    const one = parallel(1, 4, 6).frames, many = parallel(3, 1, 6).frames;
    many.forEach((value, index) => expect(value).toBeCloseTo(one[index]!, 12));
  });
  it("stops cleanly on abort and releases planes on dispose", () => {
    const controller = new AbortController(), band = new PathTraceCpuBand(kernel(), { width: W, height: H,
      ranges: [{ start: 0, end: H }], sampleSeed: SEED, brightnessFloor: 1 / 65535 });
    controller.abort();
    expect(() => band.advanceSample(controller.signal)).toThrow();
    band.dispose();
    expect(() => band.advanceSample()).toThrow(/disposed/);
  });
});
