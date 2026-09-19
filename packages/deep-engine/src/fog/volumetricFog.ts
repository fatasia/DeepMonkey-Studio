import * as THREE from "three";

// G7 体积介质·切片一(2026-09-19 五轴定档后的 Wave 2 首位;用户指示效果缺口补足):
// 确定性体积雾光线步进核心。CPU 参考实现先行——它同时是后续 GPU compute 版本的
// 逐位对拍基准(数值口径:全 f64 步进,f32 量化仅在导出时)。
// 相位函数:Henyey-Greenstein;密度:指数高度衰减 × 均匀介质;消光:Beer-Lambert。

export interface VolumetricMedium {
  /** 海平面处的基础消光系数(1/m)。 */
  baseExtinction: number;
  /** 密度指数衰减高度尺度(1/m);density(y) = baseExtinction * exp(-y / scaleHeight)。 */
  scaleHeight: number;
  /** HG 相位函数各向异性参数,[-0.99, 0.99];0 = 各向同性。 */
  anisotropy: number;
  /** 介质整体反照率(单次散射比),[0,1]。 */
  albedo: number;
}

export interface VolumetricLight {
  direction: THREE.Vector3;
  radiance: THREE.Vector3;
}

export interface VolumetricRayMarchInput {
  rayOrigin: THREE.Vector3;
  rayDirection: THREE.Vector3;
  /** 相机近/远(米);步进区间。 */
  near: number;
  far: number;
  stepCount: number;
  /** 阴影衰减钩子:返回 t 处沿光方向的可见率 [0,1];无阴影时传 () => 1。 */
  shadowAttenuation: (t: number) => number;
}

export interface VolumetricRayMarchResult {
  /** 散射入射亮度(线性 RGB)。 */
  inscatter: THREE.Vector3;
  /** 透过率(逐通道一致:非彩色介质)。 */
  transmittance: number;
}

const EPSILON = 1e-8;

export function henyeyGreensteinPhase(cosTheta: number, anisotropy: number): number {
  const g2 = anisotropy * anisotropy;
  const denominator = 4 * Math.PI * Math.sqrt(Math.max(1 - 2 * anisotropy * cosTheta + g2, EPSILON) ** 3);
  return (1 - g2) / denominator;
}

export function densityAtHeight(height: number, medium: VolumetricMedium): number {
  return medium.baseExtinction * Math.exp(-Math.max(height, 0) / medium.scaleHeight);
}

export function rayMarchVolumetricFog(
  medium: VolumetricMedium,
  light: VolumetricLight,
  input: VolumetricRayMarchInput,
): VolumetricRayMarchResult {
  const stepLength = (input.far - input.near) / Math.max(1, input.stepCount);
  const viewDirection = input.rayDirection.clone().normalize();
  const cosTheta = viewDirection.dot(light.direction.clone().normalize());
  const phase = henyeyGreensteinPhase(cosTheta, medium.anisotropy);
  const inscatter = new THREE.Vector3();
  let transmittance = 1.0;
  // 步进中点采样(梯形法则的低偏差形式):第 i 步在 t_i + step/2 处取密度。
  for (let step = 0; step < input.stepCount; step += 1) {
    const t = input.near + (step + 0.5) * stepLength;
    const height = input.rayOrigin.y + viewDirection.y * t;
    const density = densityAtHeight(height, medium) * stepLength;
    if (density < EPSILON) continue;
    const extinction = Math.exp(-density * medium.baseExtinction);
    const shadow = Math.max(0, Math.min(1, input.shadowAttenuation(t)));
    const scattering = medium.albedo * density * phase * shadow;
    inscatter.add(light.radiance.clone().multiplyScalar(scattering * transmittance));
    transmittance *= extinction;
    if (transmittance < 1e-4) break;
  }
  return { inscatter, transmittance };
}

/** 世界高度:射线起点 y + 方向 y·t(雾为水平无限介质,地形高度由调用方先行扣减)。 */
export function rayHeightAt(originY: number, directionY: number, t: number): number {
  return originY + directionY * t;
}

export function defaultTestMedium(): VolumetricMedium {
  return { baseExtinction: 0.02, scaleHeight: 8, anisotropy: 0.3, albedo: 0.8 };
}
