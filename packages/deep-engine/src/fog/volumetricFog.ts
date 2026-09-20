// G7 体积介质·切片一(2026-09-19 五轴定档后的 Wave 2 首位;用户指示效果缺口补足):
// 确定性体积雾光线步进核心。CPU 参考实现先行——它同时是后续 GPU compute 版本的
// 逐位对拍基准(数值口径:全 f64 步进,f32 量化仅在导出时)。
// 相位函数:Henyey-Greenstein;密度:指数高度衰减 × 均匀介质;消光:Beer-Lambert。
// 2026-09-19:依 runtime purity 门禁移除 three 依赖(引擎运行时仅 threeBridge 允许 three),
// 向量以只读三元组表达,与 postprocess 族 CPU 镜像的元组口径一致;语义与数值不变。

/** 只读三维向量 [x, y, z](引擎运行时 purity 纪律:three 仅限 threeBridge)。 */
export type VolumetricVector3 = readonly [number, number, number];

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
  direction: VolumetricVector3;
  radiance: VolumetricVector3;
}

export interface VolumetricRayMarchInput {
  rayOrigin: VolumetricVector3;
  rayDirection: VolumetricVector3;
  /** 相机近/远(米);步进区间。 */
  near: number;
  far: number;
  stepCount: number;
  /** 阴影衰减钩子:返回 t 处沿光方向的可见率 [0,1];无阴影时传 () => 1。 */
  shadowAttenuation: (t: number) => number;
}

export interface VolumetricRayMarchResult {
  /** 散射入射亮度(线性 RGB)。 */
  inscatter: VolumetricVector3;
  /** 透过率(逐通道一致:非彩色介质)。 */
  transmittance: number;
}

// 数值下限与地板导出供 GPU pass 镜像(volumetricFogPassCpu/Wgsl)逐值对拍复用。
export const EPSILON = 1e-8;
/** 透过率数值地板:低于此值提前终止步进;GPU 核内常量 FOG_TRANSMITTANCE_FLOOR 与之同值。 */
export const TRANSMITTANCE_FLOOR = 1e-4;

export function henyeyGreensteinPhase(cosTheta: number, anisotropy: number): number {
  const g2 = anisotropy * anisotropy;
  const denominator = 4 * Math.PI * Math.sqrt(Math.max(1 - 2 * anisotropy * cosTheta + g2, EPSILON) ** 3);
  return (1 - g2) / denominator;
}

export function densityAtHeight(height: number, medium: VolumetricMedium): number {
  return medium.baseExtinction * Math.exp(-Math.max(height, 0) / medium.scaleHeight);
}

function normalize3(vector: VolumetricVector3): VolumetricVector3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

export function rayMarchVolumetricFog(
  medium: VolumetricMedium,
  light: VolumetricLight,
  input: VolumetricRayMarchInput,
): VolumetricRayMarchResult {
  const stepLength = (input.far - input.near) / Math.max(1, input.stepCount);
  const viewDirection = normalize3(input.rayDirection);
  const lightDirection = normalize3(light.direction);
  const cosTheta = viewDirection[0] * lightDirection[0] + viewDirection[1] * lightDirection[1]
    + viewDirection[2] * lightDirection[2];
  const phase = henyeyGreensteinPhase(cosTheta, medium.anisotropy);
  const inscatter: [number, number, number] = [0, 0, 0];
  let transmittance = 1.0;
  // 步进中点采样(梯形法则的低偏差形式):第 i 步在 t_i + step/2 处取密度。
  for (let step = 0; step < input.stepCount; step += 1) {
    const t = input.near + (step + 0.5) * stepLength;
    const height = input.rayOrigin[1] + viewDirection[1] * t;
    // densityAtHeight 返回的已是消光系数 σ(h)=σ₀·exp(-h/H)(1/m),乘步长即光学深度增量 Δτ。
    // 2026-09-19 修复:消光此前误再乘一次 baseExtinction(σ₀ 双重计入,维度不符),
    // Beer-Lambert 正确形式为 exp(-Δτ);散射项 σ_s·Δs = albedo·Δτ 本就正确,保持不变。
    // GPU pass 镜像与 WGSL 核以本修复后的公式为逐式对拍基线。
    const opticalDepth = densityAtHeight(height, medium) * stepLength;
    if (opticalDepth < EPSILON) continue;
    const extinction = Math.exp(-opticalDepth);
    const shadow = Math.max(0, Math.min(1, input.shadowAttenuation(t)));
    const scattering = medium.albedo * opticalDepth * phase * shadow;
    inscatter[0] += light.radiance[0] * (scattering * transmittance);
    inscatter[1] += light.radiance[1] * (scattering * transmittance);
    inscatter[2] += light.radiance[2] * (scattering * transmittance);
    transmittance *= extinction;
    if (transmittance < TRANSMITTANCE_FLOOR) break;
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
