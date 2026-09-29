/**
 * I-C6 物理大气散射天空 —— opt-in 配置门(fail-closed,与 probeRadianceDirectionGate
 * 同契约)。
 *
 * == 门控语义(两段式,与仓内既有惯例对齐) ==
 * - `resolveAtmosphereSkyMode`:运行时配置边界,**永不抛错**——非法值 fail-closed
 *   回退 "neutral"(渲染循环不因脏配置中断),并给机器可读原因;
 * - `atmosphereSkyPresetForQuality`:作者质量档映射,非法档 fail-fast 抛错
 *   (与 probeRadianceDirectionPresetForQuality 同契约;作者期错误必须在接线处暴露)。
 *
 * == 默认关(Z1.5 基线只读) ==
 * 默认与质量档 performance/balanced 都是 "neutral"(引擎原生 studio IBL,即
 * studioDeepNeutralEnvironment 的无纹理兜底语义);只有作者显式 opt-in 或 quality 档
 * 显式映射才返回 "atmosphere"。Z1.5 中性环境是基线,大气天空是 opt-in 升级不是替换。
 *
 * == 白炉守恒边界(硬门) ==
 * atmosphere 模式产出 `radiance-hdr` 环境源(预计算表 → 等距柱状图),走既有
 * createHdrEnvironment 的 GGX 预滤波 + 辐照链 —— 天空替代的是"环境辐照输入",
 * 不引入任何能量放大;IBL 能量链零改动由白炉真机门背书。
 */

import { type AtmosphereSkyImage, type AtmosphereSkyParameters, atmosphereSkyEnvironmentImage } from "./atmosphereSky.js";
import type { Vec3 } from "./skyReference.js";

/** 天空模式:`neutral`(默认,Z1.5 基线)与 `atmosphere`(物理大气散射,opt-in)。 */
export type AtmosphereSkyMode = "neutral" | "atmosphere";

/** 天空配置:作者可选浊度/太阳方向/Mie 各向异性/地面反照率。 */
export interface AtmosphereSkyConfig {
  /** 大气浑浊度,论文有效域 [1.9,10](越界 fail-closed 回退 4)。 */
  readonly turbidity?: number;
  /** 太阳方向 ENU 单位矢量(非单位/非法 fail-closed 回退正午太阳)。 */
  readonly sunDirectionEnu?: Vec3;
  /** Mie HG 非对称因子 [-0.99,0.99](越界钳制,同 T09 采样域)。 */
  readonly mieAnisotropy?: number;
  /** 地面反照率 [0,1](越界钳制)。 */
  readonly groundAlbedo?: number;
}

/** 门控分辨率:模式 + 失效原因(机器可读)。 */
export interface AtmosphereSkyResolution {
  readonly mode: AtmosphereSkyMode;
  /** atmosphere 模式下已校准的天空参数;neutral 模式为 undefined。 */
  readonly parameters?: AtmosphereSkyParameters;
  /** true = 输入非法,已 fail-closed 回退 neutral/默认参数;渲染循环继续,不抛错。 */
  readonly failClosed: boolean;
  /** failClosed 时的机器可读原因;正常路径省略。 */
  readonly reason?: string;
}

const NEUTRAL_RESOLUTION: AtmosphereSkyResolution = Object.freeze({ mode: "neutral", failClosed: false });
const DEFAULT_TURBIDITY = 4;
const NOON_SUN: Vec3 = Object.freeze([0, 0.5, 0.8660254037844386]);
const FALLBACK_TURBIDITY_NOTE = "turbidity must be finite in [1.9, 10]";

function isUnitVector(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3
    && (value as readonly number[]).every(component => Number.isFinite(component))
    && Math.abs(Math.hypot(...(value as readonly number[])) - 1) <= 1e-4;
}

/**
 * 解析天空配置:`undefined`/"neutral" → neutral(默认关);合法 config 对象 →
 * atmosphere(逐字段校准,越界字段钳制并记 reason);其余一切(数字/数组/乱串/
 * 非法 config)fail-closed 回退 neutral。产品接线处应调用的唯一入口。
 */
export function resolveAtmosphereSkyMode(
  value?: "neutral" | "atmosphere" | AtmosphereSkyConfig): AtmosphereSkyResolution {
  if (value === undefined || value === "neutral") return NEUTRAL_RESOLUTION;
  if (value === "atmosphere") {
    return Object.freeze({
      mode: "atmosphere", failClosed: false,
      parameters: Object.freeze({
        turbidity: DEFAULT_TURBIDITY, sunDirectionEnu: NOON_SUN,
      }),
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Object.freeze({
      mode: "neutral", failClosed: true,
      reason: `Atmosphere sky config must be "neutral", "atmosphere" or a config object; got `
        + `${Array.isArray(value) ? "array" : typeof value}; failed closed to neutral.`,
    });
  }
  const reasons: string[] = [];
  let turbidity = DEFAULT_TURBIDITY;
  if (value.turbidity !== undefined) {
    if (Number.isFinite(value.turbidity) && value.turbidity >= 1.9 && value.turbidity <= 10) {
      turbidity = value.turbidity;
    } else {
      reasons.push(`${FALLBACK_TURBIDITY_NOTE}; clamped to ${DEFAULT_TURBIDITY}`);
    }
  }
  let sunDirectionEnu = NOON_SUN;
  if (value.sunDirectionEnu !== undefined) {
    if (isUnitVector(value.sunDirectionEnu)) sunDirectionEnu = value.sunDirectionEnu;
    else reasons.push("sunDirectionEnu must be a finite unit vector; clamped to noon default");
  }
  let mieAnisotropy: number | undefined;
  if (value.mieAnisotropy !== undefined) {
    if (Number.isFinite(value.mieAnisotropy)) {
      mieAnisotropy = Math.min(Math.max(value.mieAnisotropy, -0.99), 0.99);
    } else reasons.push("mieAnisotropy must be finite; clamped to 0.8 default");
  }
  let groundAlbedo: number | undefined;
  if (value.groundAlbedo !== undefined) {
    if (Number.isFinite(value.groundAlbedo)) {
      groundAlbedo = Math.min(Math.max(value.groundAlbedo, 0), 1);
    } else reasons.push("groundAlbedo must be finite; clamped to 0.1 default");
  }
  const parameters: AtmosphereSkyParameters = Object.freeze({
    turbidity, sunDirectionEnu,
    ...(mieAnisotropy === undefined ? {} : { mieAnisotropy }),
    ...(groundAlbedo === undefined ? {} : { groundAlbedo }),
  });
  return Object.freeze({
    mode: "atmosphere", parameters,
    failClosed: reasons.length > 0,
    ...(reasons.length > 0 ? { reason: reasons.join("; ") } : {}),
  });
}

/** 质量档词汇(与 DeepGiQuality 同词表;跨包不导入,靠对拍测试钉死)。 */
export type AtmosphereSkyQuality = "performance" | "balanced" | "quality";

/**
 * 质量档 → 天空模式映射:performance/balanced 保持 neutral(默认),quality 档
 * opt-in atmosphere。非法档 fail-fast(作者期错误必须在接线处暴露)。
 */
export function atmosphereSkyPresetForQuality(quality: AtmosphereSkyQuality): AtmosphereSkyMode {
  switch (quality) {
    case "performance":
    case "balanced":
      return "neutral";
    case "quality":
      return "atmosphere";
    default:
      throw new RangeError("Invalid atmosphere sky quality.");
  }
}

/** atmosphere 模式的环境图(等距柱状,RadianceHdrImage 形状;width/height 可调)。 */
export function atmosphereSkyImage(parameters: AtmosphereSkyParameters,
  width?: number, height?: number): AtmosphereSkyImage {
  return atmosphereSkyEnvironmentImage(parameters, width, height);
}
