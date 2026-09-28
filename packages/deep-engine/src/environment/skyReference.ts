/**
 * T09 切片一:物理天空 CPU 参考(大气散射)。
 *
 * 两个公开公式的自实现(不复制任何受限代码;引擎运行时 purity:零三方依赖):
 * 1. "analytic" —— 简化单次散射解析解:平面均匀大气(Rayleigh 1/λ⁴ + Mie-HG),
 *    视线/太阳路径 Beer-Lambert,散射积分有闭式(见 sampleAnalyticSky 注释)。
 *    Rayleigh 系数取 680/550/450 nm 标准海平面值(教科书常数,cf. Bodhaine, Wood &
 *    Solomon 1999, "Rayleigh scattering" 回顾);Mie 强度按浑浊度标定,为建模选择。
 *    绝对标尺归一(太阳辐照 E0 = 1 等能白),只承诺相对分布与确定性,不校准绝对辐亮度。
 * 2. "perez" —— Perez, Seals & Michalsky 1993 全天亮度分布 F(θ,γ) + Preetham,
 *    Shirley & Smits (SIGGRAPH'99) "A Practical Analytic Model for Daylight" 天顶亮度
 *    与系数表(论文 Table 2 亮度列);公式为论文公开内容。色度用 analytic 模型的
 *    RGB 比值(文献常见的混合做法,已注明),亮度单位 kcd/m²。
 *
 * 已知限制(如实声明):Preetham 天顶亮度式在太阳天顶角 →0 且低浑浊度时可能 ≤0
 * (论文拟合域限制),此时置 valid=false 并钳到正数下限;地平线路径用地球曲率封顶。
 * 全 f64 纯函数;同输入逐位同输出。
 */

import { henyeyGreensteinPhase } from "../fog/volumetricFog.js";
import { DEG2RAD } from "./solarPosition.js";

export type Vec3 = readonly [number, number, number];
export type SkyModelMode = "analytic" | "perez";

/** 680/550/450 nm 海平面 Rayleigh 散射系数(1/m)。 */
export const RAYLEIGH_BETA_RGB: readonly [number, number, number] = [5.8045e-6, 1.35629e-5, 3.02659e-5];
/** 均匀大气等效高度(米,标高近似)。 */
export const ATMOSPHERE_HEIGHT_M = 8000;
/** 地球半径(米),只用于地平线路径封顶。 */
export const EARTH_RADIUS_M = 6371000;
/** 太阳在地平以下时散射照度的平滑熄灭窗口(度)。 */
export const TWILIGHT_FADE_DEG = 4;

export interface SkyReferenceParameters {
  readonly mode: SkyModelMode;
  /** 大气浑浊度,论文有效域 [1.9, 10]。 */
  readonly turbidity: number;
  /** 太阳方向(ENU,单位矢量,up>0 为在地平线上)。 */
  readonly sunDirectionEnu: Vec3;
  /** Mie 各向异性(analytic 模式),[-0.99, 0.99]。 */
  readonly mieAnisotropy?: number;
}

export interface SkySample {
  /** 线性 RGB。analytic:归一化辐亮度;perez:以天顶色归一的相对色度。 */
  readonly rgb: Vec3;
  /** perez 模式的绝对亮度(kcd/m²);analytic 模式为 null(未做光度学标定)。 */
  readonly luminanceKcdPerM2: number | null;
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

export function rayleighPhase(cosGamma: number): number {
  return 3 / (16 * Math.PI) * (1 + cosGamma * cosGamma);
}

/** 视线路径长:平面大气 h/cosθ,地球曲率封顶(θ→地平线时发散)。 */
export function viewPathLengthMeters(cosViewZenith: number): number {
  const clamped = Math.max(cosViewZenith, 1e-4);
  const horizonPath = Math.sqrt(2 * EARTH_RADIUS_M * ATMOSPHERE_HEIGHT_M + ATMOSPHERE_HEIGHT_M ** 2);
  return Math.min(ATMOSPHERE_HEIGHT_M / clamped, horizonPath);
}

/** 太阳在地平下的平滑熄灭因子(−4°..0° 线性 smoothstep 3t²−2t³);地平上恒为 1。 */
export function solarVisibility(sunUpComponent: number): number {
  if (sunUpComponent >= 0) return 1;
  const t = Math.min(1, -sunUpComponent / (TWILIGHT_FADE_DEG * DEG2RAD));
  return 1 - (t * t * (3 - 2 * t));
}

/**
 * analytic 单次散射解析解。
 * 视点在地面,视线天顶角 θv,路径长 L=h/cosθv(封顶);高度 h(s)=s·cosθv。
 * 均匀介质散射积分:
 *   I = ∫₀ᴸ exp(−βtot·s − βtot·(hA−s·cosθv)/cosθs) ds
 *     = exp(−βtot·hA/cosθs) · (1 − exp(−k·L)) / k,  k = βtot·(1 − cosθv/cosθs)
 * k→0 时取极限 I = exp(−βtot·hA/cosθs)·L;数值稳定用 expm1。
 */
export function sampleAnalyticSky(parameters: SkyReferenceParameters, viewDirectionEnu: Vec3): SkySample {
  const [sx, sy, sz] = parameters.sunDirectionEnu;
  const [vx, vy, vz] = viewDirectionEnu;
  const cosGamma = clampUnit(sx * vx + sy * vy + sz * vz);
  const cosView = clampUnit(vz);
  const cosSun = clampUnit(sz);
  const visibility = solarVisibility(sz);
  const mieBeta = RAYLEIGH_BETA_RGB[1]! * 0.75 * (parameters.turbidity / 4);
  const g = parameters.mieAnisotropy ?? 0.8;
  const rgb: [number, number, number] = [0, 0, 0];
  if (cosSun <= 0 && visibility <= 0) return { rgb: Object.freeze(rgb) as Vec3, luminanceKcdPerM2: null };
  const pathLength = viewPathLengthMeters(cosView);
  for (let channel = 0; channel < 3; channel += 1) {
    const rayleigh = RAYLEIGH_BETA_RGB[channel]!;
    const betaTotal = rayleigh + mieBeta;
    const scatteringCoefficient = rayleigh * rayleighPhase(cosGamma) + mieBeta * henyeyGreensteinPhase(cosGamma, g);
    const sunOpticalDepth = betaTotal * ATMOSPHERE_HEIGHT_M / Math.max(cosSun, 1e-4);
    const sunTerm = Math.exp(-sunOpticalDepth) * visibility;
    const k = betaTotal * (1 - cosView / Math.max(cosSun, 1e-4));
    const integral = Math.abs(k * pathLength) < 1e-8
      ? Math.exp(-sunOpticalDepth) * pathLength
      : Math.exp(-sunOpticalDepth) * (-Math.expm1(-k * pathLength) / k);
    rgb[channel] = sunTerm * scatteringCoefficient * integral;
  }
  return { rgb: Object.freeze(rgb) as Vec3, luminanceKcdPerM2: null };
}

/** Preetham'99 式(7):天顶亮度(kcd/m²)。负值或 >60(χ→π/2 渐近线失控)时判 invalid:
 * 论文拟合域不含太阳近天顶的低浑浊度组合,这是已知限制而非本实现的偏差。 */
export function preethamZenithLuminanceKcd(turbidity: number, sunZenithRad: number): { kcd: number; valid: boolean } {
  const chi = (4 / 9 - turbidity / 120) * Math.pow(Math.PI - 2 * sunZenithRad, 4 / 3);
  const kcd = (1000 * (4.0453 * turbidity - 4.971) * Math.tan(chi) - 0.2155 * turbidity + 2.4192) * 1e-4;
  if (!Number.isFinite(kcd) || kcd <= 0 || kcd > 60) return { kcd: 1e-6, valid: false };
  return { kcd, valid: true };
}

/**
 * Perez'93 亮度分布,Preetham'99 Table 2 亮度行系数(浑浊度线性式)。
 * 论文归一:L(θ,γ) = Yz·F(θ,γ)/F(0,θs) —— 分母是"天顶视向(θ=0)与太阳夹角 γ=θs"
 * 处的 F 值,不是 γ=0(那是太阳本身的方向,含 circumssolar 峰)。
 */
export function perezLuminanceDistribution(cosViewZenith: number, cosGamma: number,
  turbidity: number, sunZenithRad: number): { relative: number; zenith: number } {
  const cosView = clampUnit(cosViewZenith);
  const inverseCosView = 1 / Math.max(cosView, 0.02); // θ≤88.5°,超出按 88.5° 钳制并注明
  const gamma = Math.acos(clampUnit(cosGamma));
  const grad = 0.17872 * turbidity - 1.46303;
  const gradBright = -0.3554 * turbidity + 0.42749;
  const circumsolar = -0.02266 * turbidity + 5.32505;
  const circumsolarSlope = 0.12064 * turbidity - 2.57705;
  const horizonDark = -0.06696 * turbidity + 0.37027;
  // F(θ,γ) = (1 + A·e^{B/cosθ})·(1 + C·e^{D·γ} + E·cos²γ);B<0,cosθ→0 时第一因子→1(地平增亮)。
  const evaluate = (inverseCos: number, angle: number): number =>
    (1 + grad * Math.exp(gradBright * inverseCos))
    * (1 + circumsolar * Math.exp(circumsolarSlope * angle) + horizonDark * Math.cos(angle) ** 2);
  const zenithReference = evaluate(1, sunZenithRad);
  const directionValue = evaluate(inverseCosView, gamma);
  return { relative: directionValue / zenithReference, zenith: zenithReference };
}

/** perez 模式采样:Perez 相对亮度 × Preetham 天顶亮度(kcd/m²),色度来自 analytic RGB 比值。 */
export function samplePerezSky(parameters: SkyReferenceParameters, viewDirectionEnu: Vec3): SkySample {
  const [sx, sy, sz] = parameters.sunDirectionEnu;
  const [vx, vy, vz] = viewDirectionEnu;
  const cosGamma = clampUnit(sx * vx + sy * vy + sz * vz);
  const sunZenith = Math.acos(clampUnit(sz));
  const zenith = preethamZenithLuminanceKcd(parameters.turbidity, sunZenith);
  const distribution = perezLuminanceDistribution(vz, cosGamma, parameters.turbidity, sunZenith);
  // 色度:analytic 模型本方向 RGB ÷ 其天顶 RGB(避免除零:analytic 天顶亮度恒 >0 于白昼)。
  const daylightSun: Vec3 = sz > 0 ? [sx, sy, sz] : [sx, sy, Math.abs(sz) + 1e-4];
  const directionChroma = sampleAnalyticSky({ ...parameters, mode: "analytic", sunDirectionEnu: daylightSun }, viewDirectionEnu).rgb;
  const zenithChroma = sampleAnalyticSky({ ...parameters, mode: "analytic", sunDirectionEnu: daylightSun }, [0, 0, 1]).rgb;
  const chroma: [number, number, number] = [
    directionChroma[0] / zenithChroma[0], directionChroma[1] / zenithChroma[1], directionChroma[2] / zenithChroma[2],
  ];
  return {
    rgb: Object.freeze(chroma) as Vec3,
    luminanceKcdPerM2: distribution.relative * zenith.kcd,
  };
}

export function sampleSkyReference(parameters: SkyReferenceParameters, viewDirectionEnu: Vec3): SkySample {
  if (!Number.isFinite(parameters.turbidity) || parameters.turbidity < 1.9 || parameters.turbidity > 10) {
    throw new RangeError("Sky turbidity must be finite in [1.9, 10].");
  }
  const sunLength = Math.hypot(...parameters.sunDirectionEnu);
  if (!Number.isFinite(sunLength) || Math.abs(sunLength - 1) > 1e-4) {
    throw new RangeError("Sky sunDirectionEnu must be a unit vector.");
  }
  const viewLength = Math.hypot(...viewDirectionEnu);
  if (!Number.isFinite(viewLength) || Math.abs(viewLength - 1) > 1e-4) {
    throw new RangeError("Sky viewDirectionEnu must be a unit vector.");
  }
  return parameters.mode === "perez"
    ? samplePerezSky(parameters, viewDirectionEnu)
    : sampleAnalyticSky(parameters, viewDirectionEnu);
}

/** 沿太阳方向到大气顶的通道透射率(含地平下熄灭);供天气系统/太阳强度映射复用。 */
export function solarTransmittance(parameters: SkyReferenceParameters): Vec3 {
  const cosSun = clampUnit(parameters.sunDirectionEnu[2]);
  const visibility = solarVisibility(parameters.sunDirectionEnu[2]);
  const mieBeta = RAYLEIGH_BETA_RGB[1] * 0.75 * (parameters.turbidity / 4);
  const rgb: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const betaTotal = RAYLEIGH_BETA_RGB[channel]! + mieBeta;
    rgb[channel] = Math.exp(-betaTotal * ATMOSPHERE_HEIGHT_M / Math.max(cosSun, 1e-4)) * visibility;
  }
  return Object.freeze(rgb) as Vec3;
}
