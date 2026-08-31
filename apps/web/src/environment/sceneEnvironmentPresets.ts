import type {
  GlobalLightingState,
  SceneEnvironmentState,
  ScenePostProcessingState,
  SkyboxPreset,
  WeatherMode
} from "@bim-studio/contracts";

export type EnvironmentPresetFamily = "indoor" | "outdoor" | "night" | "weather";
export type EnvironmentPresetCost = "low" | "balanced";

export interface SceneEnvironmentPreset {
  id: string;
  name: string;
  englishName: string;
  description: string;
  englishDescription: string;
  family: EnvironmentPresetFamily;
  cost: EnvironmentPresetCost;
  preview: readonly [string, string, string];
  weather: WeatherMode;
  skybox: SkyboxPreset;
  backgroundColor: string;
  environmentIntensity: number;
  lightingIntensity: number;
  indirectLightIntensity: number;
  ambientOcclusionIntensity: number;
}

/**
 * 内置环境均由运行时生成，断网和桌面离线模式也可使用。
 * HDRI 资源单独按需下载，避免把大贴图塞进首屏包。
 */
export const SCENE_ENVIRONMENT_PRESETS: readonly SceneEnvironmentPreset[] = [
  preset("industrial-neutral", "工业中性", "Industrial neutral", "设备建模、方案评审", "Equipment authoring and review", "indoor", "balanced", ["#172126", "#75828a", "#d8d4ca"], "sunny", "studio", "#182127", 0.92, 1, 0.32, 0.72),
  preset("bright-workshop", "明亮车间", "Bright workshop", "白色设备与精密装配", "White equipment and precision assembly", "indoor", "balanced", ["#d9e1e3", "#eef2f1", "#cbd2d0"], "sunny", "bright-studio", "#dce2e2", 0.82, 1.08, 0.38, 0.58),
  preset("control-room", "控制室", "Control room", "深色操作台与发光状态", "Dark consoles and emissive status", "indoor", "balanced", ["#050b10", "#122b36", "#234955"], "sunny", "industrial-night", "#071015", 0.68, 0.82, 0.25, 0.8),
  preset("clean-room", "洁净空间", "Clean room", "实验室、洁净厂房", "Laboratory and clean manufacturing", "indoor", "balanced", ["#edf3f3", "#d9e6e8", "#bccbce"], "sunny", "bright-studio", "#e8eeee", 0.72, 1.12, 0.4, 0.5),
  preset("clear-campus", "晴朗园区", "Clear campus", "园区、物流与室外设备", "Campus, logistics and outdoor equipment", "outdoor", "balanced", ["#4e88b5", "#a6d2e8", "#e7eef0"], "sunny", "clear", "#9ec4d6", 0.96, 1.02, 0.3, 0.62),
  preset("overcast-site", "阴天工地", "Overcast site", "工程现场与材质核查", "Site inspection and material review", "outdoor", "low", ["#5d6970", "#a5adb0", "#d8d8d2"], "cloudy", "overcast", "#939da1", 0.82, 0.96, 0.36, 0.66),
  preset("logistics-dawn", "物流晨曦", "Logistics dawn", "仓储、港口与运输动线", "Warehousing, port and transport flow", "outdoor", "balanced", ["#263655", "#cf8d78", "#f1d5aa"], "sunny", "dawn", "#6e6571", 0.86, 0.9, 0.3, 0.7),
  preset("campus-sunset", "园区黄昏", "Campus sunset", "建筑轮廓与照明检查", "Building silhouette and lighting review", "outdoor", "balanced", ["#342b55", "#d27b72", "#f3c78f"], "sunny", "sunset", "#51435d", 0.9, 0.82, 0.27, 0.76),
  preset("night-operations", "夜间运行", "Night operations", "照明、告警与安防态势", "Lighting, alarms and security", "night", "balanced", ["#050a18", "#101d3b", "#26385b"], "sunny", "night", "#071020", 0.74, 0.68, 0.22, 0.86),
  preset("rain-inspection", "雨天巡检", "Rain inspection", "低能见度巡检演练", "Low-visibility inspection exercise", "weather", "balanced", ["#283844", "#64717a", "#9daeb7"], "rain", "overcast", "#39474f", 0.72, 0.86, 0.28, 0.8),
  preset("snow-yard", "雪天场站", "Snow yard", "寒区设备与场站展示", "Cold-region equipment and yard", "weather", "balanced", ["#71818a", "#c5cdd1", "#edf0ed"], "snow", "overcast", "#bac2c5", 0.8, 0.98, 0.38, 0.62),
  preset("fog-response", "雾天应急", "Fog response", "可见距离与应急路线检查", "Visibility and emergency route review", "weather", "low", ["#687478", "#aab4b7", "#d5d9d8"], "fog", "overcast", "#9ba4a6", 0.64, 0.84, 0.34, 0.56),
  preset("storm-response", "暴雨应急", "Storm response", "极端天气和告警演练", "Extreme weather and alarm exercise", "weather", "balanced", ["#18232c", "#38454f", "#687984"], "storm", "industrial-night", "#1a252c", 0.62, 0.72, 0.2, 0.9)
] as const;

export interface AppliedEnvironmentPreset {
  environment: SceneEnvironmentState;
  lighting: GlobalLightingState;
  postProcessing: ScenePostProcessingState;
  weather: WeatherMode;
}

/** 保留用户上传的环境贴图引用，只切换内置视觉参数。 */
export function applySceneEnvironmentPreset(
  preset: SceneEnvironmentPreset,
  current: Omit<AppliedEnvironmentPreset, "weather">
): AppliedEnvironmentPreset {
  return {
    weather: preset.weather,
    environment: {
      ...current.environment,
      skybox: preset.skybox,
      backgroundColor: preset.backgroundColor,
      environmentIntensity: preset.environmentIntensity
    },
    lighting: {
      ...current.lighting,
      enabled: true,
      intensity: preset.lightingIntensity,
      shadowsEnabled: true,
      reflectionsEnabled: true,
      globalIlluminationEnabled: true,
      globalIlluminationIntensity: preset.indirectLightIntensity
    },
    postProcessing: {
      ...current.postProcessing,
      enabled: true,
      smaa: true,
      gtao: true,
      gtaoIntensity: preset.ambientOcclusionIntensity
    }
  };
}

function preset(
  id: string,
  name: string,
  englishName: string,
  description: string,
  englishDescription: string,
  family: EnvironmentPresetFamily,
  cost: EnvironmentPresetCost,
  preview: readonly [string, string, string],
  weather: WeatherMode,
  skybox: SkyboxPreset,
  backgroundColor: string,
  environmentIntensity: number,
  lightingIntensity: number,
  indirectLightIntensity: number,
  ambientOcclusionIntensity: number
): SceneEnvironmentPreset {
  return { id, name, englishName, description, englishDescription, family, cost, preview, weather, skybox, backgroundColor, environmentIntensity, lightingIntensity, indirectLightIntensity, ambientOcclusionIntensity };
}
