import type { PbrFrameUniformView } from "./pbrFrameUniforms.js";
import { resolvePbrCameraProjection } from "./pbrFrameUniforms.js";
import { lookAt } from "./cameraMath.js";

export interface PanoramaBackground {
  readonly intensity?: number;
  readonly toneMapped?: boolean;
  /** Column-major world-to-panorama rotation; no translation, scale or reflection. */
  readonly rotation?: readonly number[];
}
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const;

export function validatePanoramaBackground(value: PanoramaBackground): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Panorama background must be an object.");
  if (value.toneMapped !== undefined && typeof value.toneMapped !== "boolean") throw new TypeError("Panorama toneMapped must be boolean.");
  const intensity = value.intensity ?? 1;
  if (!Number.isFinite(intensity) || intensity < 0 || intensity > 64) throw new RangeError("Panorama intensity must be in 0..64.");
  const r = value.rotation ?? IDENTITY;
  if (!Array.isArray(r) || r.length !== 9 || !r.every(Number.isFinite)) throw new RangeError("Panorama rotation must be a finite mat3.");
  for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) {
    const dot = r[a * 3]! * r[b * 3]! + r[a * 3 + 1]! * r[b * 3 + 1]! + r[a * 3 + 2]! * r[b * 3 + 2]!;
    if (Math.abs(dot - (a === b ? 1 : 0)) > 1e-4) throw new RangeError("Panorama rotation must be orthonormal.");
  }
  const determinant = r[0]! * (r[4]! * r[8]! - r[5]! * r[7]!)
    - r[3]! * (r[1]! * r[8]! - r[2]! * r[7]!) + r[6]! * (r[1]! * r[5]! - r[2]! * r[4]!);
  if (Math.abs(determinant - 1) > 1e-4) throw new RangeError("Panorama rotation must not reflect space.");
}

export function packPanoramaBackground(view: PbrFrameUniformView, settings: PanoramaBackground,
  aspect: number): Float32Array<ArrayBuffer> {
  validatePanoramaBackground(settings);
  if (!Number.isFinite(aspect) || aspect <= 0) throw new RangeError("Invalid panorama aspect ratio.");
  const camera = lookAt(view.eye, view.target, view.up);
  const tanY = Math.tan(resolvePbrCameraProjection(view).verticalFovRadians / 2);
  const data = new Float32Array(24), r = settings.rotation ?? IDENTITY;
  data.set([camera[0]!, camera[4]!, camera[8]!, tanY * aspect,
    camera[1]!, camera[5]!, camera[9]!, tanY,
    -camera[2]!, -camera[6]!, -camera[10]!, settings.intensity ?? 1]);
  for (let column = 0; column < 3; column++) data.set(r.slice(column * 3, column * 3 + 3), 12 + column * 4);
  if (!data.every(Number.isFinite)) throw new RangeError("Panorama parameters exceed Float32.");
  return data;
}

export const PBR_PANORAMA_WGSL = /* wgsl */ `
struct Background { right: vec4f, up: vec4f, forward: vec4f, rotation: mat3x3f };
@group(0) @binding(0) var<uniform> settings: Background;
@group(0) @binding(1) var panorama: texture_2d<f32>;
@group(0) @binding(2) var panoramaSampler: sampler;
struct Vertex { @builtin(position) position: vec4f, @location(0) ndc: vec2f };
@vertex fn vertex(@builtin(vertex_index) index: u32) -> Vertex {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0))[index];
  return Vertex(vec4f(p, 1.0, 1.0), p);
}
fn panoramaColor(ndc: vec2f) -> vec4f {
  let ray = normalize(settings.forward.xyz + settings.right.xyz * ndc.x * settings.right.w
    + settings.up.xyz * ndc.y * settings.up.w);
  let direction = normalize(settings.rotation * ray);
  let uv = vec2f(atan2(direction.z, direction.x) / 6.283185307179586 + 0.5,
    acos(clamp(direction.y, -1.0, 1.0)) / 3.141592653589793);
  return vec4f(textureSampleLevel(panorama, panoramaSampler, uv, 0.0).rgb * settings.forward.w, 1.0);
}
@fragment fn color(v: Vertex) -> @location(0) vec4f { return panoramaColor(v.ndc); }
fn linearToSrgb(value: vec3f) -> vec3f {
  let linear = max(value, vec3f(0.0));
  let high = 1.055 * pow(linear, vec3f(1.0 / 2.4)) - 0.055;
  let low = linear * 12.92;
  return select(high, low, linear <= vec3f(0.0031308));
}
@fragment fn display(v: Vertex) -> @location(0) vec4f {
  return vec4f(linearToSrgb(panoramaColor(v.ndc).rgb), 1.0);
}
struct Mrt { @location(0) color: vec4f, @location(1) depth: f32,
  @location(2) normal: vec4f, @location(3) motion: vec2f };
@fragment fn mrt(v: Vertex) -> Mrt { return Mrt(panoramaColor(v.ndc), 0.0, vec4f(0.0), vec2f(0.0)); }
`;
