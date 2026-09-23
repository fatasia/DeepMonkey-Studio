import {
  DEFAULT_PRODUCT_BRANDING,
  supportedExtensions,
  type SystemBrandingSettings,
} from "@bim-studio/contracts";
import type {
  CameraConstraintsState,
  ClippingState,
  GlobalLightingState,
  SceneAnimationState,
  SceneEnvironmentState,
  ScenePhysicsState,
  ScenePostProcessingState,
  SkyboxPreset,
} from "@bim-studio/contracts";

/** 与 API 上传合同同源，新增或移除格式时不会出现前后端漂移。 */
export const ACCEPTED_MODELS = supportedExtensions.map((extension) => `.${extension}`).join(",");
export const RENDERER_BACKEND_STORAGE_KEY = "bim-studio.renderer-backend";
export const REVIT_VERSION_STORAGE_KEY = "bim-studio.revit-version";
export const AUTO_SAVE_STORAGE_KEY = "bim-studio.auto-save";
export const BEHAVIOR_LAYOUT_STORAGE_KEY = "bim-studio.behavior-layout";
export type BehaviorLayoutMode = "split" | "float" | "window";
export const BEHAVIOR_SPLIT_WIDTH_STORAGE_KEY = "bim-studio.behavior-split-width";
export const BEHAVIOR_FLOAT_RECT_STORAGE_KEY = "bim-studio.behavior-float-rect";
export const BEHAVIOR_SCRIPT_LIST_WIDTH_STORAGE_KEY = "bim-studio.behavior-script-list-width";
export const BEHAVIOR_SCRIPT_LIST_COLLAPSED_STORAGE_KEY = "bim-studio.behavior-script-list-collapsed";
export const BEHAVIOR_WINDOW_RECT_STORAGE_KEY = "bim-studio.behavior-window-rect";
export const DASHBOARD_LEFT_PANEL_STORAGE_KEY = "bim-studio.dashboard-left-panel";
export const DASHBOARD_INSPECTOR_STORAGE_KEY = "bim-studio.dashboard-inspector";
export const STUDIO_LEFT_PANEL_STORAGE_KEY = "bim-studio.studio-left-panel";
export const STUDIO_INSPECTOR_STORAGE_KEY = "bim-studio.studio-inspector";
export const numberFormat = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

export const DEFAULT_LIGHTING: GlobalLightingState = {
  enabled: true,
  intensity: 1,
  shadowsEnabled: true,
  reflectionsEnabled: true,
  globalIlluminationEnabled: true,
  globalIlluminationIntensity: 0.32,
  lights: [
    { id: "sun-default", name: "主方向光", type: "directional", enabled: true, color: "#ffffff", intensity: 2.2, position: { x: 18, y: 28, z: 12 }, target: { x: 0, y: 0, z: 0 }, castShadow: true }
  ]
};

export const DEFAULT_ENVIRONMENT: SceneEnvironmentState = {
  gridVisible: true,
  backgroundColor: "#0b1419",
  skybox: "studio",
  environmentAsBackground: false,
  environmentIntensity: 1
};

export const DEFAULT_BRANDING: SystemBrandingSettings = { ...DEFAULT_PRODUCT_BRANDING };

export const DEFAULT_POST_PROCESSING: ScenePostProcessingState = {
  enabled: true,
  smaa: true,
  fxaa: false,
  ssao: false,
  ssaoIntensity: 1,
  gtao: true,
  gtaoIntensity: 0.72,
  screenSpaceReflection: false,
  ssrSteps: 32,
  ssrThickness: 0.01,
  ssrMaxDistance: 2,
  volumetricFog: false,
  volumetricFogSteps: 48,
  volumetricFogDensity: 0.006,
  volumetricFogHeight: 64,
  volumetricFogAnisotropy: 0.3,
  bloom: false,
  bloomStrength: 0.35,
  bloomThreshold: 0.9,
  outline: false,
  outlineStrength: 2.5,
  depthOfField: false,
  focusDistance: 10,
  aperture: 0.00002,
  maxBlur: 0.006,
  vignette: false,
  vignetteDarkness: 1.2,
  filmGrain: false,
  filmGrainIntensity: 0.18,
  afterimage: false,
  afterimageDamp: 0.9,
  colorGrading: false,
  hue: 0,
  saturation: 0,
  brightness: 0,
  contrast: 0,
  temperature: 0,
  tint: 0
};

export const DEFAULT_PHYSICS: ScenePhysicsState = {
  enabled: false,
  playing: false,
  gravity: { x: 0, y: -9.81, z: 0 }
};

export const DEFAULT_CAMERA_CONSTRAINTS: CameraConstraintsState = {
  minDistance: 0.5,
  maxDistance: 10_000,
  minPolarAngle: 1,
  maxPolarAngle: 179,
  nearClip: 0.05,
  farClip: 100_000,
  collisionEnabled: true,
  collisionRadius: 0.32
};

export const SKYBOX_OPTIONS: Array<{ value: SkyboxPreset; label: string }> = [
  { value: "none", label: "纯色" },
  { value: "studio", label: "工业摄影棚" },
  { value: "bright-studio", label: "明亮展厅" },
  { value: "clear", label: "晴空" },
  { value: "overcast", label: "阴天" },
  { value: "dawn", label: "晨曦" },
  { value: "sunset", label: "黄昏" },
  { value: "night", label: "夜空" },
  { value: "industrial-night", label: "工业夜景" }
];

export const DEFAULT_ANIMATION: SceneAnimationState = {
  duration: 10,
  autoplay: true,
  loop: false,
  pingPong: false,
  playbackSpeed: 1,
  frameRate: 30,
  snapToFrames: false,
  cameraInterpolation: "smooth",
  showCameraPath: true,
  camera: [],
  models: []
};

export const DEFAULT_CLIPPING: ClippingState = {
  enabled: false,
  mode: "axis",
  axis: "x",
  offset: 0,
  inverted: false
};

/** 用户输入可能来自旧场景或手工 JSON，这里集中修正相机约束的不变量。 */
export function normalizeCameraConstraints(state: CameraConstraintsState): CameraConstraintsState {
  const minDistance = Math.max(0.01, finiteNumber(state.minDistance, DEFAULT_CAMERA_CONSTRAINTS.minDistance));
  const nearClip = Math.max(0.001, finiteNumber(state.nearClip, DEFAULT_CAMERA_CONSTRAINTS.nearClip));
  const minPolarAngle = Math.min(179, Math.max(0, finiteNumber(state.minPolarAngle, DEFAULT_CAMERA_CONSTRAINTS.minPolarAngle)));
  return {
    minDistance,
    maxDistance: Math.max(minDistance + 0.01, finiteNumber(state.maxDistance, DEFAULT_CAMERA_CONSTRAINTS.maxDistance)),
    minPolarAngle,
    maxPolarAngle: Math.min(180, Math.max(minPolarAngle + 0.1, finiteNumber(state.maxPolarAngle, DEFAULT_CAMERA_CONSTRAINTS.maxPolarAngle))),
    nearClip,
    farClip: Math.max(nearClip + 0.1, finiteNumber(state.farClip, DEFAULT_CAMERA_CONSTRAINTS.farClip)),
    collisionEnabled: Boolean(state.collisionEnabled),
    collisionRadius: Math.max(0.02, finiteNumber(state.collisionRadius, DEFAULT_CAMERA_CONSTRAINTS.collisionRadius))
  };
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
