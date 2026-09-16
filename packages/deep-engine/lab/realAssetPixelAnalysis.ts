import type { SurfacePixels } from "./assetPixelReadback.js";

type Rgb = readonly [number, number, number];
export interface ForegroundSample {
  readonly pixels: number;
  readonly coverage: number;
  readonly meanRgb: Rgb;
  readonly luminance: number;
}
export interface TextureEncodingEvidence {
  readonly rows: readonly (readonly ForegroundSample[])[];
}
export interface AlphaModeEvidence {
  readonly opaqueBackgroundResponse: number;
  readonly blendBackgroundResponse: number;
  readonly maskCoverage: readonly [number, number, number];
}
export interface SurfaceDifference {
  readonly pixels: number;
  readonly changedFraction: number;
  readonly meanDistance: number;
}
export interface MetallicRoughnessTransformEvidence {
  readonly uv0: ForegroundSample;
  readonly uv1: ForegroundSample;
  readonly reference: ForegroundSample;
  readonly ignoredTransform: ForegroundSample;
  readonly uv0ToReference: SurfaceDifference;
  readonly uv1ToReference: SurfaceDifference;
  readonly repeatedDifference: SurfaceDifference;
  readonly transformedToIgnored: SurfaceDifference;
  readonly transformedChecksum: string;
  readonly repeatedChecksum: string;
  readonly ignoredChecksum: string;
  readonly decodedLinearSemantic: boolean;
  readonly decodedUv1Transform: boolean;
}

const luma = (rgb: Rgb): number => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;

function compatible(left: SurfacePixels, right: SurfacePixels): void {
  if (left.width !== right.width || left.height !== right.height
    || left.rgba.length !== left.width * left.height * 4
    || right.rgba.length !== right.width * right.height * 4) {
    throw new Error("Asset pixel surfaces must have matching, tightly packed RGBA8 dimensions.");
  }
}

/** Measures pixels changed by geometry inside a central crop, excluding clear/floor-only pixels. */
export function foregroundSample(subject: SurfacePixels, baseline: SurfacePixels): ForegroundSample {
  compatible(subject, baseline);
  const x0 = Math.floor(subject.width * 0.18), x1 = Math.ceil(subject.width * 0.82);
  const y0 = Math.floor(subject.height * 0.12), y1 = Math.ceil(subject.height * 0.88);
  let pixels = 0, r = 0, g = 0, b = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const offset = (y * subject.width + x) * 4;
    const delta = Math.abs(subject.rgba[offset]! - baseline.rgba[offset]!)
      + Math.abs(subject.rgba[offset + 1]! - baseline.rgba[offset + 1]!)
      + Math.abs(subject.rgba[offset + 2]! - baseline.rgba[offset + 2]!);
    if (delta < 24) continue;
    pixels++; r += subject.rgba[offset]!; g += subject.rgba[offset + 1]!; b += subject.rgba[offset + 2]!;
  }
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  const meanRgb: Rgb = pixels ? [r / pixels / 255, g / pixels / 255, b / pixels / 255] : [0, 0, 0];
  return Object.freeze({ pixels, coverage: pixels / area, meanRgb: Object.freeze(meanRgb), luminance: luma(meanRgb) });
}

/** Measures how much an isolated object's output changes when only the clear/floor color changes. */
export function backgroundResponse(
  darkSubject: SurfacePixels,
  lightSubject: SurfacePixels,
  darkBaseline: SurfacePixels,
  lightBaseline: SurfacePixels,
): number {
  compatible(darkSubject, lightSubject); compatible(darkSubject, darkBaseline); compatible(darkSubject, lightBaseline);
  let total = 0, pixels = 0;
  for (let offset = 0; offset < darkSubject.rgba.length; offset += 4) {
    const darkDelta = rgbDistance(darkSubject.rgba, darkBaseline.rgba, offset);
    const lightDelta = rgbDistance(lightSubject.rgba, lightBaseline.rgba, offset);
    // Use the intersection of strong foreground pixels so subpixel silhouette jitter is not
    // mistaken for an opaque material responding to the clear color.
    if (darkDelta < 48 || lightDelta < 48) continue;
    total += rgbDistance(darkSubject.rgba, lightSubject.rgba, offset) / 765; pixels++;
  }
  return pixels ? total / pixels : 1;
}

/** Compares only the union of foreground pixels so clear color cannot dilute a texture delta. */
export function foregroundDifference(subject: SurfacePixels, reference: SurfacePixels,
  baseline: SurfacePixels): SurfaceDifference {
  compatible(subject, reference); compatible(subject, baseline);
  let pixels = 0, changed = 0, total = 0;
  for (let offset = 0; offset < subject.rgba.length; offset += 4) {
    if (rgbDistance(subject.rgba, baseline.rgba, offset) < 24
      && rgbDistance(reference.rgba, baseline.rgba, offset) < 24) continue;
    const difference = rgbDistance(subject.rgba, reference.rgba, offset);
    pixels++; total += difference; if (difference >= 24) changed++;
  }
  return Object.freeze({ pixels, changedFraction: changed / Math.max(1, pixels),
    meanDistance: total / Math.max(1, pixels) / 765 });
}

export function evaluateTextureEncoding(evidence: TextureEncodingEvidence): boolean {
  if (evidence.rows.length !== 3 || evidence.rows.some(row => row.length !== 4)) return false;
  return evidence.rows.every(row => {
    const reference = row[0]!;
    if (reference.pixels < 64 || reference.coverage < 0.005 || reference.luminance < 0.01) return false;
    return row.slice(1).every(sample => sample.pixels >= 64
      && relative(sample.coverage, reference.coverage) <= 0.18
      && relative(sample.luminance, reference.luminance) <= 0.15
      && colorDistance(sample.meanRgb, reference.meanRgb) <= 0.16);
  });
}

export function evaluateAlphaModes(evidence: AlphaModeEvidence): boolean {
  const [low, defaultCutoff, high] = evidence.maskCoverage;
  return [evidence.opaqueBackgroundResponse, evidence.blendBackgroundResponse, low, defaultCutoff, high]
    .every(Number.isFinite)
    && evidence.opaqueBackgroundResponse <= 0.12
    && evidence.blendBackgroundResponse >= 0.06
    && evidence.blendBackgroundResponse >= evidence.opaqueBackgroundResponse * 1.5
    && evidence.blendBackgroundResponse >= evidence.opaqueBackgroundResponse + 0.04
    && low > defaultCutoff * 1.05 && defaultCutoff > high * 1.05 && high > 0.002;
}

export function evaluateMetallicRoughnessTransform(evidence: MetallicRoughnessTransformEvidence): boolean {
  const samples = [evidence.uv0, evidence.uv1, evidence.reference, evidence.ignoredTransform];
  const references = [evidence.uv0ToReference, evidence.uv1ToReference];
  return evidence.decodedLinearSemantic && evidence.decodedUv1Transform
    && samples.every(sample => sample.pixels >= 64 && sample.coverage >= 0.005)
    && evidence.transformedChecksum !== evidence.ignoredChecksum
    && references.every(delta => delta.pixels >= 64 && delta.meanDistance <= 0.12)
    && evidence.repeatedDifference.pixels >= 64 && evidence.repeatedDifference.meanDistance <= 0.04
    && evidence.transformedToIgnored.pixels >= 64
    && evidence.transformedToIgnored.changedFraction >= evidence.repeatedDifference.changedFraction + 0.05
    && evidence.transformedToIgnored.meanDistance >= Math.max(0.01, evidence.repeatedDifference.meanDistance + 0.005);
}

const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.max(0.02, Math.abs(reference));
const colorDistance = (left: Rgb, right: Rgb): number =>
  (Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2])) / 3;
const rgbDistance = (left: Uint8Array, right: Uint8Array, offset: number): number =>
  Math.abs(left[offset]! - right[offset]!) + Math.abs(left[offset + 1]! - right[offset + 1]!)
  + Math.abs(left[offset + 2]! - right[offset + 2]!);
