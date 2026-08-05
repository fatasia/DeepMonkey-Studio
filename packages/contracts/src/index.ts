export const supportedExtensions = ["rvt", "ifc", "step", "stp", "dwg", "dxf", "gltf", "glb", "fbx"] as const;

export type ModelFormat = (typeof supportedExtensions)[number];
export type ConversionStatus = "queued" | "processing" | "ready" | "waiting_converter" | "failed";
export type ViewerKind = "ifc" | "fragments" | "gltf" | "fbx" | "dxf";
export type RvtConversionMode = "ifc" | "native-glb";

export interface Vector3Value {
  x: number;
  y: number;
  z: number;
}

export interface ModelTransform {
  position: Vector3Value;
  rotation: Vector3Value;
  scale: Vector3Value;
}

export interface ModelManifest {
  schemaVersion: 1;
  modelId: string;
  sourceName: string;
  sourceFormat: ModelFormat;
  viewerKind?: ViewerKind;
  geometryUrl?: string;
  hierarchyUrl?: string;
  propertiesUrl?: string;
  createdAt: string;
}

export interface ModelRecord {
  id: string;
  projectId: string;
  name: string;
  format: ModelFormat;
  rvtConversionMode?: RvtConversionMode;
  size: number;
  status: ConversionStatus;
  progress: number;
  message: string;
  sourceUrl: string;
  manifestUrl?: string;
  manifest?: ModelManifest;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  models: ModelRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface SceneModelState {
  modelId: string;
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
  material?: SceneMaterialState;
  layers?: SceneLayerState[];
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
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  wireframe?: boolean;
  doubleSided?: boolean;
}

export interface PrimitiveState extends SceneModelState {
  kind: "box";
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

export type WeatherMode = "sunny" | "rain" | "snow";

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

export type SkyboxPreset = "none" | "clear" | "sunset" | "night";

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
}

export interface CameraKeyframe {
  id: string;
  time: number;
  camera: CameraState;
}

export interface ModelKeyframe {
  id: string;
  time: number;
  modelId: string;
  transform: ModelTransform;
}

export interface SceneAnimationState {
  duration: number;
  loop: boolean;
  pingPong?: boolean;
  playbackSpeed?: number;
  cameraInterpolation?: "linear" | "smooth" | "spline";
  showCameraPath?: boolean;
  camera: CameraKeyframe[];
  models: ModelKeyframe[];
}

export interface SceneSnapshot {
  schemaVersion: 1;
  id: string;
  projectId: string;
  name: string;
  camera: CameraState;
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
  animation?: SceneAnimationState;
  selectedModelId?: string;
  selectedLayerId?: string;
  selectedAnnotationId?: string;
  /** 最近一次发布的时间；后续编辑不会覆盖已发布快照，需再次发布才会更新浏览版本。 */
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublishedSceneRecord {
  sceneId: string;
  projectId: string;
  name: string;
  snapshot: SceneSnapshot;
  publishedAt: string;
}

export interface DatabaseDocument {
  projects: ProjectRecord[];
  scenes: SceneSnapshot[];
  publishedScenes?: PublishedSceneRecord[];
}

export function createDefaultTransform(): ModelTransform {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 }
  };
}
