import type { RuntimeAuthorColorGrading, RuntimeAuthorFog, RuntimeSolidEnvironment } from "@bim-studio/deep-engine/runtime-package";
import type { ScenePostProcessingState, WeatherMode } from "@bim-studio/contracts";
import { isParticleFreeWeather, sceneWeatherFog } from "@bim-studio/contracts";
import { compileSceneLighting } from "./compileSceneLighting.ts";

/** 消费纯色或内置摄影棚环境；外部 HDR 由独立编译链处理。 */
export function compileSceneEnvironment(value: unknown, authorLighting?: unknown, weather?: unknown,
  origin?: { readonly x: number; readonly y: number; readonly z: number },
  postProcessing?: unknown): RuntimeSolidEnvironment | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const builtinStudio = source.skybox === "studio";
  if (Object.keys(source).some(key => !["gridVisible", "backgroundColor", "skybox", "environmentMapUrl",
    "environmentMapName", "environmentAsBackground", "environmentIntensity"].includes(key))
    || typeof source.gridVisible !== "boolean"
    || (!builtinStudio && source.skybox !== "none")
    || (source.environmentMapUrl !== undefined && source.environmentMapUrl !== "")
    || (source.environmentMapName !== undefined && typeof source.environmentMapName !== "string")
    || (source.environmentAsBackground !== undefined && typeof source.environmentAsBackground !== "boolean")
    || (source.environmentIntensity !== undefined && (typeof source.environmentIntensity !== "number"
      || !Number.isFinite(source.environmentIntensity) || source.environmentIntensity < 0))
    || typeof source.backgroundColor !== "string" || !/^#[0-9a-f]{6}$/i.test(source.backgroundColor)) return undefined;
  const color = source.backgroundColor;
  const lighting = compileSceneLighting(authorLighting, weather, origin, builtinStudio);
  const shadows = lighting?.localLights?.some(light => light.castShadow);
  const pointShadow = lighting?.localLights?.some(light => light.castShadow && light.kind === "point");
  const fog = compileSceneWeatherFog(weather, postProcessing);
  // F4 作者色彩分级：非中性六通道随 v9 档进运行包（Native AuthorGrading 消费），
  // 不再静默丢弃；中性/关闭保持旧档字节逐位不变。
  const grading = compileAuthorColorGrading(postProcessing);
  if (grading) return { schema: "deep-engine.solid-environment", schemaVersion: 9, id: "scene.environment", revision: 1,
    kind: builtinStudio ? "solid-background-builtin-ibl" : "solid-background-no-ibl",
    outputTransform: "native-aces-grading-v9", ...(lighting ? { lighting } : {}), ...(fog ? { fog } : {}),
    colorGrading: grading,
    backgroundSrgb: [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255) as [number, number, number] };
  if (builtinStudio) return { schema: "deep-engine.solid-environment", schemaVersion: 8, id: "scene.environment", revision: 1,
    kind: "solid-background-builtin-ibl", outputTransform: "native-aces-studio-v8", ...(lighting ? { lighting } : {}), ...(fog ? { fog } : {}),
    backgroundSrgb: [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255) as [number, number, number] };
  if (fog) return { schema: "deep-engine.solid-environment", schemaVersion: 7, id: "scene.environment", revision: 1,
    kind: "solid-background-no-ibl", outputTransform: "native-aces-fog-v7", ...(lighting ? { lighting } : {}), fog,
    backgroundSrgb: [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255) as [number, number, number] };
  return { schema: "deep-engine.solid-environment", schemaVersion: pointShadow ? 5 : shadows ? 4 : lighting?.localLights ? 3 : lighting ? 2 : 1, id: "scene.environment", revision: 1,
    kind: "solid-background-no-ibl", outputTransform: pointShadow ? "native-aces-local-shadows-v5" : shadows ? "native-aces-spot-shadows-v4" : lighting?.localLights ? "native-aces-lights-v3" : lighting ? "native-aces-light-v2" : "native-aces-v1", ...(lighting ? { lighting } : {}),
    backgroundSrgb: [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16) / 255) as [number, number, number] };
}

/**
 * 作者色彩分级（postProcessing.colorGrading 六通道）→ v9 运行包载荷。
 * 六通道范围与属性面板/Native AuthorGrading::new 三方一致：hue ±180（度），其余 ±1；
 * 开关关闭或六通道全零视为中性（返回 undefined，编译走旧档）。
 * 非法数值返回 undefined 让环境退回旧档编译，字段留在 deferred 由门禁显式声明——
 * 不静默声明为已编译能力。
 */
function compileAuthorColorGrading(postProcessing: unknown): RuntimeAuthorColorGrading | undefined {
  if (!postProcessing || typeof postProcessing !== "object" || Array.isArray(postProcessing)) return undefined;
  const state = postProcessing as ScenePostProcessingState;
  if (state.colorGrading !== true) return undefined;
  const channels = { hue: state.hue ?? 0, saturation: state.saturation ?? 0, brightness: state.brightness ?? 0,
    contrast: state.contrast ?? 0, temperature: state.temperature ?? 0, tint: state.tint ?? 0 };
  const bounded = (value: number, limit: number) => Number.isFinite(value) && Math.abs(value) <= limit;
  if (!bounded(channels.hue, 180)
    || ![channels.saturation, channels.brightness, channels.contrast, channels.temperature, channels.tint]
      .every(value => bounded(value, 1))) return undefined;
  if (Object.values(channels).every(value => value === 0)) return undefined;
  return channels;
}

/** 天气雾合同 v1 → 运行包作者雾；sRGB→linear 与灯光颜色同一变换。
 * 粒子天气（rain/snow/storm）的粒子无法离线编译，整档不编译雾，weather 继续 deferred。 */
export function compileSceneWeatherFog(weather: unknown, postProcessing?: unknown): RuntimeAuthorFog | undefined {
  if (typeof weather !== "string" || !isParticleFreeWeather(weather as WeatherMode)) return undefined;
  const fog = sceneWeatherFog(weather as WeatherMode);
  const colorLinearRgb = [1, 3, 5].map(offset => {
    const v = parseInt(fog.colorSrgbHex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const volumetric = postProcessing && typeof postProcessing === "object" && !Array.isArray(postProcessing)
    && (postProcessing as ScenePostProcessingState).enabled === true
    && (postProcessing as ScenePostProcessingState).volumetricFog === true;
  if (!volumetric) return { schemaVersion: 1, kind: "exp2", colorLinearRgb, density: fog.density };
  const state = postProcessing as ScenePostProcessingState;
  return { schemaVersion: 1, kind: "volumetric", colorLinearRgb, density: fog.density,
    steps: state.volumetricFogSteps ?? 48,
    height: state.volumetricFogHeight ?? 64,
    anisotropy: state.volumetricFogAnisotropy ?? 0.3 };
}
