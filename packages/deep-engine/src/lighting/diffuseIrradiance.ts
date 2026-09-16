import type { WorldClusteredLights } from "./worldLights.js";
import type { LightVector3 } from "./types.js";

export const DIFFUSE_IRRADIANCE_BYTES = 64;
const MAX_DIFFUSE_LIGHTS = 4096;

/** Exact L0/L1 sum of Three's ambient and hemisphere irradiance, in world space. */
export function packDiffuseIrradiance(lights?: Pick<WorldClusteredLights, "ambient" | "hemisphere">): Float32Array<ArrayBuffer> {
  const ambient = lights?.ambient ?? [], hemisphere = lights?.hemisphere ?? [];
  if (!Array.isArray(ambient) || !Array.isArray(hemisphere) || ambient.length + hemisphere.length > MAX_DIFFUSE_LIGHTS) {
    throw new RangeError("Diffuse lights must be arrays containing at most 4096 lights.");
  }
  const coefficients = Array<number>(16).fill(0);
  for (const light of ambient) {
    vector(light.color, "ambient color"); intensity(light.intensity);
    for (let channel = 0; channel < 3; channel++) coefficients[channel] = coefficients[channel]! + light.color[channel]! * light.intensity;
  }
  for (const light of hemisphere) {
    vector(light.skyColor, "hemisphere sky color"); vector(light.groundColor, "hemisphere ground color");
    intensity(light.intensity);
    const direction = normalize(light.directionWorld);
    for (let channel = 0; channel < 3; channel++) {
      const sky = light.skyColor[channel]! * light.intensity, ground = light.groundColor[channel]! * light.intensity;
      coefficients[channel] = coefficients[channel]! + (sky + ground) * 0.5;
      for (let axis = 0; axis < 3; axis++) {
        const offset = (axis + 1) * 4 + channel;
        coefficients[offset] = coefficients[offset]! + (sky - ground) * 0.5 * direction[axis]!;
      }
    }
  }
  const packed = new Float32Array(coefficients);
  if (!packed.every(Number.isFinite)) throw new RangeError("Diffuse light accumulation exceeds finite Float32 irradiance.");
  for (let channel = 0; channel < 3; channel++) {
    const maximum = packed[channel]! + Math.hypot(packed[4 + channel]!, packed[8 + channel]!, packed[12 + channel]!);
    if (!Number.isFinite(Math.fround(maximum))) throw new RangeError("Diffuse light accumulation exceeds finite Float32 irradiance.");
  }
  return packed;
}

/** Lambert diffuse contribution; authored diffuse light is independent of IBL and specular Fresnel. */
export function evaluateDiffuseIrradiance(coefficients: Float32Array, normal: LightVector3,
  base: LightVector3, metallic: number, occlusion = 1): LightVector3 {
  if (coefficients.length !== 16 || !coefficients.every(Number.isFinite)) throw new RangeError("Invalid diffuse irradiance coefficients.");
  vector(base, "base color");
  if (![metallic, occlusion].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new RangeError("Invalid diffuse material factors.");
  const n = normalize(normal);
  return [0, 1, 2].map(channel => Math.max(0, coefficients[channel]!
    + coefficients[4 + channel]! * n[0] + coefficients[8 + channel]! * n[1] + coefficients[12 + channel]! * n[2])
    * base[channel]! * (1 - metallic) * occlusion / Math.PI) as unknown as LightVector3;
}

function intensity(value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError("Diffuse light intensity must be finite and non-negative.");
}
function vector(value: LightVector3, label: string): void {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(component => Number.isFinite(component) && component >= 0)) {
    throw new RangeError(`${label} must be a finite non-negative vec3.`);
  }
}
function normalize(value: LightVector3): LightVector3 {
  if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new RangeError("Diffuse light direction must be a finite vec3.");
  const length = Math.hypot(...value);
  if (!Number.isFinite(length) || length <= 1e-8) throw new RangeError("Diffuse light direction must be non-zero and normalizable.");
  return value.map(component => component / length) as unknown as LightVector3;
}
