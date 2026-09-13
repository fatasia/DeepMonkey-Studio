import type { SceneDashboardState } from "./dashboard.js";
import type { SimulationEntityState } from "./simulationEntities.js";
import type { SceneDataBindingState } from "./data.js";
import type { ModelTransform, Vector3Value } from "./geometry.js";
import type { ModelFormat } from "./project.js";
import type { RobotLoadCapabilityState, RobotToolLoadState } from "./robot.js";
import type { SceneCoordinateSystemState } from "./vision.js";
import type { IndustrialPrefabInstanceState, IndustrialPrefabRuntimeAction } from "./industrialPrefab.js";

/** 三维场景、交互、动画、物理、材质与发布快照合同。 */
export interface SceneModelState {
  /** 稳定场景实例 ID；脚本、标签、动画与仿真引用始终指向此身份。 */
  modelId: string;
  /** 项目模型资源 ID；旧场景省略时使用 modelId，替换资源不改变实例身份。 */
  assetModelId?: string;
  name: string;
  sourceName?: string;
  sourceFormat?: ModelFormat;
  visible: boolean;
  locked?: boolean;
  opacity: number;
  /** @deprecated 旧场景曾把模型的首个材质颜色误当成全局覆盖色。 */
  color?: string;
  /** 仅在用户明确修改整个模型颜色时保存，避免覆盖 BIM 原始材质。 */
  colorOverride?: string;
  transform: ModelTransform;
  collisionEnabled?: boolean;
  explosionFactor?: number;
  explosionMode?: ExplosionMode;
  animationEnabled?: boolean;
  animationPlayback?: SceneModelAnimationPlaybackState;
  material?: SceneMaterialState;
  /** 挂载到模型原点的空间音频；用于设备声、告警声和环境声。 */
  spatialAudio?: SceneSpatialAudioState;
  effects?: SceneModelEffectsState;
  rig?: SceneRigState;
  /** URDF 实例关节值；名称来自资源描述，平移为 m，转角为 rad。 */
  robotPose?: Record<string, number>;
  physics?: ScenePhysicsBodyState;
  /** 可配置工业预制体实例；普通导入模型无需此字段。 */
  prefab?: IndustrialPrefabInstanceState;
  layers?: SceneLayerState[];
}

export type PhysicsBodyType = "none" | "fixed" | "dynamic";

export interface ScenePhysicsBodyState {
  type: PhysicsBodyType;
  mass: number;
  friction: number;
  restitution: number;
}

export interface ScenePhysicsState {
  enabled: boolean;
  playing: boolean;
  gravity: Vector3Value;
}

export type ExplosionMode = "radial" | "vertical" | "x" | "y" | "z";

export type ClippingMode = "axis" | "box" | "face";

export interface ClippingBoxState {
  min: Vector3Value;
  max: Vector3Value;
}

export interface ClippingFaceState {
  normal: Vector3Value;
  point: Vector3Value;
}

export interface ClippingState {
  enabled: boolean;
  mode?: ClippingMode;
  axis: "x" | "y" | "z";
  offset: number;
  inverted: boolean;
  box?: ClippingBoxState;
  face?: ClippingFaceState;
  showHelper?: boolean;
}

export interface SceneLayerState {
  nodeId: string;
  visible?: boolean;
  locked?: boolean;
  name?: string;
  opacity?: number;
  color?: string;
  material?: SceneMaterialState;
  transform?: ModelTransform;
  deleted?: boolean;
}

export interface SceneMaterialState {
  color?: string;
  /** 实例级颜色校正；不改写原始素材，可为同一素材的不同实例保存不同外观。 */
  hue?: number;
  saturation?: number;
  brightness?: number;
  contrast?: number;
  baseColorMapUrl?: string;
  baseColorMapName?: string;
  normalMapUrl?: string;
  normalMapName?: string;
  emissiveMapUrl?: string;
  emissiveMapName?: string;
  ambientOcclusionMapUrl?: string;
  ambientOcclusionMapName?: string;
  roughnessMapUrl?: string;
  roughnessMapName?: string;
  metalnessMapUrl?: string;
  metalnessMapName?: string;
  /** @deprecated 旧场景的等比 UV 重复；新编辑器使用独立 U/V 参数。 */
  textureRepeat?: number;
  /** 贴图沿 U/V 方向的独立重复次数，适配长条设备和非方形表面。 */
  textureRepeatX?: number;
  textureRepeatY?: number;
  /** 贴图静态偏移；与 UV 动画叠加，用于校正铭牌和输送带等 PBR 纹理位置。 */
  textureOffsetX?: number;
  textureOffsetY?: number;
  textureRotation?: number;
  /** 贴图 UV 动画；用于输送带、流水、灯带等连续运动材质。 */
  uvAnimation?: SceneMaterialUvAnimationState;
  /** 将图片或视频映射到选中模型/构件表面，用于工业看板、电视和设备屏幕。 */
  screen?: SceneMaterialScreenState;
  normalScale?: number;
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  wireframe?: boolean;
  doubleSided?: boolean;
  /** 基于 MeshStandardMaterial.onBeforeCompile 的轻量着色器效果；不改写 PBR 管线，保持场景光照一致。 */
  shaderEffect?: SceneMaterialShaderEffect | undefined;
}

export interface SceneMaterialShaderEffect {
  kind: "fresnel-rim";
  /** 轮廓光颜色；#RRGGBB。 */
  color: string;
  /** 边缘光强度 0-4；0 等效关闭。 */
  intensity: number;
}

export interface SceneMaterialScreenState {
  enabled: boolean;
  sourceType: "image" | "video";
  url: string;
  name?: string;
  /** 视频进入预览后是否立即播放；图片类型忽略此字段。 */
  autoplay: boolean;
  loopMode: "once" | "loop";
  muted: boolean;
  /** 屏幕作为自发光表面的亮度，避免依赖场景照明才能看清。 */
  emissiveIntensity: number;
}

export interface SceneSpatialAudioState {
  enabled: boolean;
  url: string;
  name?: string;
  autoplay: boolean;
  loopMode: "once" | "loop";
  muted: boolean;
  /** 线性音量，运行时限制在 0..1。 */
  volume: number;
  /** 音量开始衰减的距离。 */
  refDistance: number;
  /** 超过该距离后不再继续增强可听范围。 */
  maxDistance: number;
  rolloffFactor: number;
}

export interface SceneMaterialUvAnimationState {
  enabled: boolean;
  /** 关闭循环时从进入场景开始播放一次。 */
  loopMode?: "once" | "loop";
  /** 播放一次的时长；循环模式下用于定义一个逻辑周期。 */
  durationSeconds?: number;
  /** 每秒沿 U/V 方向移动的 UV 单位。 */
  offsetSpeedX: number;
  offsetSpeedY: number;
  /** 每秒旋转弧度，正值为逆时针。 */
  rotationSpeed: number;
}

export interface SceneModelEffectsState {
  outline: boolean;
  glow: boolean;
  xray: boolean;
  scanline: boolean;
  heatmap: boolean;
  dissolve: number;
  edgeLight: boolean;
  color: string;
  intensity: number;
  /** 附着于模型/基础体顶部的轻量火焰图层；省略时保持旧场景行为。 */
  fire?: SceneFireEffectState;
}

export interface SceneFireEffectState {
  enabled: boolean;
  color: string;
  /** 火焰亮度与运动速度，运行时限制在 0..5。 */
  intensity: number;
  /** 模型局部坐标中的火焰高度。 */
  height: number;
  /** 粒子密度倍率，运行时限制在 0.25..2。 */
  density: number;
}

export interface SceneBonePoseState {
  bonePath: string;
  rotation: Vector3Value;
}

export interface SceneIKConstraintState {
  id: string;
  effectorBonePath: string;
  /** IK target in model-local coordinates so it survives model transforms. */
  target: Vector3Value;
  chainLength: number;
  iterations: number;
  enabled: boolean;
}

export interface SceneRigState {
  bones: SceneBonePoseState[];
  ik: SceneIKConstraintState[];
  robot?: SceneRobotKinematicsState;
}

export interface SceneRobotJointState {
  bonePath: string;
  name: string;
  axis: "x" | "y" | "z";
  length: number;
  minAngleDeg: number;
  maxAngleDeg: number;
}

/** 品牌无关的轻量机器人元数据，仅用于包络、IK 和工位验证。 */
export interface SceneRobotKinematicsState {
  enabled: boolean;
  baseBonePath: string;
  toolBonePath?: string;
  toolObjectId?: string;
  targetObjectIds?: string[];
  joints: SceneRobotJointState[];
  /** 未提供时负载能力筛查必须保持 needs-data。 */
  loadCapability?: RobotLoadCapabilityState;
  /** 未提供时不得用默认工具质量、TCP 或重心冒充工程输入。 */
  toolLoad?: RobotToolLoadState;
}

export type PrimitiveKind = "box" | "sphere" | "cylinder" | "cone" | "torus" | "plane" | "capsule";

export interface PrimitiveState extends SceneModelState {
  kind: PrimitiveKind;
  color: string;
}

export interface MeasurementState {
  id: string;
  start: Vector3Value;
  end: Vector3Value;
  distance: number;
  kind?: "distance" | "minimum" | "angle" | "elevation" | "horizontal" | "vertical";
  points?: Vector3Value[];
  angle?: number;
  elevation?: number;
  labels?: string[];
}

export interface SceneAnnotationState {
  id: string;
  name: string;
  description?: string;
  position: Vector3Value;
  color: string;
  visible: boolean;
  locked: boolean;
  size?: number;
  modelId?: string;
  layerId?: string;
  anchorName?: string;
}

export interface CameraState {
  position: Vector3Value;
  target: Vector3Value;
  mode: "orbit" | "firstPerson" | "thirdPerson";
  avatarVisible?: boolean;
}

export interface CameraConstraintsState {
  minDistance: number;
  maxDistance: number;
  minPolarAngle: number;
  maxPolarAngle: number;
  nearClip: number;
  farClip: number;
  collisionEnabled: boolean;
  collisionRadius: number;
}

/** 可复用的场景对象集合；仅保存稳定 ID，不耦合具体渲染引擎对象。 */
export interface SceneSelectionSetState {
  id: string;
  name: string;
  objectIds: string[];
  /** Groups are persistent selection sets whose members can be controlled together. */
  kind?: "selection" | "group";
}

/** 已由用户确认的场景对象与现场设备映射；仅保存身份关系，不等同于实时数据绑定。 */
export interface SceneAssetBindingState {
  id: string;
  sceneObjectId: string;
  objectName: string;
  modelId: string;
  layerId?: string;
  deviceId: string;
  confidence: number;
  confirmedAt: string;
}

/** 可序列化的漫游手感配置；渲染/物理引擎实现细节不进入场景协议。 */
export interface NavigationSettingsState {
  walkSpeed: number;
  flySpeed: number;
  sprintMultiplier: number;
  eyeHeight: number;
  gravity: number;
  jumpSpeed: number;
  stepHeight: number;
  maxSlopeAngle: number;
}

export type WeatherMode = "sunny" | "cloudy" | "rain" | "snow" | "fog" | "storm";

export interface GlobalLightingState {
  enabled: boolean;
  intensity: number;
  shadowsEnabled?: boolean;
  reflectionsEnabled?: boolean;
  /** Lightweight environment/hemisphere indirect-light approximation. */
  globalIlluminationEnabled?: boolean;
  globalIlluminationIntensity?: number;
  lights?: SceneLightState[];
}

export type SceneLightType = "ambient" | "hemisphere" | "directional" | "point" | "spot" | "rectArea";

export interface SceneLightState {
  id: string;
  name: string;
  type: SceneLightType;
  enabled: boolean;
  color: string;
  intensity: number;
  position?: Vector3Value;
  target?: Vector3Value;
  groundColor?: string;
  distance?: number;
  decay?: number;
  angle?: number;
  penumbra?: number;
  width?: number;
  height?: number;
  castShadow?: boolean;
}

export type SkyboxPreset =
  | "none"
  | "studio"
  | "bright-studio"
  | "clear"
  | "overcast"
  | "dawn"
  | "sunset"
  | "night"
  | "industrial-night";

export interface SceneEnvironmentState {
  gridVisible: boolean;
  backgroundColor: string;
  skybox: SkyboxPreset;
  environmentMapUrl?: string;
  environmentMapName?: string;
  environmentAsBackground?: boolean;
  environmentIntensity?: number;
}

export interface SceneFloorState {
  modelId: string;
  level: string;
  visible: boolean;
  expansion: number;
}

export interface ScenePostProcessingState {
  enabled: boolean;
  smaa: boolean;
  fxaa?: boolean;
  ssao: boolean;
  ssaoIntensity: number;
  gtao?: boolean;
  gtaoIntensity?: number;
  bloom: boolean;
  bloomStrength: number;
  bloomThreshold: number;
  outline?: boolean;
  outlineStrength?: number;
  depthOfField?: boolean;
  focusDistance?: number;
  aperture?: number;
  maxBlur?: number;
  vignette?: boolean;
  vignetteDarkness?: number;
  filmGrain?: boolean;
  filmGrainIntensity?: number;
  afterimage?: boolean;
  afterimageDamp?: number;
  /** 统一调色在 WebGL/WebGPU 使用同一组可序列化参数。 */
  colorGrading?: boolean;
  hue?: number;
  saturation?: number;
  brightness?: number;
  contrast?: number;
}

/** Transition from this keyframe to the next one; omitted uses the track default. */
export type KeyframeTransition = "linear" | "smooth" | "ease-in" | "ease-out" | "step";

export interface CameraKeyframe {
  id: string;
  time: number;
  camera: CameraState;
  transition?: KeyframeTransition;
}

export interface CameraViewState {
  id: string;
  name: string;
  camera: CameraState;
  createdAt: string;
}

export interface ModelKeyframe {
  id: string;
  time: number;
  modelId: string;
  transform: ModelTransform;
  transition?: KeyframeTransition;
  /** Optional imported GLTF/FBX animation clip state recorded on the same object track. */
  animation?: ModelAnimationKeyframeState;
}

export interface ModelAnimationKeyframeState {
  clipId?: string;
  time: number;
}

export interface SceneModelAnimationPlaybackState {
  autoplay: boolean;
  loopMode: "once" | "loop";
}

export interface SceneAnimationState {
  duration: number;
  /** 发布预览进入场景后是否自动播放时间线。 */
  autoplay?: boolean;
  loop: boolean;
  pingPong?: boolean;
  playbackSpeed?: number;
  /** Timeline authoring frame rate. Defaults to 30 when frame snapping is enabled. */
  frameRate?: number;
  /** Quantize playhead and newly authored keyframes to exact frames. */
  snapToFrames?: boolean;
  cameraInterpolation?: "linear" | "smooth" | "spline";
  modelInterpolation?: "linear" | "smooth";
  showCameraPath?: boolean;
  camera: CameraKeyframe[];
  models: ModelKeyframe[];
}


export type SceneInteractionTrigger = "load" | "click" | "doubleClick" | "contextMenu" | "pointerEnter" | "pointerLeave" | "animationStart" | "animationEnd" | "routePointReached";

export type SceneInteractionTarget = {
  kind: "object";
  modelId: string;
  layerId?: string;
} | {
  kind: "widget";
  widgetId: string;
};

export type SceneInteractionActionType = "visibility" | "color" | "opacity" | "focus" | "animation" | "prefabAction" | "openUrl" | "navigateScene" | "cameraView" | "message" | "dashboard" | "setData" | "unityAction";

export interface SceneVisualTransitionState {
  kind: "none" | "fade" | "scale" | "rise";
  durationMs: number;
  easing: "linear" | "ease-in" | "ease-out" | "ease-in-out";
}

export interface SceneInteractionActionState {
  id: string;
  type: SceneInteractionActionType;
  enabled: boolean;
  /** visibility: show/hide/toggle; animation: play/stop/toggle; color: #rrggbb; opacity: 0..1 */
  value?: string | number | boolean;
  /** openUrl 使用。 */
  url?: string;
  newTab?: boolean;
  /** 显隐或场景跳转的可选视觉过渡；省略时保持即时响应。 */
  transition?: SceneVisualTransitionState;
  /** 三维对象动作的显式目标；为空时使用触发事件的对象。 */
  target?: { kind: "object"; modelId: string; layerId?: string } | undefined;
  sceneId?: string;
  /** dashboard 动作打开的二维页面。 */
  dashboardPageId?: string;
  cameraViewId?: string;
  message?: string;
  /** setData key, or dashboard drill-down parameter key. */
  dataKey?: string;
  /** Unity WebGL action name and optional manifest object ID. */
  unityAction?: string;
  unityObjectId?: string;
  /** 人、车、AGV 等工业预制体的路线与故障控制。 */
  prefabAction?: IndustrialPrefabRuntimeAction;
}

/**
 * 可信场景脚本直接运行在浏览器主线程，并可访问 ViewerEngine、Three.js 场景和浏览器全局对象。
 * 仅应允许可信场景编辑者修改代码。
 */
export interface SceneInteractionScriptState {
  id: string;
  name: string;
  target: SceneInteractionTarget;
  trigger: SceneInteractionTrigger;
  enabled: boolean;
  actions?: SceneInteractionActionState[];
  code: string;
}

export interface SceneSnapshot {
  schemaVersion: 1;
  id: string;
  projectId: string;
  name: string;
  camera: CameraState;
  coordinateSystem?: SceneCoordinateSystemState;
  cameraConstraints?: CameraConstraintsState;
  navigationSettings?: NavigationSettingsState;
  cameraViews?: CameraViewState[];
  defaultCameraViewId?: string;
  models: SceneModelState[];
  primitives: PrimitiveState[];
  measurements: MeasurementState[];
  annotations?: SceneAnnotationState[];
  clipping?: ClippingState;
  weather?: WeatherMode;
  lighting?: GlobalLightingState;
  environment?: SceneEnvironmentState;
  floors?: SceneFloorState[];
  postProcessing?: ScenePostProcessingState;
  physics?: ScenePhysicsState;
  animation?: SceneAnimationState;
  dashboard?: SceneDashboardState;
  dataBindings?: SceneDataBindingState[];
  assetBindings?: SceneAssetBindingState[];
  interactions?: SceneInteractionScriptState[];
  selectionSets?: SceneSelectionSetState[];
  selectedModelId?: string;
  selectedLayerId?: string;
  selectedAnnotationId?: string;
  /** 保存时抓取的场景画面（JPEG data URL，宽 ≤480px）；场景卡缩略图优先使用，旧场景回退合成示意。 */
  thumbnail?: string;
  /** 仿真实体（SIM-1a）：连接/路径/碰撞对；仅持久化配置，运行瞬态与 Study 结果不入快照。 */
  simulationEntities?: import("./simulationEntities.js").SimulationEntityState[];
  /** 最近一次发布的时间；后续编辑不会覆盖已发布快照，需再次发布才会更新浏览版本。 */
  publishedAt?: string;
  /** Runtime selected for the published scene. Editing remains WebGL by default. */
  publicationMode?: "webgl" | "webgpu-preferred" | "cloud";
  /** Rendering cost policy applied only by the published viewer. */
  /** `fast` 是旧数据兼容值，当前产品语义为不牺牲作者画质的自动优化。 */
  publicationPerformance?: "standard" | "fast";
  /** 公开浏览页是否提供只读工程查看工具；旧发布未配置时按显示处理。 */
  publicationToolbarVisible?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedSceneRecord {
  sceneId: string;
  projectId: string;
  name: string;
  snapshot: SceneSnapshot;
  publishedAt: string;
  version?: number;
}
