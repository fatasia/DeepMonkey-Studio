import type { ScreenSpaceReflectionCpuOptions } from "./screenSpaceReflectionTypes.js";

/**
 * CPU mirror of the GPU split-sum DFG (environmentShader.brdfMain): identical Hammersley/GGX
 * sampling, geometry term and Schlick weights. C11 makes the trace mask this specular fraction
 * (instead of mirror Schlick) so SSR swaps the IBL specular fallback with scene radiance at the
 * exact weight the fallback itself uses. Quantized memo keeps per-pixel cost bounded.
 */
const BRDF_FRACTION_MEMO = new Map<string, number>();
const BRDF_FRACTION_QUANTUM = 1 / 128;
const BRDF_FRACTION_SAMPLES = 256;

export function ssrBrdfSpecularFractionCpu(cosTheta: number, roughness: number, fresnelF0: number): number {
  if (![cosTheta, roughness, fresnelF0].every(Number.isFinite)) throw new RangeError("SSR BRDF fraction inputs must be finite.");
  const nv = Math.min(1, Math.max(0.001, cosTheta));
  const key = `${Math.round(nv / BRDF_FRACTION_QUANTUM)}:${Math.round(Math.min(1, Math.max(0, roughness)) / BRDF_FRACTION_QUANTUM)}:${fresnelF0}`;
  const memo = BRDF_FRACTION_MEMO.get(key);
  if (memo !== undefined) return memo;
  const sinV = Math.sqrt(Math.max(0, 1 - nv * nv));
  const view = [sinV, 0, nv];
  let dfgX = 0, dfgY = 0;
  for (let i = 0; i < BRDF_FRACTION_SAMPLES; i++) {
    const xi = hammersleyCpu(i, BRDF_FRACTION_SAMPLES);
    const half = ggxCpu(xi, roughness);
    const vh = view[0]! * half[0]! + view[1]! * half[1]! + view[2]! * half[2]!;
    const lightZ = -view[2]! + 2 * vh * half[2]!;
    const nl = Math.max(lightZ, 0), nh = Math.max(half[2], 0), vhd = Math.max(vh, 0);
    if (nl > 0) {
      const alpha = roughness * roughness, a2 = alpha * alpha;
      const gv = nl * Math.sqrt(a2 + (1 - a2) * nv * nv);
      const gl = nv * Math.sqrt(a2 + (1 - a2) * nl * nl);
      const visibility = 4 * nl * (0.5 / Math.max(gv + gl, 0.000001)) * vhd / Math.max(nh, 0.0001);
      const fresnel = Math.pow(1 - vhd, 5);
      dfgX += (1 - fresnel) * visibility;
      dfgY += fresnel * visibility;
    }
  }
  dfgX /= BRDF_FRACTION_SAMPLES; dfgY /= BRDF_FRACTION_SAMPLES;
  const fraction = Math.min(1, Math.max(0, fresnelF0 * dfgX + dfgY))
    * (1 + fresnelF0 * (1 / Math.max(dfgX + dfgY, 0.05) - 1));
  const value = Math.min(1, Math.max(0, fraction));
  BRDF_FRACTION_MEMO.set(key, value);
  return value;
}

function hammersleyCpu(i: number, count: number): readonly [number, number] {
  let bits = i;
  bits = (bits << 16) | bits >>> 16;
  bits = ((bits & 0x55555555) << 1) | ((bits & 0xAAAAAAAA) >>> 1);
  bits = ((bits & 0x33333333) << 2) | ((bits & 0xCCCCCCCC) >>> 2);
  bits = ((bits & 0x0F0F0F0F) << 4) | ((bits & 0xF0F0F0F0) >>> 4);
  bits = ((bits & 0x00FF00FF) << 8) | ((bits & 0xFF00FF00) >>> 8);
  return [i / count, (bits >>> 0) * 2.3283064365386963e-10];
}

function ggxCpu(xi: readonly [number, number], roughness: number): readonly [number, number, number] {
  const a = roughness * roughness;
  const cosine = Math.sqrt((1 - xi[1]) / Math.max(1 + (a * a - 1) * xi[1], 0.00001));
  const sine = Math.sqrt(Math.max(1 - cosine * cosine, 0));
  return [Math.cos(2 * Math.PI * xi[0]) * sine, Math.sin(2 * Math.PI * xi[0]) * sine, cosine];
}

export type { ScreenSpaceReflectionCpuOptions };
