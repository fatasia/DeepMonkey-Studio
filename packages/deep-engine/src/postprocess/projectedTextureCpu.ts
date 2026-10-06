import { lookAt, multiply, perspective } from "../webgpu/cameraMath.js";
import { invertColumnMajor4x4 } from "../webgpu/rtShadowFrame.js";
import type { ProjectedTextureCpuFrame, ProjectedTextureCpuInput, ProjectedTextureCpuOptions,
  ProjectedTextureCpuResult, ProjectedTextureFrame, ProjectedTextureLight } from "./projectedTextureTypes.js";
import { PROJECTED_TEXTURE_NEAR } from "./projectedTextureTypes.js";

/**
 * CPU mirror of the projected-texture WGSL (same formulas, same order of rounding-sensitive
 * expressions). It is the executable specification the unit tests compare against; the GPU
 * pass must never drift from it silently.
 *
 * 照度公式(单源,全解析无随机):gobo(uv) × lightColor × intensity × max(N·L,0)
 * × (1-clamp(d/range,0,1))² × coneEdge(uv)。投影 UV 与 SSR/ssgiProject 同式
 * (NDC→uv:y 翻转);clip.w ≤ 0(投影器背后)与视锥出界贡献恰为 0。
 */

export const PROJECTED_TEXTURE_EDGE_SOFTEN_MAX = 0.5;

/** Fail-closed validation for author-supplied projector descriptors. */
export function validateProjectedTextureLight(light: ProjectedTextureLight): void {
  const finite = (value: number): boolean => Number.isFinite(value);
  if (!light || typeof light !== "object") throw new TypeError("Projected texture light must be an object.");
  if (![...light.position, ...light.target, ...light.color].every(finite)) {
    throw new RangeError("Projected texture light position/target/color must be finite.");
  }
  if (!finite(light.verticalFovRadians) || light.verticalFovRadians <= 0 || light.verticalFovRadians >= Math.PI) {
    throw new RangeError("Projected texture light verticalFovRadians must be in (0, pi).");
  }
  if (!finite(light.intensity) || light.intensity < 0) throw new RangeError("Projected texture light intensity must be finite and nonnegative.");
  if (!finite(light.range) || light.range <= 0) throw new RangeError("Projected texture light range must be positive.");
  if (!finite(light.edgeSoften) || light.edgeSoften < 0 || light.edgeSoften > PROJECTED_TEXTURE_EDGE_SOFTEN_MAX) {
    throw new RangeError(`Projected texture light edgeSoften must be in [0, ${PROJECTED_TEXTURE_EDGE_SOFTEN_MAX}].`);
  }
  if (light.color.some(channel => channel < 0)) throw new RangeError("Projected texture light color channels must be nonnegative.");
  const delta: readonly [number, number, number] = [light.target[0] - light.position[0], light.target[1] - light.position[1],
    light.target[2] - light.position[2]];
  if (delta[0] * delta[0] + delta[1] * delta[1] + delta[2] * delta[2] <= 1e-12) {
    throw new RangeError("Projected texture light target must differ from position.");
  }
  if (!light.gobo) throw new TypeError("Projected texture light requires a gobo view.");
}

/** World→projector clip (column-major): projector perspective × projector lookAt. */
export function projectedTextureWorldMatrix(light: ProjectedTextureLight): Float32Array<ArrayBuffer> {
  return multiply(perspective(light.verticalFovRadians, 1, PROJECTED_TEXTURE_NEAR, light.range),
    lookAt(light.position, light.target));
}

/**
 * Per-frame resolution: compose view→projector clip and the projector position in view
 * space. Renderer-side call (once per frame); validated fail-closed by the caller.
 */
export function resolveProjectedTextureFrame(light: ProjectedTextureLight,
  worldToView: ArrayLike<number>): ProjectedTextureFrame {
  validateProjectedTextureLight(light);
  const worldToProjector = projectedTextureWorldMatrix(light);
  const viewToWorld = invertColumnMajor4x4(worldToView);
  const viewToProjector = multiply(worldToProjector, viewToWorld);
  const positionView = transformPoint(viewToWorld, light.position);
  return { gobo: light.gobo, viewToProjector: [...viewToProjector],
    positionView, intensity: light.intensity, color: [...light.color],
    range: light.range, edgeSoften: light.edgeSoften };
}

/** Column-major 4×4 × homogeneous point (w=1), perspective divide, xyz out. */
export function transformPoint(matrix: ArrayLike<number>, point: readonly [number, number, number],
  divide = true): readonly [number, number, number] {
  const x = matrix[0]! * point[0] + matrix[4]! * point[1] + matrix[8]! * point[2] + matrix[12]!;
  const y = matrix[1]! * point[0] + matrix[5]! * point[1] + matrix[9]! * point[2] + matrix[13]!;
  const z = matrix[2]! * point[0] + matrix[6]! * point[1] + matrix[10]! * point[2] + matrix[14]!;
  const w = matrix[3]! * point[0] + matrix[7]! * point[1] + matrix[11]! * point[2] + matrix[15]!;
  if (!divide || w === 0) return [x, y, z];
  return [x / w, y / w, z / w];
}

/** Same reconstruction contract as SSR/ssrReconstruct (linear view depth → view xyz). */
export function reconstructProjectedTexturePosition(input: ProjectedTextureCpuInput, x: number, y: number,
  depth: number, tanHalfFov: number, aspect: number): readonly [number, number, number] {
  const uvX = (x + 0.5) / input.width;
  const uvY = (y + 0.5) / input.height;
  const ndcX = uvX * 2 - 1;
  const ndcY = 1 - uvY * 2;
  return [ndcX * depth * tanHalfFov * aspect, ndcY * depth * tanHalfFov, -depth];
}

/** View-space normal decode + normalize (unorm 0..1 → signed). */
export function sampleProjectedTextureNormal(input: ProjectedTextureCpuInput, x: number, y: number):
  readonly [number, number, number] {
  const clampedX = Math.min(Math.max(x, 0), input.width - 1);
  const clampedY = Math.min(Math.max(y, 0), input.height - 1);
  const base = (clampedY * input.width + clampedX) * 3;
  const nx = (input.normals[base] ?? 0) * 2 - 1;
  const ny = (input.normals[base + 1] ?? 0) * 2 - 1;
  const nz = (input.normals[base + 2] ?? 0) * 2 - 1;
  const lengthSquared = nx * nx + ny * ny + nz * nz;
  if (lengthSquared <= 1e-8) return [0, 0, 1];
  const inverse = 1 / Math.sqrt(lengthSquared);
  return [nx * inverse, ny * inverse, nz * inverse];
}

/**
 * Projector clip → gobo uv (same NDC→uv flip family as ssrProject). Returns
 * undefined behind the projector (clip.w ≤ 0).
 */
export function projectToGoboUv(frame: ProjectedTextureCpuFrame,
  position: readonly [number, number, number]): readonly [number, number] | undefined {
  const x = frame.viewToProjector[0]! * position[0] + frame.viewToProjector[4]! * position[1]
    + frame.viewToProjector[8]! * position[2] + frame.viewToProjector[12]!;
  const y = frame.viewToProjector[1]! * position[0] + frame.viewToProjector[5]! * position[1]
    + frame.viewToProjector[9]! * position[2] + frame.viewToProjector[13]!;
  const w = frame.viewToProjector[3]! * position[0] + frame.viewToProjector[7]! * position[1]
    + frame.viewToProjector[11]! * position[2] + frame.viewToProjector[15]!;
  if (!(w > 0)) return undefined;
  const ndcX = x / w, ndcY = y / w;
  return [0.5 + 0.5 * ndcX, 0.5 - 0.5 * ndcY];
}

/** Cone edge factor: smooth to zero over `edgeSoften` from the frustum uv boundary. */
export function projectedTextureConeEdge(uvX: number, uvY: number, edgeSoften: number): number {
  if (uvX < 0 || uvX > 1 || uvY < 0 || uvY > 1) return 0;
  if (edgeSoften <= 0) return 1;
  const distance = Math.min(uvX, 1 - uvX, uvY, 1 - uvY) / edgeSoften;
  const t = Math.min(Math.max(distance, 0), 1);
  return t * t * (3 - 2 * t);
}

/** Bilinear gobo sample, clamped to [0,1] uv (contribution is zero outside anyway). */
export function sampleProjectedTextureGobo(input: ProjectedTextureCpuInput, uvX: number,
  uvY: number): readonly [number, number, number] {
  const x = Math.min(Math.max(uvX, 0), 1) * input.goboWidth - 0.5;
  const y = Math.min(Math.max(uvY, 0), 1) * input.goboHeight - 0.5;
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(input.goboWidth - 1, x0 + 1), y1 = Math.min(input.goboHeight - 1, y0 + 1);
  const fx = x - Math.floor(x), fy = y - Math.floor(y);
  const texel = (tx: number, ty: number, channel: number): number => {
    const row = ty * input.goboWidth;
    if (tx >= 0 && tx < input.goboWidth && ty >= 0 && ty < input.goboHeight) return input.gobo[(row + tx) * 3 + channel] ?? 0;
    return input.gobo[(Math.min(Math.max(ty, 0), input.goboHeight - 1) * input.goboWidth
      + Math.min(Math.max(tx, 0), input.goboWidth - 1)) * 3 + channel] ?? 0;
  };
  const channels: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    const a = texel(x0, y0, channel) * (1 - fx) + texel(x1, y0, channel) * fx;
    const b = texel(x0, y1, channel) * (1 - fx) + texel(x1, y1, channel) * fx;
    channels[channel] = a * (1 - fy) + b * fy;
  }
  return channels;
}

/**
 * Single-point analytic radiance (the mirror core; also the analytic reference the
 * white-gobo degenerate test pins). depth ≤ 0 (sky) contributes nothing.
 */
export function projectedTextureRadianceCpu(input: ProjectedTextureCpuInput, frame: ProjectedTextureCpuFrame,
  x: number, y: number, depth: number, tanHalfFov: number, aspect: number): readonly [number, number, number] {
  if (!(depth > 0)) return [0, 0, 0];
  const position = reconstructProjectedTexturePosition(input, x, y, depth, tanHalfFov, aspect);
  const normal = sampleProjectedTextureNormal(input, x, y);
  const toLight: readonly [number, number, number] = [frame.positionView[0] - position[0], frame.positionView[1] - position[1],
    frame.positionView[2] - position[2]];
  const distanceSquared = toLight[0] * toLight[0] + toLight[1] * toLight[1] + toLight[2] * toLight[2];
  const distance = Math.sqrt(distanceSquared);
  if (!(distance > 0)) return [0, 0, 0];
  const cosine = (normal[0] * toLight[0] + normal[1] * toLight[1] + normal[2] * toLight[2]) / distance;
  if (!(cosine > 0)) return [0, 0, 0];
  const attenuation = 1 - Math.min(Math.max(distance / frame.range, 0), 1);
  if (!(attenuation > 0)) return [0, 0, 0];
  const uv = projectToGoboUv(frame, position);
  if (uv === undefined) return [0, 0, 0];
  const cone = projectedTextureConeEdge(uv[0], uv[1], frame.edgeSoften);
  if (!(cone > 0)) return [0, 0, 0];
  const gobo = sampleProjectedTextureGobo(input, uv[0], uv[1]);
  const scale = frame.intensity * cosine * attenuation * attenuation * cone;
  return [gobo[0] * frame.color[0] * scale, gobo[1] * frame.color[1] * scale, gobo[2] * frame.color[2] * scale];
}

/** Full-frame CPU mirror (tests, parity gates, and the real-GPU capture reference). */
export function applyProjectedTextureCpu(input: ProjectedTextureCpuInput, frame: ProjectedTextureCpuFrame,
  options: ProjectedTextureCpuOptions): ProjectedTextureCpuResult {
  if (!Number.isFinite(options.verticalFovRadians) || options.verticalFovRadians <= 0
    || options.verticalFovRadians >= Math.PI) {
    throw new RangeError("Projected texture verticalFovRadians must be in (0, pi).");
  }
  if (input.normals.length !== input.width * input.height * 3) throw new Error("Projected texture normal dimensions must match the source.");
  if (input.color.length !== input.width * input.height * 3) throw new Error("Projected texture color dimensions must match the source.");
  if (input.gobo.length !== input.goboWidth * input.goboHeight * 3) throw new Error("Projected texture gobo dimensions must mismatch.");
  const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5);
  const aspect = input.width / input.height;
  const output = new Float32Array(input.width * input.height * 3);
  for (let y = 0; y < input.height; y++) for (let x = 0; x < input.width; x++) {
    const pixel = y * input.width + x;
    const depth = input.depth[pixel] ?? 0;
    const base = pixel * 3;
    const contribution = projectedTextureRadianceCpu(input, frame, x, y, depth, tanHalfFov, aspect);
    output[base] = (input.color[base] ?? 0) + contribution[0];
    output[base + 1] = (input.color[base + 1] ?? 0) + contribution[1];
    output[base + 2] = (input.color[base + 2] ?? 0) + contribution[2];
  }
  return { width: input.width, height: input.height, output };
}

/**
 * Parameter block shared by the pass and the real-GPU capture scripts (single packing
 * source; 128 B, 16-byte aligned fields):
 * [0..63] viewToProjector (mat4x4, column-major) · [64] positionView.xyz + intensity ·
 * [80] lightColor.rgb + range · [96] edgeSoften + tanHalfFov + aspect · [112] size (u32).
 * Layout mirrors the WGSL `ProjectedTextureParams` struct field by field.
 */
export const PROJECTED_TEXTURE_PARAMETER_BYTES = 128;

export function packProjectedTextureParameters(frame: Omit<ProjectedTextureFrame, "gobo">,
  width: number, height: number, verticalFovRadians: number): ArrayBuffer {
  if (frame.viewToProjector.length !== 16) throw new Error("Projected texture viewToProjector must carry 16 floats.");
  if (!Number.isFinite(verticalFovRadians) || verticalFovRadians <= 0 || verticalFovRadians >= Math.PI) {
    throw new RangeError("Projected texture verticalFovRadians must be in (0, pi).");
  }
  const buffer = new ArrayBuffer(PROJECTED_TEXTURE_PARAMETER_BYTES);
  const floats = new Float32Array(buffer), uints = new Uint32Array(buffer);
  floats.set(frame.viewToProjector as readonly number[], 0);
  floats.set([frame.positionView[0], frame.positionView[1], frame.positionView[2], frame.intensity], 16);
  floats.set([frame.color[0], frame.color[1], frame.color[2], frame.range], 20);
  floats.set([frame.edgeSoften, Math.tan(verticalFovRadians * 0.5), width / height, 0], 24);
  uints.set([width, height], 28);
  return buffer;
}
