import type { AmbientOcclusionCpuInput, AmbientOcclusionCpuResult, AmbientOcclusionOptions } from "./ambientOcclusionTypes.js";

const DIRECTIONS = [[1, 0], [Math.SQRT1_2, Math.SQRT1_2], [0, 1], [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0], [-Math.SQRT1_2, -Math.SQRT1_2], [0, -1], [Math.SQRT1_2, -Math.SQRT1_2]] as const;
const BLUR_WEIGHTS = [0.06136, 0.24477, 0.38774, 0.24477, 0.06136] as const;
type Vec3 = [number, number, number];

function validate(input: AmbientOcclusionCpuInput, options: AmbientOcclusionOptions): void {
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1) throw new Error("AO CPU dimensions must be positive safe integers.");
  if (input.depth.length !== input.width * input.height || !input.depth.every(value => Number.isFinite(value) && value >= 0)) throw new Error("AO CPU depth must contain finite nonnegative linear view depths.");
  if (input.normals.length !== input.width * input.height * 3 || !input.normals.every(Number.isFinite)) throw new Error("AO CPU normals must contain tightly packed finite xyz values.");
  validateAmbientOcclusionOptions(options);
}

export function validateAmbientOcclusionOptions(options: AmbientOcclusionOptions): void {
  if (!Number.isFinite(options.verticalFovRadians) || options.verticalFovRadians <= 0 || options.verticalFovRadians >= Math.PI) throw new Error("AO verticalFovRadians must be inside (0, PI).");
  if (!Number.isFinite(options.radius) || options.radius <= 0 || options.radius > 100) throw new Error("AO radius must be finite and inside (0, 100].");
  if (!Number.isFinite(options.thickness) || options.thickness < 0 || options.thickness > options.radius) throw new Error("AO thickness must be finite and inside [0, radius].");
  if (!Number.isFinite(options.power) || options.power < 0.1 || options.power > 8) throw new Error("AO power must be finite and inside [0.1, 8].");
}

function normalAt(input: AmbientOcclusionCpuInput, x: number, y: number): Vec3 {
  const offset = (y * input.width + x) * 3, value: Vec3 = [input.normals[offset]!, input.normals[offset + 1]!, input.normals[offset + 2]!];
  const length = Math.hypot(...value); return length > 1e-4 ? [value[0] / length, value[1] / length, value[2] / length] : [0, 0, 1];
}
function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(high, value)); }
function sourceCoordinate(halfX: number, halfY: number, width: number, height: number): readonly [number, number] {
  return [Math.min(halfX * 2 + 1, width - 1), Math.min(halfY * 2 + 1, height - 1)];
}
function reconstruct(x: number, y: number, depth: number, input: AmbientOcclusionCpuInput, tanHalfFov: number): Vec3 {
  const u = (x + 0.5) / input.width, v = (y + 0.5) / input.height, aspect = input.width / input.height;
  return [(u * 2 - 1) * depth * tanHalfFov * aspect, (1 - v * 2) * depth * tanHalfFov, -depth];
}
function packedF32(value: number): number { return Math.fround(value); }
function rotation(x: number, y: number): number {
  let hash = (Math.imul(x, 0x9e3779b9) + Math.imul(y, 0x85ebca6b) + 0xc2b2ae35) >>> 0;
  hash = (hash ^ (hash >>> 16)) >>> 0; hash = Math.imul(hash, 0x7feb352d) >>> 0; hash = (hash ^ (hash >>> 15)) >>> 0;
  return hash & 3;
}
function rotate(direction: readonly [number, number], quadrant: number): readonly [number, number] {
  if (quadrant === 1) return [-direction[1], direction[0]];
  if (quadrant === 2) return [-direction[0], -direction[1]];
  if (quadrant === 3) return [direction[1], -direction[0]];
  return direction;
}

function evaluatePixel(input: AmbientOcclusionCpuInput, options: AmbientOcclusionOptions, halfX: number, halfY: number): number {
  const [centerX, centerY] = sourceCoordinate(halfX, halfY, input.width, input.height), centerDepth = input.depth[centerY * input.width + centerX]!;
  if (centerDepth <= 0) return 1;
  // The GPU receives these values through an f32 storage buffer. Quantizing the
  // CPU reference before discrete texel selection avoids a one-texel divergence
  // at exact half-pixel boundaries (for example tan(PI / 4)).
  const tanHalfFov = packedF32(Math.tan(options.verticalFovRadians * 0.5));
  const radius = packedF32(options.radius), thickness = packedF32(options.thickness);
  const center = reconstruct(centerX, centerY, centerDepth, input, tanHalfFov);
  const normal = normalAt(input, centerX, centerY);
  const radiusPixels = packedF32(clamp(packedF32(radius / centerDepth) * input.height / packedF32(2 * tanHalfFov), 1, 32));
  const quadrant = rotation(centerX, centerY); let occlusion = 0, validSamples = 0;
  for (let sampleIndex = 0; sampleIndex < 16; sampleIndex++) {
    const direction = rotate(DIRECTIONS[sampleIndex & 7]!, quadrant), ring = sampleIndex >= 8 ? 1 : 0.5;
    const sampleX = clamp(Math.floor(packedF32(centerX + packedF32(direction[0] * radiusPixels * ring)) + 0.5), 0, input.width - 1);
    const sampleY = clamp(Math.floor(packedF32(centerY + packedF32(direction[1] * radiusPixels * ring)) + 0.5), 0, input.height - 1);
    const sampleDepth = input.depth[sampleY * input.width + sampleX]!; if (sampleDepth <= 0) continue;
    const sample = reconstruct(sampleX, sampleY, sampleDepth, input, tanHalfFov);
    const delta: Vec3 = [sample[0] - center[0], sample[1] - center[1], sample[2] - center[2]], distance = Math.hypot(...delta);
    if (distance > 1e-4 && distance < radius) {
      const horizon = Math.max(dot(normal, [delta[0] / distance, delta[1] / distance, delta[2] / distance]) - thickness / distance, 0);
      occlusion += horizon * (1 - distance / radius); validSamples++;
    }
  }
  return clamp(1 - 2 * occlusion / Math.max(validSamples, 1), 0, 1) ** packedF32(options.power);
}

function blur(input: AmbientOcclusionCpuInput, options: AmbientOcclusionOptions, source: Float32Array,
  width: number, height: number, horizontal: boolean): Float32Array {
  const output = new Float32Array(source.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [centerX, centerY] = sourceCoordinate(x, y, input.width, input.height), centerDepth = input.depth[centerY * input.width + centerX]!;
    const centerNormal = normalAt(input, centerX, centerY); let weighted = 0, total = 0;
    for (let tap = -2; tap <= 2; tap++) {
      const sx = clamp(x + (horizontal ? tap : 0), 0, width - 1), sy = clamp(y + (horizontal ? 0 : tap), 0, height - 1);
      const [sourceX, sourceY] = sourceCoordinate(sx, sy, input.width, input.height), sampleDepth = input.depth[sourceY * input.width + sourceX]!;
      const sampleNormal = normalAt(input, sourceX, sourceY), spatial = BLUR_WEIGHTS[tap + 2]!;
      const depthWeight = Math.exp(-Math.abs(sampleDepth - centerDepth) / Math.max(packedF32(options.thickness), 1e-4));
      const normalWeight = Math.max(dot(centerNormal, sampleNormal), 0) ** 8;
      const weight = centerDepth > 0 && sampleDepth > 0 ? spatial * depthWeight * normalWeight : 0;
      weighted += source[sy * width + sx]! * weight; total += weight;
    }
    output[y * width + x] = total > 1e-6 ? weighted / total : source[y * width + x]!;
  }
  return output;
}

export function computeAmbientOcclusionCpu(input: AmbientOcclusionCpuInput, options: AmbientOcclusionOptions): AmbientOcclusionCpuResult {
  validate(input, options); const width = Math.ceil(input.width / 2), height = Math.ceil(input.height / 2), raw = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * width + x] = evaluatePixel(input, options, x, y);
  const horizontal = blur(input, options, raw, width, height, true), output = blur(input, options, horizontal, width, height, false);
  return { width, height, raw, horizontal, output };
}
