import type { RayBlasDescriptor } from "./rayBackendTypes.js";
import type { RuntimeAuthoredLighting } from "../runtimePackage/environmentTypes.js";

export type PathTraceRgb = readonly [number, number, number];
export interface PathTraceCpuMaterial {
  readonly model: "lambert" | "ggx-conductor" | "production-opaque-pbr";
  /** Linear reflectance; GGX uses this as normal-incidence Fresnel F0. */
  readonly reflectance: PathTraceRgb;
  readonly roughness?: number;
  /** Production opaque PBR uses reflectance as baseColor, with authored metallic/IOR. */
  readonly metallic?: number;
  readonly ior?: number;
  readonly emission?: PathTraceRgb;
}
export interface PathTraceCpuCamera {
  readonly origin: PathTraceRgb;
  readonly target: PathTraceRgb;
  readonly up: PathTraceRgb;
  readonly verticalFovDegrees: number;
}
export interface PathTraceCpuKernelOptions {
  readonly width: number;
  readonly height: number;
  readonly blas: RayBlasDescriptor;
  /** One entry per original triangle; geometric normals are two-sided. */
  readonly materials: readonly PathTraceCpuMaterial[];
  readonly camera: PathTraceCpuCamera;
  /** Linear radiance; directional callbacks must be pure for reproducible output. */
  readonly environment: PathTraceRgb | ((direction: PathTraceRgb) => PathTraceRgb);
  /** Compiled author direction is surface-to-light. Unsupported local/IES lights fail closed. */
  readonly lighting?: RuntimeAuthoredLighting;
  /** Number of scattering events; terminal environment/emission is still evaluated. */
  readonly maxBounces?: number;
  readonly rouletteStart?: number;
  readonly rayEpsilon?: number;
}

export function validatePathTraceRgb(value: PathTraceRgb, name: string, upper = Infinity): void {
  if (!Array.isArray(value) || value.length !== 3
    || value.some(component => !Number.isFinite(component) || component < 0 || component > upper)) {
    throw new RangeError(`Path trace ${name} requires three finite components in [0, ${upper}].`);
  }
}

export type PathTraceVec3 = [number, number, number];
export const ptDot = (a: PathTraceRgb, b: PathTraceRgb): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const ptScale = (v: PathTraceRgb, scale: number): PathTraceVec3 => [v[0] * scale, v[1] * scale, v[2] * scale];
export const ptAdd = (a: PathTraceRgb, b: PathTraceRgb): PathTraceVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const ptCross = (a: PathTraceRgb, b: PathTraceRgb): PathTraceVec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export function ptNormalize(v: PathTraceRgb): PathTraceVec3 {
  const length = Math.hypot(...v);
  if (!Number.isFinite(length) || length === 0) throw new RangeError("Path trace direction is degenerate.");
  return ptScale(v, 1 / length);
}
