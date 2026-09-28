import { describe, expect, it } from "vitest";
import { applyResponseFeedback, buildTemporalResponseMask, verifyCameraCutHistoryClear, type FrameSlice } from "./temporalResponseMask.js";

const width = 16, height = 16, pixels = width * height;
const options = { feedback: 0.9, depthThreshold: 0.1, relativeDepthThreshold: 0.05 } as const;
const flat = (value: number) => Array<number>(pixels).fill(value);
const rgba = (gray: number) => Array.from({ length: pixels * 4 }, (_, index) => index % 4 === 3 ? 1 : gray);

function baseInput(changes: Partial<Parameters<typeof buildTemporalResponseMask>[0]> = {}) {
  return { width, height, currentDepth: flat(4), previousDepth: flat(4), motionUv: Array<number>(pixels * 2).fill(0),
    historyValid: true, cameraCut: false, motionAvailable: true, depthThreshold: options.depthThreshold,
    relativeDepthThreshold: options.relativeDepthThreshold, ...changes };
}

describe("temporal response masks (T07)", () => {
  it("masks the entire frame on a camera cut, missing history, or missing motion", () => {
    for (const changes of [{ cameraCut: true }, { historyValid: false }, { motionAvailable: false }]) {
      const mask = buildTemporalResponseMask(baseInput(changes));
      expect(Array.from(mask.mask)).toEqual(Array<number>(pixels).fill(255));
      expect(mask.fullResponsePixels).toBe(pixels);
    }
    const cut = buildTemporalResponseMask(baseInput({ cameraCut: true }));
    expect(cut.reasons["camera-cut"]).toBe(pixels);
    const noHistory = buildTemporalResponseMask(baseInput({ historyValid: false }));
    expect(noHistory.reasons["no-history"]).toBe(pixels);
    const noMotion = buildTemporalResponseMask(baseInput({ motionAvailable: false }));
    expect(noMotion.reasons["motion-unavailable"]).toBe(pixels);
  });

  it("marks disocclusion only where the reprojected history depth disagrees", () => {
    const previousDepth = flat(4);
    // Motion shifts +2 px on x for every pixel; columns 12..15 keep depth 9 (background).
    const motionUv = Array<number>(pixels * 2).fill(0);
    for (let pixel = 0; pixel < pixels; pixel++) motionUv[pixel * 2] = 2 / width;
    for (let x = 12; x < width; x++) for (let y = 0; y < height; y++) previousDepth[y * width + x] = 9;
    const mask = buildTemporalResponseMask(baseInput({ motionUv, previousDepth }));
    // The +2px reproject lands on column x+2: columns >= 10 sample the revealed background.
    for (let x = 10; x < width; x++) for (let y = 0; y < height; y++) expect(mask.mask[y * width + x]).toBe(255);
    for (let x = 0; x < 10; x++) for (let y = 0; y < height; y++) expect(mask.mask[y * width + x]).toBe(0);
    expect(mask.reasons.disocclusion).toBe(6 * height);
    expect(mask.partialResponsePixels).toBe(0);
  });

  it("scales feedback for transparent and particle coverage without hiding disocclusion", () => {
    const reactiveAlpha = new Uint8Array(pixels);
    for (let pixel = 0; pixel < pixels; pixel++) reactiveAlpha[pixel] = pixel % 2 === 0 ? 128 : 0;
    const previousDepth = flat(9);
    const mask = buildTemporalResponseMask(baseInput({ reactiveAlpha, previousDepth }));
    expect(mask.reasons["reactive-motion"]).toBe(pixels / 2);
    expect(mask.reasons.disocclusion).toBe(pixels);
    // Disocclusion (255) wins over reactive coverage on the same pixel.
    expect(mask.mask[0]).toBe(255);
    // With matching depth the reactive coverage alone drives a partial response value.
    const coverageOnly = buildTemporalResponseMask(baseInput({ reactiveAlpha, previousDepth: flat(4) }));
    expect(coverageOnly.reasons.disocclusion).toBe(0);
    expect(Array.from(coverageOnly.mask)).toEqual(Array.from({ length: pixels }, (_, pixel) => pixel % 2 === 0 ? 128 : 0));
    expect(coverageOnly.partialResponsePixels).toBe(pixels / 2);
    const opaque = buildTemporalResponseMask(baseInput({ reactiveAlpha: new Uint8Array(pixels).fill(64), previousDepth: flat(4) }));
    expect(Array.from(opaque.mask)).toEqual(Array<number>(pixels).fill(64));
    expect(opaque.partialResponsePixels).toBe(pixels);
    expect(applyResponseFeedback(0.9, 64)).toBeCloseTo(0.9 * (1 - 64 / 255), 12);
    expect(applyResponseFeedback(0.9, 0)).toBeCloseTo(0.9, 12);
    expect(applyResponseFeedback(0.9, 255)).toBe(0);
    expect(() => applyResponseFeedback(1, 0)).toThrow();
    expect(() => applyResponseFeedback(0.5, 256)).toThrow();
  });

  it("clears stale history within one frame on a camera cut", () => {
    const white = rgba(1), black = rgba(0);
    const depth = flat(4), motion = Array<number>(pixels * 2).fill(0);
    const jitter: readonly [number, number] = [0, 0];
    const frames: FrameSlice[] = [
      { color: white, depth, motion, historyValid: false, currentJitter: jitter, previousJitter: jitter },
      { color: white, depth, motion, previousColor: white, previousDepth: depth, historyValid: true,
        currentJitter: jitter, previousJitter: jitter },
      { color: black, depth, motion, previousColor: white, previousDepth: depth, historyValid: true, cameraCut: true,
        currentJitter: jitter, previousJitter: jitter },
    ];
    const proof = verifyCameraCutHistoryClear(width, height, frames, options);
    expect(proof.clearedInOneFrame).toBe(true);
    expect(proof.cutFrame).toBe(2);
    expect(proof.cutResidual).toBe(0);
    expect(proof.frames[0]!.residualToCurrent).toBe(0);
    expect(proof.frames[1]!.residualToCurrent).toBe(0);
    // Control: an inverted half-plane flip without a cut keeps stale history on the single
    // boundary column whose clamp window stays open (x=7), so the mean residual is 0.9/16.
    const flipped = Array.from({ length: pixels * 4 }, (_, index) => index % 4 === 3 ? 1 : (index / 4 | 0) % width < 8 ? 0 : 1);
    const withoutCut = verifyCameraCutHistoryClear(width, height, [frames[0]!, frames[1]!,
      { ...frames[2]!, cameraCut: false, color: flipped }], options);
    expect(withoutCut.clearedInOneFrame).toBe(false);
    expect(withoutCut.frames[2]!.residualToCurrent).toBeCloseTo(0.9 / width, 6);
  });

  it("rejects invalid mask inputs", () => {
    expect(() => buildTemporalResponseMask(baseInput({ width: 0 }))).toThrow();
    expect(() => buildTemporalResponseMask(baseInput({ currentDepth: [] }))).toThrow();
    expect(() => buildTemporalResponseMask(baseInput({ motionUv: [] }))).toThrow();
    expect(() => verifyCameraCutHistoryClear(width, height, [], options)).toThrow();
  });
});
