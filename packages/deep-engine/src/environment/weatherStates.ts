/**
 * T09 切片一:天气状态机与统一参数映射(CPU 参考)。
 *
 * 与契约层的单一事实来源关系(不另造默认值):
 * - WeatherMode 六档字面量与 `packages/contracts/src/scene.ts` 一致(引擎无 contracts
 *   依赖,本文件本地声明;漂移由测试的字面量副本兜住);
 * - 各档雾(exp2 sRGB 颜色 + 密度)逐位取自 contracts `sceneWeatherFog` v1 冻结表,
 *   Web rig 与 Native 消费同一合同;本文件测试断言副本与合同值相等,合同改动即测试红。
 * - 云量/湿度/直射光衰减/降水率/体积介质是引擎参考扩展(合同不含这些维度);
 *   体积介质 baseExtinction 由合同 exp2 密度经 equivalentBeerExtinction(ρ, 100 m)
 *   等透射换算(推导见 fogReference.ts)。
 *
 * 过渡曲线:`weatherTransition(from, to, t01)` 为 t 的纯函数(smoothstep 确定性混合):
 * - 密度/消光/高度尺度在对数域插值(跨量级密度线性插值会失真),中点 = 几何平均,
 *   端点 t=0/1 精确还原 from/to;颜色 sRGB→线性后线性插值;标量线性插值。
 * - 全 f64;同输入逐位同输出。
 */

import type { VolumetricMedium } from "../fog/volumetricFog.js";
import { equivalentBeerExtinction } from "./fogReference.js";

export type WeatherMode = "sunny" | "cloudy" | "rain" | "snow" | "fog" | "storm";

/** 合同 exp2 雾等透射换算的参考深度(米);推导记录于 fogReference.ts。 */
export const WEATHER_EQUIVALENT_BEER_DEPTH_M = 100;

export interface WeatherEnvironmentParams {
  /** 与 contracts sceneWeatherFog.colorSrgbHex 逐位一致。 */
  readonly fogColorSrgbHex: string;
  /** 与 contracts sceneWeatherFog.density 逐位一致。 */
  readonly fogExp2Density: number;
  /** 天空云量参考 [0,1](引擎扩展维度)。 */
  readonly cloudiness: number;
  /** 空气湿度参考 [0,1](引擎扩展维度)。 */
  readonly humidity: number;
  /** 直射光(太阳)强度缩放参考 [0,1](引擎扩展维度)。 */
  readonly sunIntensityScale: number;
  /** 降水粒子强度参考 ≥0:0 无降水;合同注明 rain/snow/storm 属粒子维度(引擎扩展)。 */
  readonly precipitationRate: number;
  /** 体积雾介质:baseExtinction = equivalentBeerExtinction(雾密度, 100m)。 */
  readonly volumetric: VolumetricMedium;
}

interface WeatherEnvironmentSeed {
  readonly fogColorSrgbHex: string;
  readonly fogExp2Density: number;
  readonly cloudiness: number;
  readonly humidity: number;
  readonly sunIntensityScale: number;
  readonly precipitationRate: number;
  readonly scaleHeight: number;
  readonly anisotropy: number;
}

// 雾两字段 = contracts sceneWeatherFog v1 冻结值(漂移测试断言);其余为引擎参考标定。
const WEATHER_SEEDS: Readonly<Record<WeatherMode, WeatherEnvironmentSeed>> = {
  sunny: { fogColorSrgbHex: "#9fc2d4", fogExp2Density: 0.0018, cloudiness: 0.12, humidity: 0.30, sunIntensityScale: 1.00, precipitationRate: 0.0, scaleHeight: 120, anisotropy: 0.00 },
  cloudy: { fogColorSrgbHex: "#87939a", fogExp2Density: 0.0042, cloudiness: 0.75, humidity: 0.65, sunIntensityScale: 0.55, precipitationRate: 0.0, scaleHeight: 90, anisotropy: 0.10 },
  rain: { fogColorSrgbHex: "#64717a", fogExp2Density: 0.008, cloudiness: 0.92, humidity: 0.95, sunIntensityScale: 0.35, precipitationRate: 1.0, scaleHeight: 60, anisotropy: 0.25 },
  snow: { fogColorSrgbHex: "#c5cdd1", fogExp2Density: 0.006, cloudiness: 0.85, humidity: 0.85, sunIntensityScale: 0.55, precipitationRate: 0.6, scaleHeight: 50, anisotropy: 0.15 },
  fog: { fogColorSrgbHex: "#aab4b7", fogExp2Density: 0.018, cloudiness: 0.55, humidity: 1.00, sunIntensityScale: 0.40, precipitationRate: 0.0, scaleHeight: 20, anisotropy: 0.30 },
  storm: { fogColorSrgbHex: "#38454f", fogExp2Density: 0.012, cloudiness: 0.98, humidity: 1.00, sunIntensityScale: 0.20, precipitationRate: 1.4, scaleHeight: 70, anisotropy: 0.20 },
};

function materialize(seed: WeatherEnvironmentSeed): WeatherEnvironmentParams {
  return {
    fogColorSrgbHex: seed.fogColorSrgbHex,
    fogExp2Density: seed.fogExp2Density,
    cloudiness: seed.cloudiness,
    humidity: seed.humidity,
    sunIntensityScale: seed.sunIntensityScale,
    precipitationRate: seed.precipitationRate,
    volumetric: {
      baseExtinction: equivalentBeerExtinction(seed.fogExp2Density, WEATHER_EQUIVALENT_BEER_DEPTH_M),
      scaleHeight: seed.scaleHeight,
      anisotropy: seed.anisotropy,
      albedo: 0.9,
    },
  };
}

/** 天气→统一环境参数映射表(冻结;按 mode 查询,未知 mode 抛错)。 */
export const WEATHER_ENVIRONMENT_PARAMS: Readonly<Record<WeatherMode, WeatherEnvironmentParams>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(WEATHER_SEEDS) as WeatherMode[]).map(mode => [mode, materialize(WEATHER_SEEDS[mode])]),
  ) as Record<WeatherMode, WeatherEnvironmentParams>,
);

export function weatherEnvironment(mode: WeatherMode): WeatherEnvironmentParams {
  const params = (WEATHER_ENVIRONMENT_PARAMS as Record<string, WeatherEnvironmentParams | undefined>)[mode];
  if (!params) throw new RangeError(`Unknown weather mode: ${String(mode)}`);
  return params;
}

/** sRGB hex(#rrggbb)→ 线性 RGB(IEC 61966-2-1 分段展开);供颜色插值与 HDR 合成使用。 */
export function srgbHexToLinearRgb(hex: string): readonly [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new RangeError(`Invalid sRGB hex: ${hex}`);
  const channel = (text: string): number => {
    const normalized = parseInt(text, 16) / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return [channel(hex.slice(1, 3)), channel(hex.slice(3, 5)), channel(hex.slice(5, 7))];
}

function smoothstep(t: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped * clamped * (3 - 2 * clamped);
}

function lerp(from: number, to: number, weight: number): number {
  return from + (to - from) * weight;
}

/** 对数域插值;端点与同值短路保证精确(消除 exp∘ln 往返 1ulp 漂移),任一端为 0 回退线性。 */
function lerpPositive(from: number, to: number, weight: number): number {
  if (from === to || weight <= 0) return from;
  if (weight >= 1) return to;
  if (from <= 0 || to <= 0) return lerp(from, to, weight);
  return Math.exp(lerp(Math.log(from), Math.log(to), weight));
}

export interface WeatherTransitionSample {
  readonly from: WeatherMode;
  readonly to: WeatherMode;
  /** 输入的归一化时间(夹取 [0,1]);smoothstep 后的混合权重。 */
  readonly rawT: number;
  readonly weight: number;
  /** 过渡中的雾密度(exp2 口径,对数域插值)。 */
  readonly fogExp2Density: number;
  /** 过渡中的雾颜色(线性 RGB;sRGB 端点插值)。 */
  readonly fogColorLinearRgb: readonly [number, number, number];
  readonly cloudiness: number;
  readonly humidity: number;
  readonly sunIntensityScale: number;
  readonly precipitationRate: number;
  /** 过渡中的体积介质(baseExtinction/scaleHeight 对数域插值)。 */
  readonly volumetric: VolumetricMedium;
}

/** 天气过渡采样:同输入逐位同输出;t∈[0,1] 夹取;端点精确还原端档参数。 */
export function weatherTransition(from: WeatherMode, to: WeatherMode, t01: number): WeatherTransitionSample {
  if (!Number.isFinite(t01)) throw new RangeError("weatherTransition t01 must be finite.");
  const a = weatherEnvironment(from);
  const b = weatherEnvironment(to);
  const t = Math.max(0, Math.min(1, t01));
  const weight = smoothstep(t);
  const fromLinear = srgbHexToLinearRgb(a.fogColorSrgbHex);
  const toLinear = srgbHexToLinearRgb(b.fogColorSrgbHex);
  return {
    from, to, rawT: t, weight,
    fogExp2Density: lerpPositive(a.fogExp2Density, b.fogExp2Density, weight),
    fogColorLinearRgb: [
      lerp(fromLinear[0], toLinear[0], weight),
      lerp(fromLinear[1], toLinear[1], weight),
      lerp(fromLinear[2], toLinear[2], weight),
    ],
    cloudiness: lerp(a.cloudiness, b.cloudiness, weight),
    humidity: lerp(a.humidity, b.humidity, weight),
    sunIntensityScale: lerp(a.sunIntensityScale, b.sunIntensityScale, weight),
    precipitationRate: lerp(a.precipitationRate, b.precipitationRate, weight),
    volumetric: {
      baseExtinction: lerpPositive(a.volumetric.baseExtinction, b.volumetric.baseExtinction, weight),
      scaleHeight: lerpPositive(a.volumetric.scaleHeight, b.volumetric.scaleHeight, weight),
      anisotropy: lerp(a.volumetric.anisotropy, b.volumetric.anisotropy, weight),
      albedo: lerp(a.volumetric.albedo, b.volumetric.albedo, weight),
    },
  };
}

/** 过渡时长参考(秒):按档位跳变幅度分档,供运行时间表消费;非合同。 */
export function weatherTransitionDurationSeconds(from: WeatherMode, to: WeatherMode): number {
  if (from === to) return 0;
  const magnitude = Math.abs(Math.log(weatherEnvironment(to).fogExp2Density)
    / Math.log(weatherEnvironment(from).fogExp2Density));
  const ratio = Math.max(magnitude, 1 / magnitude);
  // 密度跨量级越大过渡越长;下限 2s、上限 8s。
  return Math.min(8, Math.max(2, 2 * ratio));
}
