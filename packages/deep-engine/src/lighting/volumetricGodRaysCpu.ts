// I 级 C18 god rays 的 CPU 镜像(与 screenSpaceReflectionCpu.ts / fog/volumetricFogPassCpu.ts
// 同纪律):公式、分支与求值顺序与 wgsl/volumetricGodRays.wgsl 逐式一致,核心数学
// (相位/密度/高度)直接复用 fog/volumetricFog.ts 导出——恒等性由构造保证。
// 它是单测黄金值与后续 GPU 数值对拍的执行规范;WGSL 与它静默漂移会被
// volumetricGodRaysCpu.test.ts 的字符串级同构锁与镜像 ≡ 参考断言拦下。
//
// 精度口径:CPU f64,GPU f32;表达式一致,低位漂移既接受。
// 阴影图数据面由 volumetricGodRays.rasterizeGodRaysShadowMap 提供(f32 容器),
// 本镜像与 WGSL 消费同一张图的同一 texel 口径(最近邻 floor+clamp);
// shadowRange/shadowBias 在 WGSL 里挂在 shadowBasisRight.w / shadowBasisForward.w,
// CPU 侧以显式参数传递(禁全局可变状态,与 purity 纪律一致)。

import { EPSILON, TRANSMITTANCE_FLOOR, densityAtHeight, henyeyGreensteinPhase,
  rayHeightAt } from "../fog/volumetricFog.js";
import { GOD_RAYS_SHADOW_FAR_SENTINEL, validateVolumetricGodRaysOptions,
  type GodRaysShadowBasis, type GodRaysShadowMap, type VolumetricGodRaysOptions } from "./volumetricGodRays.js";

/**
 * 阴影图最近邻查询(f64 求值,与 WGSL shadowVisibility 逐式同构):
 * 光空间投影 -> uv -> 域外 fail-open lit -> floor+clamp 最近邻 -> 深度比较。
 */
export function shadowVisibilityGodRaysCpu(worldPos: readonly [number, number, number],
  basis: GodRaysShadowBasis, shadowMap: GodRaysShadowMap, shadowRange: number,
  shadowBias: number): number {
  const basisU = worldPos[0] * basis.right[0] + worldPos[1] * basis.right[1] + worldPos[2] * basis.right[2];
  const basisV = worldPos[0] * basis.up[0] + worldPos[1] * basis.up[1] + worldPos[2] * basis.up[2];
  const basisW = worldPos[0] * basis.forward[0] + worldPos[1] * basis.forward[1] + worldPos[2] * basis.forward[2];
  const uvX = (basisU / shadowRange) * 0.5 + 0.5;
  const uvY = (basisV / shadowRange) * 0.5 + 0.5;
  if (uvX < 0 || uvX > 1 || uvY < 0 || uvY > 1) return 1;
  const mapSize = shadowMap.size;
  const texelX = Math.min(Math.max(Math.floor(uvX * mapSize), 0), mapSize - 1);
  const texelY = Math.min(Math.max(Math.floor(uvY * mapSize), 0), mapSize - 1);
  const stored = shadowMap.depth[texelY * mapSize + texelX] ?? GOD_RAYS_SHADOW_FAR_SENTINEL;
  return stored >= basisW - shadowBias ? 1 : 0;
}

/**
 * 单像素 god rays 步进(与 WGSL marchVolumetricGodRays 的分支、公式与求值顺序逐式一致):
 * 采样深度 -> ndc -> 单位深度射线端点 -> 方向归一化 ->
 * marchDistance = depth>0 ? |reconstructPosition| : maxDistance ->
 * cosTheta -> HG 相位 -> 每步中点阴影图最近邻查询 -> 中点采样 Beer-Lambert 积分。
 */
export function marchVolumetricGodRaysPassCpu(input: {
  readonly width: number;
  readonly height: number;
  /** 线性正视图深度,行主序紧排;0 = 天空。 */
  readonly depth: readonly number[];
}, options: VolumetricGodRaysOptions, basis: GodRaysShadowBasis, shadowMap: GodRaysShadowMap,
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
  // 几何像素:|reconstructPosition(coordinate, depth)|(与雾/AO/SSR 同一重建契约);天空像素:maxDistance。
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
  // 每步中点 shadowVisibility(阴影图最近邻);strength 乘在 radiance 侧(WGSL 同序)。
  for (let step = 0; step < options.steps; step += 1) {
    const t = (step + 0.5) * stepLength;
    const height = rayHeightAt(0, directionY, t);
    const opticalDepth = densityAtHeight(height, options.medium) * stepLength;
    if (opticalDepth < EPSILON) continue;
    const extinction = Math.exp(-opticalDepth);
    const shadow = shadowVisibilityGodRaysCpu(
      [directionX * t, directionY * t, directionZ * t], basis, shadowMap,
      options.shadowRange, options.shadowBias);
    const scattering = options.medium.albedo * opticalDepth * phase * shadow;
    scatterR += ((options.light.radiance[0] ?? 0) * options.strength) * (scattering * transmittance);
    scatterG += ((options.light.radiance[1] ?? 0) * options.strength) * (scattering * transmittance);
    scatterB += ((options.light.radiance[2] ?? 0) * options.strength) * (scattering * transmittance);
    transmittance *= extinction;
    if (transmittance < TRANSMITTANCE_FLOOR) break;
  }
  return [scatterR, scatterG, scatterB, transmittance];
}

/** 整帧 CPU 镜像:半分辨率逐像素步进,rgba 紧排(rgb=散射,a=透过率)。 */
export function volumetricGodRaysPassCpu(input: { readonly width: number; readonly height: number;
  readonly depth: readonly number[] }, options: VolumetricGodRaysOptions, basis: GodRaysShadowBasis,
  shadowMap: GodRaysShadowMap): { readonly width: number; readonly height: number; readonly scatter: Float32Array } {
  validateVolumetricGodRaysOptions(options);
  const width = Math.ceil(input.width / 2);
  const height = Math.ceil(input.height / 2);
  const scatter = new Float32Array(width * height * 4);
  for (let halfY = 0; halfY < height; halfY += 1) {
    for (let halfX = 0; halfX < width; halfX += 1) {
      const [r, g, b, a] = marchVolumetricGodRaysPassCpu(input, options, basis, shadowMap, halfX, halfY);
      const base = (halfY * width + halfX) * 4;
      scatter[base] = r; scatter[base + 1] = g; scatter[base + 2] = b; scatter[base + 3] = a;
    }
  }
  return { width, height, scatter };
}
