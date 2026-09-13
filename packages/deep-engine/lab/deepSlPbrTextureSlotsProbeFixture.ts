import { pbrProbeGeometry } from "./deepSlPbrProbeFixture.js";

export type DeepSlPbrTextureSlotCaseId = "neutral" | "metallic-roughness" | "normal-scale"
  | "occlusion-uv1" | "emissive-srgb" | "emissive-strength-hdr";

export const DEEP_SL_PBR_TEXTURE_SLOTS_SOURCE = `shader deep.pbr-texture-slots {
  surface standard;
  baseColor [0.35, 0.35, 0.35, 1];
  metallic 1;
  roughness 1;
  alpha opaque;
  doubleSided false;
  baseColorTexture on;
  metallicRoughnessTexture on;
  normalTexture on;
  occlusionTexture on;
  emissiveTexture on;
  emissiveFactor [1, 1, 1];
  emissiveStrength 1;
}`;

export function pbrTextureSlotGeometry(): Float32Array {
  const result = pbrProbeGeometry();
  for (let vertex = 0; vertex < 3; vertex += 1) {
    result[vertex * 10 + 6] = 0.25;
    result[vertex * 10 + 7] = 0.5;
    result[vertex * 10 + 8] = 0.75;
    result[vertex * 10 + 9] = 0.5;
  }
  return result;
}

export function pbrTextureSlotTangents(handedness = 1): Float32Array {
  return new Float32Array([
    1, 0, 0, handedness,
    1, 0, 0, handedness,
    1, 0, 0, handedness,
  ]);
}

export function rgba8(...values: number[]): Uint8Array {
  if (values.length !== 4 && values.length !== 8) throw new Error("Probe texture requires one or two RGBA8 texels.");
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new Error("Probe texture channels must be bytes.");
  }
  return new Uint8Array(values);
}

export interface DeepSlPbrTextureSlotPixelSample {
  readonly id: DeepSlPbrTextureSlotCaseId;
  readonly pixel: readonly number[];
}

const luminance = (pixel: readonly number[]): number => pixel[0]! * 0.2126
  + pixel[1]! * 0.7152 + pixel[2]! * 0.0722;
const maxRgbDelta = (left: readonly number[], right: readonly number[]): number => Math.max(
  ...[0, 1, 2].map((index) => Math.abs(left[index]! - right[index]!)),
);

export function evaluatePbrTextureSlotsProbe(
  samples: readonly DeepSlPbrTextureSlotPixelSample[],
  sharedPipeline: boolean,
) {
  const byId = new Map(samples.map((sample) => [sample.id, sample.pixel]));
  const neutral = byId.get("neutral") ?? [];
  const mr = byId.get("metallic-roughness") ?? [];
  const normal = byId.get("normal-scale") ?? [];
  const ao = byId.get("occlusion-uv1") ?? [];
  const emissive = byId.get("emissive-srgb") ?? [];
  const hdrEmissive = byId.get("emissive-strength-hdr") ?? [];
  const finite = samples.length === 6 && samples.every((sample) => sample.pixel.length === 4
    && sample.pixel.every(Number.isFinite));
  const metallicRoughnessBgDirectional = finite && maxRgbDelta(neutral, mr) > 0.04;
  const normalScaleDirectional = finite && luminance(neutral) - luminance(normal) > 0.08;
  const occlusionUv1Directional = finite && luminance(neutral) - luminance(ao) > 0.004;
  const emissiveSrgbDirectional = finite && emissive[0]! - neutral[0]! > 0.4
    && emissive[0]! - neutral[0]! > emissive[1]! - neutral[1]! + 0.25;
  const emissiveStrengthDirectional = finite && hdrEmissive[0]! - emissive[0]! > 2
    && maxRgbDelta(hdrEmissive, emissive) > 2;
  return Object.freeze({
    finite, metallicRoughnessBgDirectional, normalScaleDirectional,
    occlusionUv1Directional, emissiveSrgbDirectional, emissiveStrengthDirectional, sharedPipeline,
    verified: finite && metallicRoughnessBgDirectional && normalScaleDirectional
      && occlusionUv1Directional && emissiveSrgbDirectional && emissiveStrengthDirectional && sharedPipeline,
  });
}
