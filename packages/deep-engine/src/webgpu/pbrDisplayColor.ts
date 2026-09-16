import { applyPbrColorGradingLinear, resolvePbrColorGrading, type PbrColorGradingOptions } from "./pbrColorGrading.js";
import type { PbrToneMapping } from "./pbrRendererFeatures.js";

export interface PbrDisplayColorOptions {
  readonly exposure: number;
  readonly toneMapping: PbrToneMapping;
  readonly colorGrading?: PbrColorGradingOptions;
}

/** CPU mirror used to encode render-pass clears when HDR output is fused into the scene pass. */
export function encodePbrDisplayColor(source: readonly [number, number, number],
  options: PbrDisplayColorOptions): readonly [number, number, number] {
  if (!source.every(Number.isFinite) || !Number.isFinite(options.exposure) || options.exposure <= 0) {
    throw new TypeError("PBR display color and exposure must be finite and exposure must be positive.");
  }
  const grading = resolvePbrColorGrading(options.colorGrading);
  const graded = neutral(grading) ? source : applyPbrColorGradingLinear(
    source.map(value => value * options.exposure) as [number, number, number], grading);
  const exposure = neutral(grading) ? options.exposure : 1;
  const mapped = options.toneMapping === "three-aces-r185"
    ? threeAces(graded, exposure) : deepAces(graded, exposure);
  return Object.freeze(mapped.map(linearToSrgb)) as readonly [number, number, number];
}

function neutral(value: ReturnType<typeof resolvePbrColorGrading>): boolean {
  return value.temperature === 0 && value.tint === 0 && value.contrast === 1 && value.saturation === 1;
}
function threeAces(source: readonly number[], exposure: number): number[] {
  const value = multiply([0.59719, 0.35458, 0.04823, 0.076, 0.90834, 0.01566,
    0.0284, 0.13383, 0.83777], source.map(entry => entry * exposure / 0.6));
  const fitted = value.map(entry => (entry * (entry + 0.0245786) - 0.000090537)
    / (entry * (0.983729 * entry + 0.432951) + 0.238081));
  return multiply([1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605,
    -0.00327, -0.07276, 1.07602], fitted).map(unit);
}
function deepAces(source: readonly number[], exposure: number): number[] {
  return source.map(entry => { const value = entry * exposure;
    return unit((value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14)); });
}
function multiply(matrix: readonly number[], value: readonly number[]): number[] {
  return [matrix[0]! * value[0]! + matrix[1]! * value[1]! + matrix[2]! * value[2]!,
    matrix[3]! * value[0]! + matrix[4]! * value[1]! + matrix[5]! * value[2]!,
    matrix[6]! * value[0]! + matrix[7]! * value[1]! + matrix[8]! * value[2]!];
}
function linearToSrgb(value: number): number {
  const positive = Math.max(0, value); return positive <= 0.0031308 ? positive * 12.92 : 1.055 * positive ** (1 / 2.4) - 0.055;
}
function unit(value: number): number { return Math.min(1, Math.max(0, value)); }
