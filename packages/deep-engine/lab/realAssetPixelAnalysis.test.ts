import { describe, expect, it } from "vitest";
import {
  backgroundResponse, evaluateAlphaModes, evaluateMetallicRoughnessTransform,
  evaluateTextureEncoding, foregroundDifference, foregroundSample,
  type ForegroundSample,
} from "./realAssetPixelAnalysis.js";
import type { SurfacePixels } from "./assetPixelReadback.js";

function surface(width: number, height: number, pixel: (x: number, y: number) => readonly number[]): SurfacePixels {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4);
  return { width, height, rgba, checksum: "fixture" };
}
const sample = (luminance: number, coverage = 0.2): ForegroundSample => ({
  pixels: 200, coverage, meanRgb: [luminance, luminance, luminance], luminance,
});

describe("real asset pixel analysis", () => {
  it("extracts central foreground while excluding identical clear pixels", () => {
    const baseline = surface(20, 20, () => [10, 10, 10, 255]);
    const subject = surface(20, 20, (x, y) => x >= 7 && x < 13 && y >= 7 && y < 13
      ? [210, 80, 40, 255] : [10, 10, 10, 255]);
    const result = foregroundSample(subject, baseline);
    expect(result.pixels).toBe(36);
    expect(result.meanRgb[0]).toBeCloseTo(210 / 255, 6);
    expect(result.luminance).toBeGreaterThan(result.meanRgb[1]);
    expect(() => foregroundSample(subject, surface(19, 20, () => [10, 10, 10, 255])))
      .toThrow("matching, tightly packed");
  });

  it("accepts three four-way equivalent encoding rows and rejects a double-decoded sRGB column", () => {
    const good = { rows: [[sample(0.32), sample(0.31), sample(0.33), sample(0.3)],
      [sample(0.62), sample(0.6), sample(0.61), sample(0.64)],
      [sample(0.47), sample(0.45), sample(0.49), sample(0.46)]] };
    expect(evaluateTextureEncoding(good)).toBe(true);
    expect(evaluateTextureEncoding({ rows: good.rows.map((row, index) => index === 0
      ? [row[0]!, row[1]!, sample(0.12), row[3]!] : row) })).toBe(false);
    expect(evaluateTextureEncoding({ rows: [[sample(0.3)]] })).toBe(false);
  });

  it("distinguishes opaque output from background-responsive blend output", () => {
    const darkBase = surface(16, 16, () => [8, 8, 8, 255]);
    const lightBase = surface(16, 16, () => [220, 220, 220, 255]);
    const opaqueDark = surface(16, 16, (x, y) => x > 3 && x < 12 && y > 3 && y < 12 ? [180, 80, 20, 255] : [8, 8, 8, 255]);
    const opaqueLight = surface(16, 16, (x, y) => x > 3 && x < 12 && y > 3 && y < 12 ? [180, 80, 20, 255] : [220, 220, 220, 255]);
    const blendDark = surface(16, 16, (x, y) => x > 3 && x < 12 && y > 3 && y < 12 ? [94, 44, 14, 255] : [8, 8, 8, 255]);
    const blendLight = surface(16, 16, (x, y) => x > 3 && x < 12 && y > 3 && y < 12 ? [200, 150, 120, 255] : [220, 220, 220, 255]);
    const opaque = backgroundResponse(opaqueDark, opaqueLight, darkBase, lightBase);
    const blend = backgroundResponse(blendDark, blendLight, darkBase, lightBase);
    expect(opaque).toBe(0); expect(blend).toBeGreaterThan(0.1);
    expect(evaluateAlphaModes({ opaqueBackgroundResponse: opaque, blendBackgroundResponse: blend,
      maskCoverage: [0.3, 0.2, 0.1] })).toBe(true);
    expect(evaluateAlphaModes({ opaqueBackgroundResponse: 0.08, blendBackgroundResponse: 0.145,
      maskCoverage: [0.3, 0.2, 0.1] })).toBe(true);
    expect(evaluateAlphaModes({ opaqueBackgroundResponse: blend, blendBackgroundResponse: opaque,
      maskCoverage: [0.2, 0.2, 0.2] })).toBe(false);
  });

  it("requires repeat-stable transformed MR output, a reference match and a distinct ignored-transform control", () => {
    const baseline = surface(20, 20, () => [8, 8, 8, 255]);
    const transformed = surface(20, 20, (x, y) => x > 4 && x < 15 && y > 4 && y < 15
      ? [180, 150, 90, 255] : [8, 8, 8, 255]);
    const reference = surface(20, 20, (x, y) => x > 4 && x < 15 && y > 4 && y < 15
      ? [176, 148, 92, 255] : [8, 8, 8, 255]);
    const ignored = surface(20, 20, (x, y) => x > 4 && x < 15 && y > 4 && y < 15
      ? [60, 80, 190, 255] : [8, 8, 8, 255]);
    const evidence = { uv0: foregroundSample(transformed, baseline), uv1: foregroundSample(transformed, baseline),
      reference: foregroundSample(reference, baseline), ignoredTransform: foregroundSample(ignored, baseline),
      uv0ToReference: foregroundDifference(transformed, reference, baseline),
      uv1ToReference: foregroundDifference(transformed, reference, baseline),
      repeatedDifference: foregroundDifference(transformed, transformed, baseline),
      transformedToIgnored: foregroundDifference(transformed, ignored, baseline),
      transformedChecksum: "stable", repeatedChecksum: "stable", ignoredChecksum: "control",
      decodedLinearSemantic: true, decodedUv1Transform: true };
    expect(evaluateMetallicRoughnessTransform(evidence)).toBe(true);
    expect(evaluateMetallicRoughnessTransform({ ...evidence,
      repeatedDifference: { pixels: 100, changedFraction: 0.5, meanDistance: 0.08 } })).toBe(false);
    expect(evaluateMetallicRoughnessTransform({ ...evidence,
      transformedToIgnored: { pixels: 100, changedFraction: 0, meanDistance: 0 } })).toBe(false);
  });
});
