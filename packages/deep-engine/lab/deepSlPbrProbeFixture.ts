import type { DeepPbrMeshV1MaterialDefaults } from "@bim-studio/deep-engine/shader-authoring";

export const PBR_PROBE_WIDTH = 16;
export const PBR_PROBE_HEIGHT = 16;
export const PBR_PROBE_BYTES_PER_ROW = 256;
export const PBR_PROBE_CLEAR = Object.freeze([0.003, 0.007, 0.011, 1] as const);

export type DeepSlPbrProbeCaseId = "rough-red" | "rough-green" | "glossy-red";

export const DEEP_SL_PBR_PROBE_SOURCES: Readonly<Record<DeepSlPbrProbeCaseId, string>> = Object.freeze({
  "rough-red": `shader deep.probe {
  surface standard;
  baseColor [0.75, 0.08, 0.06, 1];
  metallic 0;
  roughness 0.8;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`,
  "rough-green": `shader deep.probe {
  surface standard;
  baseColor [0.08, 0.65, 0.06, 1];
  metallic 0;
  roughness 0.8;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`,
  "glossy-red": `shader deep.probe {
  surface standard;
  baseColor [0.75, 0.08, 0.06, 1];
  metallic 0;
  roughness 0.25;
  alpha opaque;
  doubleSided false;
  baseColorTexture off;
}`,
});

export function pbrProbeGeometry(): Float32Array {
  return new Float32Array([
    -1, -1, 0.5, 0, 0, 1, 0, 0, 0, 0,
    3, -1, 0.5, 0, 0, 1, 1, 0, 1, 0,
    -1, 3, 0.5, 0, 0, 1, 0, 1, 0, 1,
  ]);
}

export function pbrProbeInstance(material: DeepPbrMeshV1MaterialDefaults): Float32Array {
  const result = new Float32Array(36);
  result.set([1, 0, 0, 0], 0);
  result.set([0, 1, 0, 0], 4);
  result.set([0, 0, 1, 0], 8);
  result.set([1, 0, 0, 0], 12);
  result.set([0, 1, 0, 0], 16);
  result.set([0, 0, 1, 0], 20);
  result.set(material.baseColorMetallic, 24);
  result.set(material.roughnessAlphaCutoffHandednessFlags, 28);
  result.set(material.emissiveAlpha, 32);
  return result;
}

export function pbrProbeFrame(): Float32Array {
  const result = new Float32Array(52);
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  result.set(identity, 0);
  result.set(identity, 16);
  result.set([0, 0, 2, 1], 32);
  result.set([0.003, 0.007, 0.011, 1], 36);
  result.set([0, 0, 0, 1], 40);
  result.set([0, 0, 1, 0], 44);
  result.set([1, 0, 0, 0], 48);
  return result;
}

export function decodeFloat16Bits(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function decodePbrProbePixel(raw16: readonly number[]): readonly number[] {
  return Object.freeze(raw16.map(decodeFloat16Bits));
}

export interface DeepSlPbrPixelSample {
  readonly id: DeepSlPbrProbeCaseId;
  readonly pixel: readonly number[];
}

const luminance = (pixel: readonly number[]): number => pixel[0]! * 0.2126 + pixel[1]! * 0.7152 + pixel[2]! * 0.0722;

export function evaluatePbrProbe(samples: readonly DeepSlPbrPixelSample[]) {
  const byId = new Map(samples.map((sample) => [sample.id, sample.pixel]));
  const red = byId.get("rough-red") ?? [];
  const green = byId.get("rough-green") ?? [];
  const glossy = byId.get("glossy-red") ?? [];
  const finite = samples.length === 3 && samples.every((sample) => sample.pixel.length === 4
    && sample.pixel.every(Number.isFinite));
  const nonClear = finite && samples.every((sample) => Math.max(
    ...sample.pixel.map((value, index) => Math.abs(value - PBR_PROBE_CLEAR[index]!)),
  ) > 0.03);
  const baseColorDelta = Object.freeze({ red: green[0]! - red[0]!, green: green[1]! - red[1]! });
  const roughnessLuminanceDelta = luminance(glossy) - luminance(red);
  const baseColorDirection = finite && baseColorDelta.red < -0.12 && baseColorDelta.green > 0.12;
  const roughnessDirection = finite && roughnessLuminanceDelta > 0.12;
  const opaqueAlpha = finite && samples.every((sample) => Math.abs(sample.pixel[3]! - 1) <= 0.01);
  return Object.freeze({
    finite, nonClear, opaqueAlpha, baseColorDirection, roughnessDirection,
    baseColorDelta, roughnessLuminanceDelta,
    verified: finite && nonClear && opaqueAlpha && baseColorDirection && roughnessDirection,
  });
}
