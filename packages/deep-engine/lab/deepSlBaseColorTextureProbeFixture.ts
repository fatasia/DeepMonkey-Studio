import { PBR_PROBE_CLEAR, pbrProbeGeometry } from "./deepSlPbrProbeFixture.js";

export type DeepSlBaseColorTextureCaseId =
  | "opaque-uv0-left"
  | "opaque-runtime-transform"
  | "mask-alpha-below"
  | "mask-alpha-above";

export function baseColorTextureSource(alpha: "opaque" | "mask"): string {
  return `shader deep.texture-probe {
  surface standard;
  baseColor [1, 1, 1, 1];
  metallic 0;
  roughness 0.8;
  alpha ${alpha};
  doubleSided false;
  baseColorTexture on;
}`;
}

/** Two sRGB texels: low-alpha red followed by high-alpha green. */
export function baseColorProbeTexture(): Uint8Array {
  return new Uint8Array([
    230, 26, 18, 64,
    20, 220, 30, 192,
  ]);
}

export function constantUv0ProbeGeometry(u = 0.25): Float32Array {
  const result = pbrProbeGeometry();
  for (let vertex = 0; vertex < 3; vertex += 1) {
    result[vertex * 10 + 6] = u;
    result[vertex * 10 + 7] = 0.5;
  }
  return result;
}

export function translatedBaseColorParameters(parameters: readonly number[], translateU: number): readonly number[] {
  if (parameters.length !== 40 || parameters.some((value) => !Number.isFinite(value))
    || !Number.isFinite(translateU)) {
    throw new Error("Texture probe requires the fixed 40-f32 material ABI and a finite translation.");
  }
  const result = [...parameters];
  result[2] = translateU;
  return Object.freeze(result);
}

export interface DeepSlBaseColorTexturePixelSample {
  readonly id: DeepSlBaseColorTextureCaseId;
  readonly pixel: readonly number[];
  readonly shadowDepth: number;
}

const distanceFromClear = (pixel: readonly number[]): number => Math.max(
  ...pixel.map((value, index) => Math.abs(value - PBR_PROBE_CLEAR[index]!)),
);

export function evaluateBaseColorTextureProbe(
  samples: readonly DeepSlBaseColorTexturePixelSample[],
  runtimeVariantsSharePreparedPass: boolean,
) {
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  const opaqueLeft = byId.get("opaque-uv0-left");
  const opaqueTranslated = byId.get("opaque-runtime-transform");
  const maskBelow = byId.get("mask-alpha-below");
  const maskAbove = byId.get("mask-alpha-above");
  const finite = samples.length === 4 && samples.every((sample) => sample.pixel.length === 4
    && sample.pixel.every(Number.isFinite) && Number.isFinite(sample.shadowDepth));
  const opaqueUv0Red = finite && Boolean(opaqueLeft
    && opaqueLeft.pixel[0]! > opaqueLeft.pixel[1]! + 0.1
    && distanceFromClear(opaqueLeft.pixel) > 0.03);
  const runtimeTransformGreen = finite && Boolean(opaqueTranslated
    && opaqueTranslated.pixel[1]! > opaqueTranslated.pixel[0]! + 0.1
    && distanceFromClear(opaqueTranslated.pixel) > 0.03);
  const maskBelowClear = finite && Boolean(maskBelow
    && distanceFromClear(maskBelow.pixel) <= 0.005
    && Math.abs(maskBelow.shadowDepth - 1) <= 0.00001);
  const maskAboveVisible = finite && Boolean(maskAbove
    && maskAbove.pixel[1]! > maskAbove.pixel[0]! + 0.1
    && distanceFromClear(maskAbove.pixel) > 0.03
    && maskAbove.shadowDepth < 0.9);
  return Object.freeze({
    finite, opaqueUv0Red, runtimeTransformGreen, maskBelowClear, maskAboveVisible,
    runtimeVariantsSharePreparedPass,
    verified: finite && opaqueUv0Red && runtimeTransformGreen && maskBelowClear
      && maskAboveVisible && runtimeVariantsSharePreparedPass,
  });
}
