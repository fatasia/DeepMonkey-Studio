import type { ScreenSpaceReflectionCpuInput, ScreenSpaceReflectionCpuOptions,
  ScreenSpaceReflectionCpuResult } from "./screenSpaceReflectionTypes.js";

/**
 * CPU mirror of the trace/composite WGSL (same formulas, same order of rounding-sensitive
 * expressions). It is the executable specification the unit tests and the three-backend
 * parity gates compare against; the GPU pass must never drift from it silently.
 */

export const SSR_STEPS_MIN = 8;
export const SSR_STEPS_MAX = 128;
export const SSR_REFINES_MAX = 8;

export function screenSpaceReflectionHalfSize(width: number, height: number): readonly [number, number] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("SSR source dimensions must be positive safe integers.");
  }
  return [Math.ceil(width / 2), Math.ceil(height / 2)];
}

export function validateScreenSpaceReflectionOptions(options: ScreenSpaceReflectionCpuOptions): void {
  if (!Number.isFinite(options.verticalFovRadians) || options.verticalFovRadians <= 0 || options.verticalFovRadians >= Math.PI) {
    throw new RangeError("SSR verticalFovRadians must be in (0, pi).");
  }
  if (!Number.isFinite(options.maxDistance) || options.maxDistance <= 0) throw new RangeError("SSR maxDistance must be positive.");
  if (!Number.isFinite(options.thickness) || options.thickness <= 0) throw new RangeError("SSR thickness must be positive.");
  if (!Number.isSafeInteger(options.steps) || options.steps < SSR_STEPS_MIN || options.steps > SSR_STEPS_MAX) {
    throw new RangeError(`SSR steps must be an integer in [${SSR_STEPS_MIN}, ${SSR_STEPS_MAX}].`);
  }
  if (!Number.isSafeInteger(options.refines) || options.refines < 0 || options.refines > SSR_REFINES_MAX) {
    throw new RangeError(`SSR refines must be an integer in [0, ${SSR_REFINES_MAX}].`);
  }
  if (!Number.isFinite(options.edgeFade) || options.edgeFade < 0 || options.edgeFade >= 0.5) {
    throw new RangeError("SSR edgeFade must be in [0, 0.5).");
  }
  if (!Number.isFinite(options.fresnelF0) || options.fresnelF0 < 0 || options.fresnelF0 > 1) {
    throw new RangeError("SSR fresnelF0 must be in [0, 1].");
  }
}

function sampleDepth(input: ScreenSpaceReflectionCpuInput, x: number, y: number): number {
  const clampedX = Math.min(Math.max(x, 0), input.width - 1);
  const clampedY = Math.min(Math.max(y, 0), input.height - 1);
  return input.depth[clampedY * input.width + clampedX] ?? 0;
}

/** Same reconstruction contract as ambientOcclusionWgsl.reconstructPosition. */
function reconstructPosition(input: ScreenSpaceReflectionCpuInput, x: number, y: number, depth: number,
  tanHalfFov: number, aspect: number): readonly [number, number, number] {
  const uvX = (x + 0.5) / input.width;
  const uvY = (y + 0.5) / input.height;
  const ndcX = uvX * 2 - 1;
  const ndcY = 1 - uvY * 2;
  return [ndcX * depth * tanHalfFov * aspect, ndcY * depth * tanHalfFov, -depth];
}

function sampleNormal(input: ScreenSpaceReflectionCpuInput, x: number, y: number): readonly [number, number, number] {
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

function sampleColor(input: ScreenSpaceReflectionCpuInput, uvX: number, uvY: number): readonly [number, number, number] {
  const fx = Math.min(Math.max(uvX, 0), 1) * input.width - 0.5;
  const fy = Math.min(Math.max(uvY, 0), 1) * input.height - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const channels: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    const at = (x: number, y: number): number => {
      const clampedX = Math.min(Math.max(x, 0), input.width - 1);
      const clampedY = Math.min(Math.max(y, 0), input.height - 1);
      return input.color[(clampedY * input.width + clampedX) * 3 + channel] ?? 0;
    };
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    channels[channel] = top * (1 - ty) + bottom * ty;
  }
  return channels;
}

function projectToUv(position: readonly [number, number, number], tanHalfFov: number, aspect: number): readonly [number, number] {
  const depth = -position[2];
  const ndcX = position[0] / (depth * tanHalfFov * aspect);
  const ndcY = position[1] / (depth * tanHalfFov);
  return [(ndcX + 1) / 2, (1 - ndcY) / 2];
}

/** Edge-window fade shared by trace and CPU parity tests. */
export function screenSpaceReflectionEdgeFade(uvX: number, uvY: number, fade: number): number {
  const fadeX = Math.min((1 - uvX) / fade, uvX / fade);
  const fadeY = Math.min((1 - uvY) / fade, uvY / fade);
  const t = Math.min(1, Math.min(fadeX, fadeY));
  return t * t * (3 - 2 * t);
}

/** March one half-resolution pixel; returns rgb radiance and the composite mask in a. */
export function traceScreenSpaceReflectionCpu(input: ScreenSpaceReflectionCpuInput,
  options: ScreenSpaceReflectionCpuOptions, halfX: number, halfY: number): readonly [number, number, number, number] {
  const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5);
  const aspect = input.width / input.height;
  const x = Math.min(halfX * 2 + 1, input.width - 1);
  const y = Math.min(halfY * 2 + 1, input.height - 1);
  const centerDepth = sampleDepth(input, x, y);
  if (!(centerDepth > 0)) return [0, 0, 0, 0];
  const origin = reconstructPosition(input, x, y, centerDepth, tanHalfFov, aspect);
  const [nx, ny, nz] = sampleNormal(input, x, y);
  const rawIncidentX = origin[0] / centerDepth, rawIncidentY = origin[1] / centerDepth, rawIncidentZ = origin[2] / centerDepth;
  const incidentLength = Math.hypot(rawIncidentX, rawIncidentY, rawIncidentZ);
  const incidentX = rawIncidentX / incidentLength, incidentY = rawIncidentY / incidentLength, incidentZ = rawIncidentZ / incidentLength;
  const dotProduct = nx * incidentX + ny * incidentY + nz * incidentZ;
  const reflectedX = incidentX - 2 * dotProduct * nx;
  const reflectedY = incidentY - 2 * dotProduct * ny;
  const reflectedZ = incidentZ - 2 * dotProduct * nz;
  if (reflectedZ >= 0) return [0, 0, 0, 0]; // 反射朝相机平面之后:屏幕空间无法解析。
  const stepLength = options.maxDistance / options.steps;
  let hit = false;
  let hitUvX = 0, hitUvY = 0;
  for (let step = 1; step <= options.steps && !hit; step++) {
    const distance = step * stepLength;
    const qx = origin[0] + reflectedX * distance;
    const qy = origin[1] + reflectedY * distance;
    const qz = origin[2] + reflectedZ * distance;
    const rayDepth = -qz;
    if (rayDepth <= 0) break;
    const [uvX, uvY] = projectToUv([qx, qy, qz], tanHalfFov, aspect);
    if (uvX < 0 || uvX > 1 || uvY < 0 || uvY > 1) break;
    const pixelX = Math.min(Math.max(Math.floor(uvX * input.width), 0), input.width - 1);
    const pixelY = Math.min(Math.max(Math.floor(uvY * input.height), 0), input.height - 1);
    const surfaceDepth = sampleDepth(input, pixelX, pixelY);
    if (!(surfaceDepth > 0)) continue;
    if (surfaceDepth < rayDepth && rayDepth - surfaceDepth < options.thickness) {
      let lowDistance = distance - stepLength;
      let highDistance = distance;
      for (let refine = 0; refine < options.refines; refine++) {
        const middleDistance = (lowDistance + highDistance) / 2;
        const mx = origin[0] + reflectedX * middleDistance;
        const my = origin[1] + reflectedY * middleDistance;
        const mz = origin[2] + reflectedZ * middleDistance;
        const middleDepth = -mz;
        const [muX, muY] = projectToUv([mx, my, mz], tanHalfFov, aspect);
        const refinedX = Math.min(Math.max(Math.floor(muX * input.width), 0), input.width - 1);
        const refinedY = Math.min(Math.max(Math.floor(muY * input.height), 0), input.height - 1);
        if (sampleDepth(input, refinedX, refinedY) < middleDepth) highDistance = middleDistance;
        else lowDistance = middleDistance;
      }
      const finalDistance = (lowDistance + highDistance) / 2;
      const fx = origin[0] + reflectedX * finalDistance;
      const fy = origin[1] + reflectedY * finalDistance;
      const fz = origin[2] + reflectedZ * finalDistance;
      [hitUvX, hitUvY] = projectToUv([fx, fy, fz], tanHalfFov, aspect);
      hit = true;
    }
  }
  if (!hit) return [0, 0, 0, 0];
  const [radianceR, radianceG, radianceB] = sampleColor(input, hitUvX, hitUvY);
  // Fresnel-Schlick:cosθ = dot(N, -incident);入射方向已被归一化。
  const cosTheta = Math.min(1, Math.max(-dotProduct, 0));
  const fresnel = options.fresnelF0 + (1 - options.fresnelF0) * Math.pow(1 - cosTheta, 5);
  const fade = screenSpaceReflectionEdgeFade(hitUvX, hitUvY, Math.max(options.edgeFade, 1e-4));
  const mask = fresnel * fade;
  return [radianceR * mask, radianceG * mask, radianceB * mask, mask];
}

/** Composite pass mirror: color + bilinear-upsampled trace contribution. */
export function compositeScreenSpaceReflectionCpu(input: ScreenSpaceReflectionCpuInput,
  trace: Float32Array, traceWidth: number, traceHeight: number, x: number, y: number): readonly [number, number, number] {
  const fx = (x + 0.5) / input.width * traceWidth - 0.5;
  const fy = (y + 0.5) / input.height * traceHeight - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const at = (px: number, py: number, channel: number): number => {
    const clampedX = Math.min(Math.max(px, 0), traceWidth - 1);
    const clampedY = Math.min(Math.max(py, 0), traceHeight - 1);
    return trace[(clampedY * traceWidth + clampedX) * 4 + channel] ?? 0;
  };
  const base = (y * input.width + x) * 3;
  const output: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel++) {
    const top = at(x0, y0, channel) * (1 - tx) + at(x0 + 1, y0, channel) * tx;
    const bottom = at(x0, y0 + 1, channel) * (1 - tx) + at(x0 + 1, y0 + 1, channel) * tx;
    const contribution = top * (1 - ty) + bottom * ty;
    output[channel] = (input.color[base + channel] ?? 0) + contribution;
  }
  return output;
}

/** Full CPU frame used by unit tests: trace at half resolution, composite at full. */
export function screenSpaceReflectionCpu(input: ScreenSpaceReflectionCpuInput,
  options: ScreenSpaceReflectionCpuOptions): ScreenSpaceReflectionCpuResult {
  validateScreenSpaceReflectionOptions(options);
  const [traceWidth, traceHeight] = screenSpaceReflectionHalfSize(input.width, input.height);
  const trace = new Float32Array(traceWidth * traceHeight * 4);
  const output = new Float32Array(input.width * input.height * 3);
  for (let halfY = 0; halfY < traceHeight; halfY++) {
    for (let halfX = 0; halfX < traceWidth; halfX++) {
      const [r, g, b, a] = traceScreenSpaceReflectionCpu(input, options, halfX, halfY);
      const base = (halfY * traceWidth + halfX) * 4;
      trace[base] = r; trace[base + 1] = g; trace[base + 2] = b; trace[base + 3] = a;
    }
  }
  for (let y = 0; y < input.height; y++) {
    for (let x = 0; x < input.width; x++) {
      const [r, g, b] = compositeScreenSpaceReflectionCpu(input, trace, traceWidth, traceHeight, x, y);
      const base = (y * input.width + x) * 3;
      output[base] = r; output[base + 1] = g; output[base + 2] = b;
    }
  }
  return { width: input.width, height: input.height, trace, output };
}
