import type { SceneDashboardState } from "./dashboard.js";
import type { SimulationEntityState } from "./simulationEntities.js";
import type { SceneDataBindingState } from "./data.js";
import type { ModelTransform, Vector3Value } from "./geometry.js";
import type { ModelFormat } from "./project.js";
import type { RobotLoadCapabilityState, RobotToolLoadState } from "./robot.js";
import type { SceneCoordinateSystemState } from "./vision.js";
import type { IndustrialPrefabInstanceState, IndustrialPrefabRuntimeAction } from "./industrialPrefab.js";
import type { SceneReflectionProbeState } from "./sceneReflectionProbes.js";
export type { SceneReflectionProbeState } from "./sceneReflectionProbes.js";
export * from "./scenePhysics.js";
export * from "./sceneMaterial.js";
import type { ScenePhysicsBodyState, ScenePhysicsState } from "./scenePhysics.js";
import type { SceneMaterialState } from "./sceneMaterial.js";

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
  /** 实例保存时所用素材的 Deep Asset Package 修订快照；用于加载后检测素材有更新修订。 */
  assetRevision?: SceneAssetRevisionSnapshot;
  layers?: SceneLayerState[];
}

export interface SceneAssetRevisionSnapshot {
  packageId: string;
  revision: number;
  sourceHash: string;
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
  /** 生命周期曲线；省略时使用火焰默认曲线。 */
  curves?: SceneFireCurves;
  /** 混合模式；alpha 会按相机距离做 back-to-front 排序，省略为 additive。 */
  blend?: SceneFireBlend;
  /** 单发射器粒子上限（16..512）；场景总预算在运行时统一分配。 */
  maxParticles?: number;
}

export type SceneFireBlend = "additive" | "alpha";

/** 生命周期关键帧：time 为归一化寿命 0..1，value 取值范围随曲线语义而定。 */
export interface SceneFireCurveKey {
  time: number;
  value: number;
}

export interface SceneFireCurves {
  /** 尺寸倍率 0..4。 */
  size?: SceneFireCurveKey[];
  /** 不透明度 0..1。 */
  alpha?: SceneFireCurveKey[];
  /** 热度 0..1：0 余烬、0.5 基色、1 高光。 */
  color?: SceneFireCurveKey[];
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
  /** Quantized LM-63 profiles referenced by spot lights. Kept in the scene so
   * publications do not depend on the original local file. */
  lightProfiles?: SceneLightProfileState[];
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
  /** Deep WebGPU local PCSS softness in [0,1]; omitted/zero preserves hard PCF. */
  shadowSoftness?: number;
  /** IES is valid only for spot lights and must reference lighting.lightProfiles. */
  ies?: SceneLightIesState;
}

export interface SceneLightIesState {
  profileId: string;
  rotationDeg?: number;
  scaleFactor?: number;
}

export interface SceneLightProfileState {
  profileId: string;
  format: "LM-63-1995" | "LM-63-2002";
  verticalAngles: number[];
  candela: number[][];
  horizontalSymmetry: 1 | 2 | 4;
  totalLumens: number;
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
  /** Deep WebGPU specular chain-tail residency, 1..8; omitted keeps the full chain. */
  environmentSpecularMips?: number;
  /** Deep WebGPU local specular probes; at most two. Omitted preserves global IBL. */
  reflectionProbes?: SceneReflectionProbeState[];
}

export interface SceneFloorState {
  modelId: string;
  level: string;
  visible: boolean;
  expansion: number;
}

export interface ScenePostProcessingState {
  enabled: boolean;
  /** Cross-endpoint authored quality budget. Omitted keeps adaptive defaults. */
  qualityProfile?: "performance" | "balanced" | "quality" | "ultra";
  smaa: boolean;
  fxaa?: boolean;
  ssao: boolean;
  ssaoIntensity: number;
  gtao?: boolean;
  gtaoIntensity?: number;
  /** Deep WebGPU screen-space reflections. Other clients must report unsupported instead of dropping it. */
  screenSpaceReflection?: boolean;
  /** Ray-march samples, integer [8,128]. */
  ssrSteps?: number;
  /** Hit thickness as a fraction of scene extent, [0.001,0.1]. */
  ssrThickness?: number;
  /** Maximum trace distance as a multiple of scene extent, [0.25,4]. */
  ssrMaxDistance?: number;
  /** Deep WebGPU height fog; other clients must report unsupported instead of dropping it. */
  volumetricFog?: boolean;
  /** Deep WebGPU primary-light occlusion in the same participating medium. */
  volumetricGodRays?: boolean;
  /** Linear scattered-light strength, [0,8]; zero retains extinction only. */
  volumetricGodRaysStrength?: number;
  /** Ray-march samples, integer [32,64]. */
  volumetricFogSteps?: number;
  /** Base extinction coefficient for the exponential medium, [0,100]. */
  volumetricFogDensity?: number;
  /** Exponential height scale, >0. */
  volumetricFogHeight?: number;
  /** Henyey-Greenstein anisotropy, [-0.99,0.99]. */
  volumetricFogAnisotropy?: number;
  /** Single-scatter albedo of the medium, [0,1]; 0 keeps extinction only, default 0.82. */
  volumetricFogAlbedo?: number;
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
  /** HDR white-balance controls in the author color pass. */
  temperature?: number;
  tint?: number;
}

/** Transition from this keyframe to the next one; omitted uses the track default. */
export type KeyframeTransition = "linear" | "smooth" | "ease-in" | "ease-out" | "ease-in-out" | "step" | "cubic-bezier";
/** CSS 风格三次贝塞尔缓动参数(x1,y1,x2,y2;x∈[0,1],y 不限);transition === "cubic-bezier" 时生效。 */
export type CubicBezierEasing = readonly [number, number, number, number];

export interface CameraKeyframe {
  id: string;
  time: number;
  camera: CameraState;
  transition?: KeyframeTransition;
  /** 自定义贝塞尔缓动参数(仅 transition === "cubic-bezier" 消费;缺省按 linear)。 */
  easing?: CubicBezierEasing;
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
  /** 自定义贝塞尔缓动参数(仅 transition === "cubic-bezier" 消费;缺省按 linear)。 */
  easing?: CubicBezierEasing;
  /** Optional imported GLTF/FBX animation clip state recorded on the same object track. */
  animation?: ModelAnimationKeyframeState;
  /** B2-a 可见性轨道：该关键帧起对象可见性；缺省保持上一帧状态。 */
  visibility?: boolean;
}

export interface ModelAnimationKeyframeState {
  clipId?: string;
  time: number;
}

export interface SceneModelAnimationPlaybackState {
  autoplay: boolean;
  loopMode: "once" | "loop";
}

export interface SceneAnimationClipState {
  id: string;
  name: string;
  modelId: string;
  clipId: string;
  loop: boolean;
}

export interface SceneAnimationClipTransitionState {
  id: string;
  fromStateId: string;
  toStateId: string;
  parameter: string;
  equals: boolean;
}

/** 产品侧预注册的 clip 事件标记；time 单位秒，消费端按 `0 <= time < clip 时长` fail-closed 校验。 */
export interface SceneAnimationClipEventMarkerState {
  clipId: string;
  eventId: string;
  time: number;
}

/** Product-authored controller for switching imported animation clips. */
export interface SceneAnimationStateMachineState {
  enabled: boolean;
  initialStateId: string;
  activeStateId: string;
  transitionDuration: number;
  states: SceneAnimationClipState[];
  parameters?: Record<string, boolean>;
  transitions?: SceneAnimationClipTransitionState[];
  /** 可选 clip 事件标记；缺省不写该字段，旧场景语义逐位不变。 */
  events?: SceneAnimationClipEventMarkerState[];
}

/** 区间播放范围（秒）。出点必须大于入点，越界或退化值按整条时间线处理。 */
export interface SceneAnimationPlaybackRange {
  /** 入点；循环、往返与停止的下边界。 */
  inPoint: number;
  /** 出点；循环、往返与停止的上边界。 */
  outPoint: number;
}

export interface SceneAnimationState {
  duration: number;
  /** 发布预览进入场景后是否自动播放时间线。 */
  autoplay?: boolean;
  loop: boolean;
  pingPong?: boolean;
  playbackSpeed?: number;
  /** 区间播放；缺省播放整条时间线 [0, duration]。 */
  playbackRange?: SceneAnimationPlaybackRange;
  /** Timeline authoring frame rate. Defaults to 30 when frame snapping is enabled. */
  frameRate?: number;
  /** Quantize playhead and newly authored keyframes to exact frames. */
  snapToFrames?: boolean;
  cameraInterpolation?: "linear" | "smooth" | "spline";
  modelInterpolation?: "linear" | "smooth";
  showCameraPath?: boolean;
  stateMachine?: SceneAnimationStateMachineState;
  camera: CameraKeyframe[];
  models: ModelKeyframe[];
}

/** P7 QTO 分类口径映射：按数组顺序应用，首条命中生效；未命中回落内置类别推断。 */
export interface SceneQtoCategoryMapping {
  id: string;
  enabled: boolean;
  /** 匹配来源：材质名 / 对象名 / 自定义属性。 */
  source: "material-name" | "object-name" | "custom-property";
  /** 匹配文本（小写包含匹配）；source 为 custom-property 时留空表示仅按属性键存在匹配。 */
  pattern: string;
  /** 自定义属性键；source 为 custom-property 时必填。 */
  propertyKey?: string;
  /** 命中后输出的 QTO 类别。 */
  category: string;
}

/**
 * P5 空间校验规则与 P7 QTO 分类口径。随场景文档保存（工程分析面板共享），
 * 重开场景后恢复；运行时仍以当前可见对象为准，不进运行包。
 */
export interface SceneEngineeringAnalysisState {
  /** 最小净空阈值（米，>=0）。 */
  minimumClearance: number;
  /** 限高阈值（米，>0）。 */
  heightLimit: number;
  /** P7 分类口径映射规则；缺省为空 = 沿用内置类别推断。 */
  qtoMappings?: SceneQtoCategoryMapping[];
}


// collisionStart/collisionEnd 由物理运行时在碰撞开始/结束时派发，payload.other 为对端模型 id（地面为 null）。
export type SceneInteractionTrigger = "load" | "click" | "doubleClick" | "contextMenu" | "pointerEnter" | "pointerLeave" | "animationStart" | "animationEnd" | "routePointReached" | "collisionStart" | "collisionEnd";

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

/** 作者目录根行引用；只影响目录顺序，不改变渲染或空间层级。 */
export interface SceneRootLayerRef {
  kind: "group" | "object" | "light" | "measurement" | "annotation" | "space";
  id: string;
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
  /** P5 空间校验规则与 P7 QTO 分类口径（工程分析面板共享）。 */
  engineeringAnalysis?: SceneEngineeringAnalysisState;
  dashboard?: SceneDashboardState;
  dataBindings?: SceneDataBindingState[];
  assetBindings?: SceneAssetBindingState[];
  interactions?: SceneInteractionScriptState[];
  selectionSets?: SceneSelectionSetState[];
  /** 缺省沿用旧目录顺序；组内顺序由 selectionSets.objectIds 保存。 */
  rootLayerOrder?: SceneRootLayerRef[];
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

/** 引擎中立拾取命中:Deep 拾取 API 与既有 Three 拾取共享的返回合同。 */
export interface ScenePickingHit {
  /** 命中的对象 id;Deep 侧为编译器保留的节点标识,Three 侧为对象路径 id。 */
  readonly objectId: string;
  /** 命中点世界坐标。 */
  readonly point: readonly [number, number, number];
  /** 视点到命中点的距离(世界单位,升序排序键)。 */
  readonly distance: number;
}

/** 引擎中立拾取查询入参;归一化射线方向由调用方保证。 */
export interface ScenePickingQuery {
  readonly origin: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  readonly maxDistance?: number;
  /** 返回前 N 个命中(默认 1,即最近命中)。 */
  readonly limit?: number;
}
