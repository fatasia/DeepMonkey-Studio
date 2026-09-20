import { EPSILON, TRANSMITTANCE_FLOOR, densityAtHeight, henyeyGreensteinPhase,
  rayHeightAt } from "./volumetricFog.js";
import type { VolumetricMedium } from "./volumetricFog.js";
import type { VolumetricFogCpuInput, VolumetricFogCpuOptions, VolumetricFogCpuResult,
  VolumetricFogLight } from "./volumetricFogPassTypes.js";

/**
 * GPU march kernel 的 CPU 镜像(与 screenSpaceReflectionCpu.ts 同纪律):公式、表达式顺序
 * 与 volumetricFogPassWgsl.ts 逐式一致,并且核心数学(相位/密度/高度)直接复用
 * ./volumetricFog.ts 的导出函数——恒等性由构造保证,而非复制。它是单测黄金值与后续
 * GPU 数值对拍的执行规范;WGSL 与它静默漂移会被 volumetricFogPassCpu.test.ts 拦下。
 *
 * 精度口径:CPU f64,GPU f32;表达式一致,低位漂移既接受。
 * 切片一差异(后续切片补):shadow ≡ 1,无阴影钩子。
 */

export const VOLUMETRIC_FOG_STEPS_MIN = 32;
export const VOLUMETRIC_FOG_STEPS_MAX = 64;

export function volumetricFogHalfSize(width: number, height: number): readonly [number, number] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Volumetric fog source dimensions must be positive safe integers.");
  }
  return [Math.ceil(width / 2), Math.ceil(height / 2)];
}

export function validateVolumetricMedium(medium: VolumetricMedium): void {
  if (!Number.isFinite(medium.baseExtinction) || medium.baseExtinction < 0 || medium.baseExtinction > 100) {
    throw new RangeError("Volumetric fog baseExtinction must be finite in [0, 100] per meter.");
  }
  if (!Number.isFinite(medium.scaleHeight) || medium.scaleHeight <= 0) {
    throw new RangeError("Volumetric fog scaleHeight must be positive.");
  }
  if (!Number.isFinite(medium.anisotropy) || medium.anisotropy < -0.99 || medium.anisotropy > 0.99) {
    throw new RangeError("Volumetric fog anisotropy must be in [-0.99, 0.99].");
  }
  if (!Number.isFinite(medium.albedo) || medium.albedo < 0 || medium.albedo > 1) {
    throw new RangeError("Volumetric fog albedo must be in [0, 1].");
  }
}

export function validateVolumetricFogLight(light: VolumetricFogLight): void {
  const [dx, dy, dz] = light.direction;
  if (dx === undefined || dy === undefined || dz === undefined
    || !Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz) || Math.hypot(dx, dy, dz) <= 1e-6) {
    throw new RangeError("Volumetric fog light direction must be a finite nonzero vector.");
  }
  const [rr, rg, rb] = light.radiance;
  if (rr === undefined || rg === undefined || rb === undefined
    || !Number.isFinite(rr) || !Number.isFinite(rg) || !Number.isFinite(rb)
    || rr < 0 || rg < 0 || rb < 0) {
    throw new RangeError("Volumetric fog light radiance must be finite and nonnegative.");
  }
}

export function validateVolumetricFogOptions(options: VolumetricFogCpuOptions): void {
  if (!Number.isFinite(options.verticalFovRadians) || options.verticalFovRadians <= 0 || options.verticalFovRadians >= Math.PI) {
    throw new RangeError("Volumetric fog verticalFovRadians must be in (0, pi).");
  }
  if (!Number.isSafeInteger(options.steps) || options.steps < VOLUMETRIC_FOG_STEPS_MIN || options.steps > VOLUMETRIC_FOG_STEPS_MAX) {
    throw new RangeError(`Volumetric fog steps must be an integer in [${VOLUMETRIC_FOG_STEPS_MIN}, ${VOLUMETRIC_FOG_STEPS_MAX}].`);
  }
  if (!Number.isFinite(options.maxDistance) || options.maxDistance <= 0) {
    throw new RangeError("Volumetric fog maxDistance must be positive.");
  }
  validateVolumetricMedium(options.medium);
  validateVolumetricFogLight(options.light);
}

function validateInput(input: VolumetricFogCpuInput, options: VolumetricFogCpuOptions): void {
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1) {
    throw new Error("Volumetric fog CPU dimensions must be positive safe integers.");
  }
  if (input.depth.length !== input.width * input.height
    || !input.depth.every(value => Number.isFinite(value) && value >= 0)) {
    throw new Error("Volumetric fog CPU depth must contain finite nonnegative linear view depths (0 = sky).");
  }
  validateVolumetricFogOptions(options);
}

/**
 * 步进一个半分辨率像素;返回 [散射r, 散射g, 散射b, 透过率]。
 * 与 WGSL marchVolumetricFog 的分支、公式与求值顺序逐式一致:
 * 采样深度 → ndc → 单位深度射线端点 → 方向归一化 →
 * marchDistance = depth>0 ? |reconstructPosition| : maxDistance →
 * cosTheta → HG 相位 → 中点采样 Beer-Lambert 积分(复用 volumetricFog.ts 数学)。
 */
export function marchVolumetricFogPassCpu(input: VolumetricFogCpuInput, options: VolumetricFogCpuOptions,
  halfX: number, halfY: number): readonly [number, number, number, number] {
  const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5);
  const aspect = input.width / input.height;
  const x = Math.min(halfX * 2 + 1, input.width - 1);
  const y = Math.min(halfY * 2 + 1, input.height - 1);
  const centerDepth = input.depth[y * input.width + x] ?? 0;
  const ndcX = ((x + 0.5) / input.width) * 2 - 1;
  const ndcY = 1 - ((y + 0.5) / input.height) * 2;
  const rayUnitX = ndcX * tanHalfFov * aspect, rayUnitY = ndcY * tanHalfFov, rayUnitZ = -1;
  const rayLength = Math.hypot(rayUnitX, rayUnitY, rayUnitZ);
  const directionX = rayUnitX / rayLength, directionY = rayUnitY / rayLength, directionZ = rayUnitZ / rayLength;
  // 几何像素:|reconstructPosition(coordinate, depth)|(与 AO/SSR 同一重建契约);天空像素:maxDistance。
  const marchDistance = centerDepth > 0
    ? Math.hypot(ndcX * centerDepth * tanHalfFov * aspect, ndcY * centerDepth * tanHalfFov, -centerDepth)
    : options.maxDistance;
  if (!(marchDistance > 0)) return [0, 0, 0, 1];
  const [ldx, ldy, ldz] = options.light.direction;
  const lightLength = Math.hypot(ldx ?? 0, ldy ?? 0, ldz ?? 0);
  const cosTheta = (directionX * (ldx ?? 0) + directionY * (ldy ?? 0) + directionZ * (ldz ?? 0)) / lightLength;
  const phase = henyeyGreensteinPhase(cosTheta, options.medium.anisotropy);
  const stepLength = marchDistance / Math.max(1, options.steps);
  let scatterR = 0, scatterG = 0, scatterB = 0;
  let transmittance = 1;
  // 中点采样 Beer-Lambert 积分;height = rayHeightAt(0, directionY, t)(相机在视图空间原点)。
  // shadow ≡ 1(×1.0 不改变乘积);公式与求值顺序同 volumetricFog.ts rayMarchVolumetricFog。
  for (let step = 0; step < options.steps; step += 1) {
    const t = (step + 0.5) * stepLength;
    const height = rayHeightAt(0, directionY, t);
    const opticalDepth = densityAtHeight(height, options.medium) * stepLength;
    if (opticalDepth < EPSILON) continue;
    const extinction = Math.exp(-opticalDepth);
    const scattering = options.medium.albedo * opticalDepth * phase * 1.0;
    scatterR += (options.light.radiance[0] ?? 0) * (scattering * transmittance);
    scatterG += (options.light.radiance[1] ?? 0) * (scattering * transmittance);
    scatterB += (options.light.radiance[2] ?? 0) * (scattering * transmittance);
    transmittance *= extinction;
    if (transmittance < TRANSMITTANCE_FLOOR) break;
  }
  return [scatterR, scatterG, scatterB, transmittance];
}

/** 整帧 CPU 镜像:半分辨率逐像素步进,rgba 紧排(rgb=散射,a=透过率)。 */
export function volumetricFogPassCpu(input: VolumetricFogCpuInput, options: VolumetricFogCpuOptions): VolumetricFogCpuResult {
  validateInput(input, options);
  const [width, height] = volumetricFogHalfSize(input.width, input.height);
  const scatter = new Float32Array(width * height * 4);
  for (let halfY = 0; halfY < height; halfY += 1) {
    for (let halfX = 0; halfX < width; halfX += 1) {
      const [r, g, b, a] = marchVolumetricFogPassCpu(input, options, halfX, halfY);
      const base = (halfY * width + halfX) * 4;
      scatter[base] = r; scatter[base + 1] = g; scatter[base + 2] = b; scatter[base + 3] = a;
    }
  }
  return { width, height, scatter };
}
