import type { ScreenSpaceGiCpuInput, ScreenSpaceGiCpuOptions,
  ScreenSpaceGiCpuResult } from "./screenSpaceGiTypes.js";

/**
 * CPU mirror of the trace/composite WGSL (same formulas, same order of rounding-sensitive
 * expressions, bit-exact integer sampling). It is the executable specification the unit
 * tests and the real-GPU parity gates compare against; the GPU pass must never drift
 * from it silently. March conventions shared with screenSpaceReflectionCpu
 * (reconstruct/project/edge fade/thickness band) are re-declared here — SSGI must stay
 * independently reviewable and the two kernels drift independently.
 */

export const SSGI_SAMPLES_MIN = 1;
export const SSGI_SAMPLES_MAX = 64;
export const SSGI_STEPS_MIN = 8;
export const SSGI_STEPS_MAX = 64;
export const SSGI_REFINES_MAX = 8;
export const SSGI_SEED_MAX = 0xffff_ffff;

export function screenSpaceGiHalfSize(width: number, height: number): readonly [number, number] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("SSGI source dimensions must be positive safe integers.");
  }
  return [Math.ceil(width / 2), Math.ceil(height / 2)];
}

export function validateScreenSpaceGiOptions(options: ScreenSpaceGiCpuOptions): void {
  if (!Number.isFinite(options.verticalFovRadians) || options.verticalFovRadians <= 0 || options.verticalFovRadians >= Math.PI) {
    throw new RangeError("SSGI verticalFovRadians must be in (0, pi).");
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < SSGI_SAMPLES_MIN || options.samples > SSGI_SAMPLES_MAX) {
    throw new RangeError(`SSGI samples must be an integer in [${SSGI_SAMPLES_MIN}, ${SSGI_SAMPLES_MAX}].`);
  }
  if (!Number.isFinite(options.maxDistance) || options.maxDistance <= 0) throw new RangeError("SSGI maxDistance must be positive.");
  if (!Number.isFinite(options.thickness) || options.thickness <= 0) throw new RangeError("SSGI thickness must be positive.");
  if (!Number.isSafeInteger(options.steps) || options.steps < SSGI_STEPS_MIN || options.steps > SSGI_STEPS_MAX) {
    throw new RangeError(`SSGI steps must be an integer in [${SSGI_STEPS_MIN}, ${SSGI_STEPS_MAX}].`);
  }
  if (!Number.isSafeInteger(options.refines) || options.refines < 0 || options.refines > SSGI_REFINES_MAX) {
    throw new RangeError(`SSGI refines must be an integer in [0, ${SSGI_REFINES_MAX}].`);
  }
  if (!Number.isFinite(options.edgeFade) || options.edgeFade < 0 || options.edgeFade >= 0.5) {
    throw new RangeError("SSGI edgeFade must be in [0, 0.5).");
  }
  if (!Number.isFinite(options.intensity) || options.intensity < 0) throw new RangeError("SSGI intensity must be nonnegative.");
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > SSGI_SEED_MAX) {
    throw new RangeError(`SSGI seed must be an integer in [0, ${SSGI_SEED_MAX}].`);
  }
}

/** Clamped depth fetch (row-major positive linear view depth). */
export function sampleScreenSpaceGiDepth(input: ScreenSpaceGiCpuInput, x: number, y: number): number {
  const clampedX = Math.min(Math.max(x, 0), input.width - 1);
  const clampedY = Math.min(Math.max(y, 0), input.height - 1);
  return input.depth[clampedY * input.width + clampedX] ?? 0;
}

/** Same reconstruction contract as the WGSL ssgiReconstruct (SSR/AO 同族). */
export function reconstructScreenSpaceGiPosition(input: ScreenSpaceGiCpuInput, x: number, y: number,
  depth: number, tanHalfFov: number, aspect: number): readonly [number, number, number] {
  const uvX = (x + 0.5) / input.width;
  const uvY = (y + 0.5) / input.height;
  const ndcX = uvX * 2 - 1;
  const ndcY = 1 - uvY * 2;
  return [ndcX * depth * tanHalfFov * aspect, ndcY * depth * tanHalfFov, -depth];
}

/** View-space normal decode (unorm ×2−1, safe normalize) — WGSL ssgiLoadNormal 同式. */
export function sampleScreenSpaceGiNormal(input: ScreenSpaceGiCpuInput, x: number, y: number): readonly [number, number, number] {
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

/** View-space position → UV (WGSL ssgiProject 同式). */
export function projectScreenSpaceGiToUv(position: readonly [number, number, number],
  tanHalfFov: number, aspect: number): readonly [number, number] {
  const depth = -position[2];
  const ndcX = position[0] / (depth * tanHalfFov * aspect);
  const ndcY = position[1] / (depth * tanHalfFov);
  return [(ndcX + 1) / 2, (1 - ndcY) / 2];
}

/** Screen-edge fade with the both-ends clamp the WGSL shares (SSR 教训:负 t 不得放大). */
export function screenSpaceGiEdgeFade(uvX: number, uvY: number, fade: number): number {
  const fadeX = Math.min((1 - uvX) / fade, uvX / fade);
  const fadeY = Math.min((1 - uvY) / fade, uvY / fade);
  const t = Math.min(1, Math.max(0, Math.min(fadeX, fadeY)));
  return t * t * (3 - 2 * t);
}

/** PCG hash mirror — WGSL ssgiHash 逐位同构(u32 回绕 = Math.imul + >>>0)。 */
export function screenSpaceGiHash(value: number): number {
  const state = (Math.imul(value, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> (((state >>> 28) + 4) & 31)) ^ state) >>> 0, 277803737) >>> 0;
  return ((word >>> 22) ^ word) >>> 0;
}

/** Uniform in [0,1) — WGSL ssgiRandom 同式(2^-32 定点缩放)。 */
export function screenSpaceGiRandom(seed: number, salt: number): number {
  return screenSpaceGiHash((seed ^ screenSpaceGiHash(salt)) >>> 0) * 2.3283064365386963e-10;
}

/** Branchless ONB — WGSL ssgiOnb 同式(Frisvad/Duff 变体)。 */
export function screenSpaceGiOnb(normal: readonly [number, number, number]): readonly [
  readonly [number, number, number], readonly [number, number, number]] {
  const sign = normal[2] < 0 ? -1 : 1;
  const a = -1 / (sign + normal[2]);
  const b = normal[0]! * normal[1]! * a;
  const tangent: readonly [number, number, number] =
    [1 + sign * normal[0]! * normal[0]! * a, sign * b, -sign * normal[0]!];
  const bitangent: readonly [number, number, number] = [b, sign + normal[1]! * normal[1]! * a, -normal[1]!];
  return [tangent, bitangent];
}

/** Cosine-hemisphere local direction (WGSL ssgiCosineHemisphere 同式)。 */
export function screenSpaceGiCosineHemisphere(u1: number, u2: number): readonly [number, number, number] {
  const radius = Math.sqrt(u1);
  const phi = 6.283185307179586 * u2;
  return [radius * Math.cos(phi), radius * Math.sin(phi), Math.sqrt(Math.max(0, 1 - u1))];
}

/**
 * Trace one half-resolution pixel; returns rgb bounce radiance (mean × intensity) and
 * hit ratio in a. 采样方向逐帧旋转(seed),同输入同 seed 逐位确定。
 */
export function traceScreenSpaceGiCpu(input: ScreenSpaceGiCpuInput, options: ScreenSpaceGiCpuOptions,
  halfX: number, halfY: number): readonly [number, number, number, number] {
  const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5);
  const aspect = input.width / input.height;
  const x = Math.min(halfX * 2 + 1, input.width - 1);
  const y = Math.min(halfY * 2 + 1, input.height - 1);
  const centerDepth = sampleScreenSpaceGiDepth(input, x, y);
  if (!(centerDepth > 0)) return [0, 0, 0, 0];
  const origin = reconstructScreenSpaceGiPosition(input, x, y, centerDepth, tanHalfFov, aspect);
  const [nx, ny, nz] = sampleScreenSpaceGiNormal(input, x, y);
  const [tangent, bitangent] = screenSpaceGiOnb([nx!, ny!, nz!]);
  const perPixelSeed = (options.seed ^ screenSpaceGiHash((x ^ ((y << 16) >>> 0)) >>> 0)) >>> 0;
  const stepLength = options.maxDistance / options.steps;
  let accumulatedR = 0, accumulatedG = 0, accumulatedB = 0, hits = 0;
  for (let bounce = 0; bounce < options.samples; bounce++) {
    const [localX, localY, localZ] = screenSpaceGiCosineHemisphere(
      screenSpaceGiRandom(perPixelSeed, bounce * 2 + 1), screenSpaceGiRandom(perPixelSeed, bounce * 2 + 2));
    const directionX = tangent[0]! * localX + bitangent[0]! * localY + nx! * localZ;
    const directionY = tangent[1]! * localX + bitangent[1]! * localY + ny! * localZ;
    const directionZ = tangent[2]! * localX + bitangent[2]! * localY + nz! * localZ;
    // 不丢弃朝向相机的半球(漫射能量一半在此,屏空间可解析;WGSL 同式)。
    let hit = false;
    let hitUvX = 0, hitUvY = 0, hitDistance = 0;
    for (let step = 1; step <= options.steps && !hit; step++) {
      const distance = step * stepLength;
      const qx = origin[0] + directionX * distance;
      const qy = origin[1] + directionY * distance;
      const qz = origin[2] + directionZ * distance;
      const rayDepth = -qz;
      if (rayDepth <= 0) break;
      const [uvX, uvY] = projectScreenSpaceGiToUv([qx, qy, qz], tanHalfFov, aspect);
      if (uvX < 0 || uvX > 1 || uvY < 0 || uvY > 1) break;
      const pixelX = Math.min(Math.max(Math.floor(uvX * input.width), 0), input.width - 1);
      const pixelY = Math.min(Math.max(Math.floor(uvY * input.height), 0), input.height - 1);
      const surfaceDepth = sampleScreenSpaceGiDepth(input, pixelX, pixelY);
      if (!(surfaceDepth > 0)) continue;
      if (surfaceDepth < rayDepth && rayDepth - surfaceDepth < options.thickness) {
        let lowDistance = distance - stepLength;
        let highDistance = distance;
        for (let refine = 0; refine < options.refines; refine++) {
          const middleDistance = (lowDistance + highDistance) / 2;
          const mx = origin[0] + directionX * middleDistance;
          const my = origin[1] + directionY * middleDistance;
          const mz = origin[2] + directionZ * middleDistance;
          const middleDepth = -mz;
          const [muX, muY] = projectScreenSpaceGiToUv([mx, my, mz], tanHalfFov, aspect);
          const refinedX = Math.min(Math.max(Math.floor(muX * input.width), 0), input.width - 1);
          const refinedY = Math.min(Math.max(Math.floor(muY * input.height), 0), input.height - 1);
          const refinedDepth = sampleScreenSpaceGiDepth(input, refinedX, refinedY);
          if (refinedDepth > 0 && refinedDepth < middleDepth) highDistance = middleDistance;
          else lowDistance = middleDistance;
        }
        hitDistance = (lowDistance + highDistance) / 2;
        const fx = origin[0] + directionX * hitDistance;
        const fy = origin[1] + directionY * hitDistance;
        const fz = origin[2] + directionZ * hitDistance;
        const [finalUvX, finalUvY] = projectScreenSpaceGiToUv([fx, fy, fz], tanHalfFov, aspect);
        const finalX = Math.min(Math.max(Math.floor(finalUvX * input.width), 0), input.width - 1);
        const finalY = Math.min(Math.max(Math.floor(finalUvY * input.height), 0), input.height - 1);
        if (!(sampleScreenSpaceGiDepth(input, finalX, finalY) > 0)) continue;
        hitUvX = finalUvX; hitUvY = finalUvY;
        hit = true;
      }
    }
    if (!hit) continue;
    // 命中辐射度 = 命中点双线性采色(WGSL textureSampleLevel 同式,压缩 GPU/CPU 奇偶差)。
    const sampleFx = hitUvX * input.width - 0.5, sampleFy = hitUvY * input.height - 0.5;
    const sampleX0 = Math.floor(sampleFx), sampleY0 = Math.floor(sampleFy);
    const sampleTx = sampleFx - sampleX0, sampleTy = sampleFy - sampleY0;
    const colorAt = (px: number, py: number, channel: number): number => {
      const clampedX = Math.min(Math.max(px, 0), input.width - 1);
      const clampedY = Math.min(Math.max(py, 0), input.height - 1);
      return input.color[(clampedY * input.width + clampedX) * 3 + channel] ?? 0;
    };
    const fadeT = Math.min(1, Math.max(0, hitDistance / options.maxDistance));
    const falloff = (1 - fadeT) * (1 - fadeT) * screenSpaceGiEdgeFade(hitUvX, hitUvY, Math.max(options.edgeFade, 1e-4));
    for (let channel = 0; channel < 3; channel++) {
      const top = colorAt(sampleX0, sampleY0, channel) * (1 - sampleTx) + colorAt(sampleX0 + 1, sampleY0, channel) * sampleTx;
      const bottom = colorAt(sampleX0, sampleY0 + 1, channel) * (1 - sampleTx) + colorAt(sampleX0 + 1, sampleY0 + 1, channel) * sampleTx;
      const radiance = top * (1 - sampleTy) + bottom * sampleTy;
      if (channel === 0) accumulatedR += radiance * falloff;
      else if (channel === 1) accumulatedG += radiance * falloff;
      else accumulatedB += radiance * falloff;
    }
    hits += 1;
  }
  const sampleCount = Math.max(options.samples, 1);
  return [accumulatedR / sampleCount * options.intensity, accumulatedG / sampleCount * options.intensity,
    accumulatedB / sampleCount * options.intensity, hits / sampleCount];
}

/** Composite pass mirror: additive bounce over the base color (bilinear trace upsample). */
export function compositeScreenSpaceGiCpu(input: ScreenSpaceGiCpuInput,
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
    output[channel] = (input.color[base + channel] ?? 0) + top * (1 - ty) + bottom * ty;
  }
  return output;
}

/** Full CPU frame used by unit tests: trace at half resolution, composite at full. */
export function screenSpaceGiCpu(input: ScreenSpaceGiCpuInput,
  options: ScreenSpaceGiCpuOptions): ScreenSpaceGiCpuResult {
  validateScreenSpaceGiOptions(options);
  const [traceWidth, traceHeight] = screenSpaceGiHalfSize(input.width, input.height);
  const trace = new Float32Array(traceWidth * traceHeight * 4);
  const output = new Float32Array(input.width * input.height * 3);
  for (let halfY = 0; halfY < traceHeight; halfY++) {
    for (let halfX = 0; halfX < traceWidth; halfX++) {
      const [r, g, b, a] = traceScreenSpaceGiCpu(input, options, halfX, halfY);
      const base = (halfY * traceWidth + halfX) * 4;
      trace[base] = r; trace[base + 1] = g; trace[base + 2] = b; trace[base + 3] = a;
    }
  }
  for (let y = 0; y < input.height; y++) {
    for (let x = 0; x < input.width; x++) {
      const [r, g, b] = compositeScreenSpaceGiCpu(input, trace, traceWidth, traceHeight, x, y);
      const base = (y * input.width + x) * 3;
      output[base] = r; output[base + 1] = g; output[base + 2] = b;
    }
  }
  return { width: input.width, height: input.height, trace, output };
}
