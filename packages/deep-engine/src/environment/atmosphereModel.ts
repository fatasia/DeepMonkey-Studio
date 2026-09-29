/**
 * I-C6 物理大气散射(Bruneton 类)——物理核心与表采样几何(CPU 参考)。
 *
 * 与 T09 skyReference.ts 的关系:同一散射系数家族(β_R 逐位同值、Mie β 同浊度标定式、
 * 同 HG g=0.8 默认),把"平面均匀大气 + 单次散射"升级为"球面指数剖面大气 + 精确太阳
 * 透射(含地球阴影锥)+ 散射阶数值迭代多次散射"。归一标尺不变:E0=1 等能白太阳辐照,
 * 只承诺相对分布与确定性,不校准绝对辐亮度。
 *
 * 算法结构来源:Bruneton 2008/2017 "Precomputed Atmospheric Scattering" 公开论文
 * (球面壳层指数剖面、预计算透射/散射、散射阶迭代),全部自实现,不复制受限代码。
 * 观察者固定在地面,散射表为 3D (μv, μs, γ) 而非论文的 4D(r,μ,μs,ν)。
 *
 * 表结构与降维(均有物理根据,误差核算在生成脚本头注):
 * - 透射表 1D:T_sun(μs)(3 通道,含地影几何遮挡);
 * - 单散射 3D:phase 拆分 S_R/S_M(μv, μs, γ) —— 球面几何下太阳路径局部几何依赖 γ,
 *   经典的"单散射二维"结论只在平面近似下成立;
 * - 多次散射低秩近似:MS(γ) ≈ iso(μv,μs) + a(μv,μs)·P_R(γ)。瑞利-瑞利二次散射的
 *   角分布是 iso 与 Rayleigh 相函数的近线性组合(三阶以上趋各向同性),生成期对每个
 *   (μv,μs) 做两基最小二乘拟合,拟合残差由测试钉上限。
 * - 浊度运行时缩放:Mie 系数对浊度线性(与 T09 同式),Mie 表分量按浊度/4 缩放,
 *   Rayleigh 与多次散射不变 —— 因此表按标称浊度 4 生成一次,任意浊度运行时采样。
 *
 * 已知限制(如实声明):无臭氧吸收;多次散射入射场按地面天空场取值(不做每点高程
 * 修正);下半球为 Lambert 地面反照率反射;太阳圆盘不进天空场(直射归作者方向灯,
 * 避免与 IBL 重复计能)。全 f64 纯函数,零随机零三方依赖,同输入逐位同输出。
 */

import { RAYLEIGH_BETA_RGB, type Vec3 } from "./skyReference.js";

/** 地球半径(米;同 skyReference 常量,本模块内部用)。 */
const EARTH_RADIUS_M = 6371000;
/** 大气顶海拔(米;Bruneton 参考域 60 km)。 */
export const ATMOSPHERE_TOP_M = 60000;
/** Rayleigh / Mie 标高(米)。 */
export const RAYLEIGH_SCALE_HEIGHT_M = 8000;
export const MIE_SCALE_HEIGHT_M = 1200;
/** Mie 吸收/散射比(Bruneton 参考标定 0.44/3.996)。 */
export const MIE_ABSORPTION_RATIO = 0.11;
/** 表标称浊度:生成基准,运行时按 turbidity/标称 缩放 Mie 分量。 */
export const ATMOSPHERE_REFERENCE_TURBIDITY = 4;
/** 表域:太阳天顶余弦下限(≈ -16.3°,覆盖民用暮光)与 γ 全域 [0,π]。 */
export const SUN_COSINE_TABLE_MIN = -0.28;
/** Lambert 地面反照率默认(灰土典型值;只影响下半球反射)。 */
export const DEFAULT_GROUND_ALBEDO = 0.1;

/** 表网格与域映射:μv、μs 非均匀(样本偏向低角度高梯度区),γ 均匀。 */
export interface AtmosphereGrid {
  readonly singleViewCount: number;
  readonly singleSunCount: number;
  readonly singleGammaCount: number;
  readonly multipleViewCount: number;
  readonly multipleSunCount: number;
  readonly viewExponent: number;
  readonly sunExponent: number;
}

/** 默认网格(生成脚本与运行时共享;运行时采样只用单散射/多散射各自计数)。 */
export const ATMOSPHERE_GRID: AtmosphereGrid = Object.freeze({
  singleViewCount: 16, singleSunCount: 16, singleGammaCount: 32,
  multipleViewCount: 16, multipleSunCount: 16,
  viewExponent: 1.5, sunExponent: 2,
});

/** μv 域映射:[0,1] → 观察天顶余弦(1=天顶,0=地平),幂偏向地平高梯度区。 */
export function viewMuFromTableU(u: number, exponent: number): number {
  return Math.pow(Math.min(Math.max(u, 0), 1), exponent);
}

/** μs 域映射:[0,1] → 太阳天顶余弦(SUN_COSINE_TABLE_MIN..1),幂偏向低太阳角。 */
export function sunMuFromTableU(u: number, exponent: number): number {
  const unit = Math.pow(Math.min(Math.max(u, 0), 1), exponent);
  return SUN_COSINE_TABLE_MIN + (1 - SUN_COSINE_TABLE_MIN) * unit;
}

/** 逆映射(表索引对齐与测试用)。 */
export function tableUFromSunMu(sunMu: number, exponent: number): number {
  const unit = (Math.min(Math.max(sunMu, SUN_COSINE_TABLE_MIN), 1) - SUN_COSINE_TABLE_MIN)
    / (1 - SUN_COSINE_TABLE_MIN);
  return Math.pow(unit, 1 / exponent);
}

/** 观察天顶余弦 → 表 u 坐标(viewMuFromTableU 的逆)。 */
export function tableUFromViewMu(viewMu: number, exponent: number): number {
  return Math.pow(Math.min(Math.max(viewMu, 0), 1), 1 / exponent);
}

/** Mie 散射系数(1/m):与 T09 同族 —— β_R,g × 0.75 × (turbidity/4),turbidity 域 [1.9,10]。 */
export function mieScatteringCoefficient(turbidity: number): number {
  return RAYLEIGH_BETA_RGB[1]! * 0.75 * (turbidity / 4);
}

/** Rayleigh 相函数(波长无关;波长权重全在系数上)。 */
export function rayleighPhaseFunction(cosGamma: number): number {
  return 3 / (16 * Math.PI) * (1 + cosGamma * cosGamma);
}

/** Mie 相函数(HG)。 */
export function miePhaseFunction(cosGamma: number, anisotropy: number): number {
  const g = Math.min(Math.max(anisotropy, -0.99), 0.99);
  const g2 = g * g;
  return (1 - g2) / (4 * Math.PI * Math.pow(1 + g2 - 2 * g * cosGamma, 1.5));
}

/** 海拔 z 的 Rayleigh/Mie 密度归一(地面=1)。 */
export function rayleighDensity(z: number): number {
  return Math.exp(-Math.max(z, 0) / RAYLEIGH_SCALE_HEIGHT_M);
}
export function mieDensity(z: number): number {
  return Math.exp(-Math.max(z, 0) / MIE_SCALE_HEIGHT_M);
}

/** 从海拔 z 沿当地天顶余弦 mu 到大气顶的弦长(米;球面二次方程正根)。 */
export function distanceToTop(z: number, mu: number): number {
  const radius = EARTH_RADIUS_M + Math.max(z, 0);
  const top = EARTH_RADIUS_M + ATMOSPHERE_TOP_M;
  return -radius * mu + Math.sqrt(Math.max(0, radius * radius * mu * mu - radius * radius + top * top));
}

/** 视线弦上参数 s 处海拔(观察点在地面)。 */
export function viewRayHeight(s: number, viewMu: number): number {
  return Math.sqrt(Math.max(0, EARTH_RADIUS_M * EARTH_RADIUS_M
    + 2 * EARTH_RADIUS_M * s * viewMu + s * s)) - EARTH_RADIUS_M;
}

/**
 * 地球阴影:太阳(无穷远平行光)能否照亮海拔 z、局部太阳天顶余弦 sunMu 的点。
 * 从该点沿太阳方向的光线与地球相交即地影(精确锥判据)。
 */
export function sunlit(z: number, sunMu: number): boolean {
  if (sunMu >= 0) return true;
  const radius = EARTH_RADIUS_M + Math.max(z, 0);
  const closest = radius * Math.sqrt(Math.max(0, 1 - sunMu * sunMu));
  return closest >= EARTH_RADIUS_M;
}

/** 光学深度数值积分步数(生成期;固定步数中点法保证确定性)。 */
const OPTICAL_DEPTH_STEPS = 64;

/**
 * 从海拔 z 沿当地天顶余弦 mu(可为负,但方向不得穿地球)到大气顶的
 * 每通道光学深度 ∫ (β_R·ρ_R + (β_M,sca+β_M,abs)·ρ_M) ds。
 */
export function opticalDepthToTop(z: number, mu: number, mieScattering: number): readonly [number, number, number] {
  const betaAbs = mieScattering * MIE_ABSORPTION_RATIO;
  const total = distanceToTop(z, mu);
  const step = total / OPTICAL_DEPTH_STEPS;
  const out: [number, number, number] = [0, 0, 0];
  for (let index = 0; index < OPTICAL_DEPTH_STEPS; index += 1) {
    const s = (index + 0.5) * step;
    const radius = EARTH_RADIUS_M + Math.max(z, 0);
    const height = Math.sqrt(Math.max(0, radius * radius + 2 * radius * s * mu + s * s)) - EARTH_RADIUS_M;
    const densityM = mieDensity(height);
    out[0] += (RAYLEIGH_BETA_RGB[0]! * rayleighDensity(height) + (mieScattering + betaAbs) * densityM) * step;
    out[1] += (RAYLEIGH_BETA_RGB[1]! * rayleighDensity(height) + (mieScattering + betaAbs) * densityM) * step;
    out[2] += (RAYLEIGH_BETA_RGB[2]! * rayleighDensity(height) + (mieScattering + betaAbs) * densityM) * step;
  }
  return out;
}

/** 单散射源积分的视线采样步数(生成期精度)。 */
export const SINGLE_SCATTERING_STEPS = 96;

export interface SingleScatteringSource {
  readonly rayleigh: Vec3;
  readonly mie: Vec3;
}

/**
 * 单散射源积分(phase 拆分,不含相函数):S_R/S_M(μv, μs, γ) 各 3 通道。
 * 太阳为无穷远平行光:点 X = O + sω 处的局部太阳天顶余弦 = (R·μs + s·cosγ)/|X|;
 * 逐采样点做地影测试,地影点贡献为零。视线消光用中点法逐段累积。
 */
export function singleScatteringSource(viewMu: number, sunMu: number, mieScattering: number,
  cosGamma: number): SingleScatteringSource {
  const betaAbs = mieScattering * MIE_ABSORPTION_RATIO;
  const viewMuClamped = Math.max(viewMu, 1e-4);
  const total = distanceToTop(0, viewMuClamped);
  const step = total / SINGLE_SCATTERING_STEPS;
  const rayleigh: [number, number, number] = [0, 0, 0];
  const mie: [number, number, number] = [0, 0, 0];
  let depthR = 0, depthG = 0, depthB = 0;
  for (let index = 0; index < SINGLE_SCATTERING_STEPS; index += 1) {
    const s = (index + 0.5) * step;
    const height = viewRayHeight(s, viewMuClamped);
    const localSunMu = (EARTH_RADIUS_M * sunMu + s * cosGamma) / (EARTH_RADIUS_M + height);
    if (sunlit(height, localSunMu)) {
      const sunDepth = opticalDepthToTop(height, localSunMu, mieScattering);
      const densityR = rayleighDensity(height), densityM = mieDensity(height);
      rayleigh[0] += Math.exp(-(depthR + sunDepth[0])) * densityR * step;
      rayleigh[1] += Math.exp(-(depthG + sunDepth[1])) * densityR * step;
      rayleigh[2] += Math.exp(-(depthB + sunDepth[2])) * densityR * step;
      mie[0] += Math.exp(-(depthR + sunDepth[0])) * densityM * step;
      mie[1] += Math.exp(-(depthG + sunDepth[1])) * densityM * step;
      mie[2] += Math.exp(-(depthB + sunDepth[2])) * densityM * step;
    }
    depthR += (RAYLEIGH_BETA_RGB[0]! * rayleighDensity(height) + (mieScattering + betaAbs) * mieDensity(height)) * step;
    depthG += (RAYLEIGH_BETA_RGB[1]! * rayleighDensity(height) + (mieScattering + betaAbs) * mieDensity(height)) * step;
    depthB += (RAYLEIGH_BETA_RGB[2]! * rayleighDensity(height) + (mieScattering + betaAbs) * mieDensity(height)) * step;
  }
  return {
    rayleigh: Object.freeze([rayleigh[0] * RAYLEIGH_BETA_RGB[0]!, rayleigh[1] * RAYLEIGH_BETA_RGB[1]!,
      rayleigh[2] * RAYLEIGH_BETA_RGB[2]!]) as Vec3,
    mie: Object.freeze([mie[0] * mieScattering, mie[1] * mieScattering, mie[2] * mieScattering]) as Vec3,
  };
}

/** 三线性插值标量场(行主序 [x,y,z] 网格,均匀域 [0,1]³;offset 支持分平面布局)。 */
export function sampleTrilinear(grid: readonly number[] | Float32Array, size: readonly [number, number, number],
  u: number, v: number, w: number, offset = 0): number {
  const [nx, ny, nz] = size;
  const x = Math.min(Math.max(u, 0), 1) * (nx - 1);
  const y = Math.min(Math.max(v, 0), 1) * (ny - 1);
  const z = Math.min(Math.max(w, 0), 1) * (nz - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const x1 = Math.min(x0 + 1, nx - 1), y1 = Math.min(y0 + 1, ny - 1), z1 = Math.min(z0 + 1, nz - 1);
  const fx = x - x0, fy = y - y0, fz = z - z0;
  const at = (ix: number, iy: number, iz: number): number => grid[offset + (ix * ny + iy) * nz + iz]!;
  const c00 = at(x0, y0, z0) * (1 - fx) + at(x1, y0, z0) * fx;
  const c10 = at(x0, y1, z0) * (1 - fx) + at(x1, y1, z0) * fx;
  const c01 = at(x0, y0, z1) * (1 - fx) + at(x1, y0, z1) * fx;
  const c11 = at(x0, y1, z1) * (1 - fx) + at(x1, y1, z1) * fx;
  return (c00 * (1 - fy) + c10 * fy) * (1 - fz) + (c01 * (1 - fy) + c11 * fy) * fz;
}

/** 一维线性插值(均匀域)。 */
export function sampleLinear(table: readonly number[] | Float32Array, domainMin: number, domainMax: number, x: number): number {
  const count = table.length;
  const t = Math.min(Math.max((x - domainMin) / (domainMax - domainMin), 0), 1) * (count - 1);
  const index = Math.floor(t), frac = t - index;
  return table[Math.min(index, count - 1)]! * (1 - frac) + table[Math.min(index + 1, count - 1)]! * frac;
}

/** 单散射表平面布局:6 平面(R 3 + M 3),每平面 NV·NS·NG。 */
export const SINGLE_TABLE_PLANES = 6;
/** 多散射表平面布局:4 平面(iso 3 + a 1),每平面 MV·MSN。 */
export const MULTIPLE_TABLE_PLANES = 4;

/**
 * 由表组装天空亮度(phase 拆分 + 低秩多散射;运行时/测试/生成自检共用单源):
 * L_c = P_R(γ)·S_R,c + P_M(γ)·mieScale·S_M,c + iso_c(μv,μs) + a(μv,μs)·P_R(γ)。
 * anisotropy 为 HG 非对称因子;out[0..2] 写入线性 RGB。
 */
export function assembleSkyLuminance(single: readonly number[] | Float32Array, multiple: readonly number[] | Float32Array,
  viewMu: number, sunMu: number, gamma: number, mieScale: number, anisotropy: number,
  out: Float32Array): void {
  const uView = tableUFromViewMu(viewMu, ATMOSPHERE_GRID.viewExponent);
  const uSun = tableUFromSunMu(sunMu, ATMOSPHERE_GRID.sunExponent);
  const uGamma = Math.min(Math.max(gamma, 0), Math.PI) / Math.PI;
  const cosGamma = Math.cos(gamma);
  const phaseR = rayleighPhaseFunction(cosGamma);
  const phaseM = miePhaseFunction(cosGamma, anisotropy);
  const singlePlane = ATMOSPHERE_GRID.singleViewCount * ATMOSPHERE_GRID.singleSunCount * ATMOSPHERE_GRID.singleGammaCount;
  const multiplePlane = ATMOSPHERE_GRID.multipleViewCount * ATMOSPHERE_GRID.multipleSunCount;
  for (let channel = 0; channel < 3; channel += 1) {
    const rayleigh = sampleTrilinear(single, [ATMOSPHERE_GRID.singleViewCount, ATMOSPHERE_GRID.singleSunCount,
      ATMOSPHERE_GRID.singleGammaCount], uView, uSun, uGamma, channel * singlePlane);
    const mie = sampleTrilinear(single, [ATMOSPHERE_GRID.singleViewCount, ATMOSPHERE_GRID.singleSunCount,
      ATMOSPHERE_GRID.singleGammaCount], uView, uSun, uGamma, (3 + channel) * singlePlane);
    const iso = sampleTrilinear(multiple, [ATMOSPHERE_GRID.multipleViewCount, ATMOSPHERE_GRID.multipleSunCount, 1],
      uView, uSun, 0, channel * multiplePlane);
    const coefficient = sampleTrilinear(multiple, [ATMOSPHERE_GRID.multipleViewCount, ATMOSPHERE_GRID.multipleSunCount, 1],
      uView, uSun, 0, 3 * multiplePlane);
    out[channel] = rayleigh * phaseR + mie * phaseM * mieScale + iso + coefficient * phaseR;
  }
}
