import type { WeatherMode } from "./scene.js";

/**
 * 天气→HDR 雾合同 v1：把 viewer 引擎各天气的 FogExp2 参数固化为版本化合同，
 * Web rig 与 Native 交付编译消费同一份值，禁止任何一侧另造天气默认值。
 * 粒子（rain/snow/storm）与灯光曝光因子不属于本合同。
 */
export const SCENE_WEATHER_FOG_VERSION = 1;

export interface SceneWeatherFogV1 {
  readonly version: typeof SCENE_WEATHER_FOG_VERSION;
  readonly kind: "exp2";
  /** 作者 sRGB hex，与 rig 原字面量逐位一致；Three 会转 linear 工作空间。 */
  readonly colorSrgbHex: string;
  readonly density: number;
}

const WEATHER_EXP2_FOG_V1: Record<WeatherMode, SceneWeatherFogV1> = {
  sunny: { version: 1, kind: "exp2", colorSrgbHex: "#9fc2d4", density: 0.0018 },
  cloudy: { version: 1, kind: "exp2", colorSrgbHex: "#87939a", density: 0.0042 },
  rain: { version: 1, kind: "exp2", colorSrgbHex: "#64717a", density: 0.008 },
  snow: { version: 1, kind: "exp2", colorSrgbHex: "#c5cdd1", density: 0.006 },
  fog: { version: 1, kind: "exp2", colorSrgbHex: "#aab4b7", density: 0.018 },
  storm: { version: 1, kind: "exp2", colorSrgbHex: "#38454f", density: 0.012 },
};

export function sceneWeatherFog(mode: WeatherMode): SceneWeatherFogV1 {
  return WEATHER_EXP2_FOG_V1[mode];
}

/** 粒子无关档：雾是该天气唯一可离线编译进运行包的视觉因子。 */
export function isParticleFreeWeather(mode: WeatherMode): boolean {
  return mode === "sunny" || mode === "cloudy" || mode === "fog";
}
