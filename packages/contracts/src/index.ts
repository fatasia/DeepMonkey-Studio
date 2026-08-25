import type { ApplicationDocument, ApplicationPublicationPointer, PublishedApplicationRecord } from "./application.js";

export const supportedExtensions = ["rvt", "ifc", "step", "stp", "dwg", "dxf", "gltf", "glb", "fbx"] as const;

export type ModelFormat = (typeof supportedExtensions)[number];
export type ConversionStatus = "queued" | "processing" | "ready" | "waiting_converter" | "failed";
export type ViewerKind = "ifc" | "fragments" | "gltf" | "fbx" | "dxf";
export type RvtConversionMode = "ifc" | "native-glb";

export interface RevitInstallationRecord {
  version: string;
  path: string;
  source: "environment" | "registry" | "standard";
  addinInstalled: boolean;
  workerReady: boolean;
}

export interface RevitRuntimeInfo {
  installations: RevitInstallationRecord[];
  defaultVersion: string;
}

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
  lods?: ModelLodResource[];
  createdAt: string;
}

export interface ModelLodResource {
  url: string;
  ratio: number;
  level: "medium" | "low";
}

export interface ModelRecord {
  id: string;
  projectId: string;
  name: string;
  format: ModelFormat;
  rvtConversionMode?: RvtConversionMode;
  rvtSourceVersion?: string;
  rvtRevitVersion?: string;
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

export type ProjectAssetKind = "image" | "video";

export interface ProjectAssetRecord {
  id: string;
  projectId: string;
  kind: ProjectAssetKind;
  name: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  description: string;
  models: ModelRecord[];
  assets?: ProjectAssetRecord[];
  dataConnections?: DataConnectionRecord[];
  datasets?: DataDatasetRecord[];
  dataPipelines?: DataPipelineDefinition[];
  visionSources?: VisionSourceRecord[];
  visionModels?: VisionModelRecord[];
  visionTasks?: VisionTaskRecord[];
  visionEvents?: VisionEventRecord[];
  createdAt: string;
  updatedAt: string;
}

export type VisionSourceKind = "image" | "video";
export type VisionSourceStatus = "online" | "offline" | "unknown";

export interface VisionSourceRecord {
  id: string;
  projectId: string;
  name: string;
  kind: VisionSourceKind;
  sourceUrl: string;
  assetId?: string;
  playbackUrl?: string;
  status: VisionSourceStatus;
  createdAt: string;
  updatedAt: string;
}

export type VisionModelTask = "detection" | "classification";
export type VisionTensorLayout = "NCHW" | "NHWC";
export type VisionColorSpace = "RGB" | "BGR" | "GRAY";
export type VisionResizeMode = "stretch" | "letterbox" | "center-crop";
export type VisionOutputFormat = "classification-logits" | "ssd" | "yolo" | "yolo-nms" | "yolox" | "boxes-scores-labels";

export interface VisionModelManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  task: VisionModelTask;
  input: {
    width: number;
    height: number;
    channels: 1 | 3;
    layout: VisionTensorLayout;
    color: VisionColorSpace;
    resize: VisionResizeMode;
    letterboxPosition?: "center" | "top-left";
    padding?: number[];
    dataType?: "float32" | "uint8";
    scale: number;
    mean?: number[];
    std?: number[];
    inputName?: string;
  };
  output: {
    format: VisionOutputFormat;
    outputNames?: string[];
    coordinates?: "normalized" | "input-pixels";
    nmsIncluded?: boolean;
  };
  labels: string[];
  threshold: number;
  iouThreshold?: number;
  license?: string;
  sourceUrl?: string;
}

export interface VisionModelRecord {
  id: string;
  projectId: string;
  name: string;
  version: string;
  task: VisionModelTask;
  manifest: VisionModelManifest;
  modelKey: string;
  size: number;
  status: "validating" | "ready" | "failed";
  message: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisionModelPreset {
  id: string;
  name: string;
  description: string;
  category: "general" | "safety" | "quality";
  downloadUrl?: string;
  manifest: VisionModelManifest;
  readyToDownload: boolean;
}

export interface VisionPoint { x: number; y: number; }

export interface VisionTaskBinding {
  sceneId?: string;
  objectIds: string[];
  cameraViewId?: string;
  actions: Array<"highlight" | "focus" | "annotation" | "dashboard" | "message">;
}

export type VisionExecutionProvider = "auto" | "directml" | "cpu";
export type VisionActiveExecutionProvider = "directml" | "cpu";

export interface VisionTaskRecord {
  id: string;
  projectId: string;
  name: string;
  mode: VisionSourceKind;
  sourceId?: string;
  modelId: string;
  enabled: boolean;
  inferenceFps: number;
  threshold: number;
  iouThreshold: number;
  executionProvider: VisionExecutionProvider;
  deviceId: number;
  activeExecutionProvider?: VisionActiveExecutionProvider;
  executionFallbackReason?: string;
  lastInferenceMs?: number;
  actualInferenceFps?: number;
  durationMs: number;
  cooldownMs: number;
  alertLabels?: string[];
  roi?: VisionPoint[];
  binding: VisionTaskBinding;
  status: "stopped" | "running" | "error";
  message: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisionDetection {
  label: string;
  classId: number;
  confidence: number;
  bbox?: [number, number, number, number];
}

export interface VisionEventRecord {
  id: string;
  projectId: string;
  taskId: string;
  sourceType: VisionSourceKind;
  sourceId?: string;
  modelId: string;
  result: "ok" | "ng" | "detected";
  detections: VisionDetection[];
  imageUrl: string;
  sceneId?: string;
  objectIds: string[];
  status: "pending" | "confirmed" | "closed";
  note?: string;
  inferenceMs: number;
  executionProvider?: VisionActiveExecutionProvider;
  executionFallbackReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface VisionInferenceResponse {
  event: VisionEventRecord;
  imageWidth: number;
  imageHeight: number;
}

export type DataConnectionType = "postgresql" | "mysql" | "oracle" | "tdengine" | "http" | "websocket" | "mqtt" | "opcua" | "modbus" | "bacnet" | "tcp" | "udp" | "serial" | "s7" | "ethernet-ip" | "snmp" | "amqp" | "kafka" | "coap";

export interface DataConnectionRecord {
  id: string;
  projectId: string;
  name: string;
  type: DataConnectionType;
  enabled: boolean;
  /** 连接参数不保存明文密码；密码通过 passwordEnv 指向服务端环境变量。 */
  config: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export type DataFieldType = "string" | "number" | "boolean" | "datetime" | "json";

export type DataEventAction = "color" | "visibility" | "position" | "label" | "opacity" | "focus" | "animation" | "effects";

export interface DataEventTarget {
  modelId?: string;
  layerId?: string;
  annotationId?: string;
}

export interface DataMessage {
  source: string;
  key: string;
  value: unknown;
  timestamp: string;
  sceneId?: string;
  target?: DataEventTarget;
  action?: DataEventAction;
}

export interface DataEvent extends DataMessage {
  id: string;
  projectId: string;
}

export interface DataDatasetField {
  key: string;
  label: string;
  type: DataFieldType;
  unit?: string;
}

export interface DataComputedField {
  id: string;
  key: string;
  label: string;
  type: DataFieldType;
  mode?: "formula" | "script";
  formula: string;
}

export interface DataDatasetRecord {
  id: string;
  projectId: string;
  connectionId: string;
  name: string;
  query?: string;
  sourceKey?: string;
  refreshSeconds: number;
  fields: DataDatasetField[];
  computedFields?: DataComputedField[];
  createdAt: string;
  updatedAt: string;
}

export interface DataDatasetPreview {
  dataset: DataDatasetRecord;
  fields: DataDatasetField[];
  rows: Array<Record<string, unknown>>;
  durationMs: number;
}

export type DataPipelineNode =
  | { id: string; type: "source"; name: string; datasetId: string; position: { x: number; y: number } }
  | { id: string; type: "filter"; name: string; formula: string; position: { x: number; y: number } }
  | { id: string; type: "formula"; name: string; key: string; label: string; fieldType: DataFieldType; formula: string; position: { x: number; y: number } }
  | { id: string; type: "script"; name: string; key: string; label: string; fieldType: DataFieldType; source: string; position: { x: number; y: number } }
  | { id: string; type: "sort"; name: string; field: string; direction: "asc" | "desc"; position: { x: number; y: number } }
  | { id: string; type: "limit"; name: string; count: number; position: { x: number; y: number } }
  | { id: string; type: "merge"; name: string; position: { x: number; y: number } }
  | { id: string; type: "output"; name: string; position: { x: number; y: number } };

export interface DataPipelineEdge {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export interface DataPipelineDefinition {
  id: string;
  projectId: string;
  name: string;
  nodes: DataPipelineNode[];
  edges: DataPipelineEdge[];
  createdAt: string;
  updatedAt: string;
}

export interface DataPipelineNodeDiagnostic {
  nodeId: string;
  status: "success" | "error";
  inputRows: number;
  outputRows: number;
  durationMs: number;
  sample: Array<Record<string, unknown>>;
  error?: string;
}

export interface DataPipelinePreview {
  pipeline: DataPipelineDefinition;
  status: "success" | "error";
  fields: DataDatasetField[];
  rows: Array<Record<string, unknown>>;
  durationMs: number;
  diagnostics: DataPipelineNodeDiagnostic[];
  failedNodeId?: string;
  error?: string;
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
  effects?: SceneModelEffectsState;
  physics?: ScenePhysicsBodyState;
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
  roughness?: number;
  metalness?: number;
  emissive?: string;
  emissiveIntensity?: number;
  wireframe?: boolean;
  doubleSided?: boolean;
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

export type SceneDashboardSide = "left" | "right";
export type SceneDashboardWidgetType = "text" | "shape" | "value" | "gauge" | "status" | "line" | "area" | "bar" | "pie" | "table" | "image" | "video" | "monitor" | "url";

export interface SceneDashboardWidgetState {
  id: string;
  title: string;
  key: string;
  type: SceneDashboardWidgetType;
  unit: string;
  x: number;
  y: number;
  w: number;
  h: number;
  min?: number;
  max?: number;
  color?: string;
  backgroundColor?: string;
  backgroundOpacity?: number;
  textColor?: string;
  datasetId?: string;
  field?: string;
  url?: string;
  imageUrl?: string;
  assetId?: string;
  imageFit?: "cover" | "contain" | "fill";
  videoUrl?: string;
  videoFit?: "cover" | "contain" | "fill";
  videoAutoplay?: boolean;
  videoMuted?: boolean;
  monitorProtocol?: "hls" | "webrtc";
  monitorSourceUrl?: string;
  content?: string;
  shape?: "rectangle" | "rounded" | "ellipse" | "line";
  borderColor?: string;
  borderWidth?: number;
  fontSize?: number;
  fontWeight?: number;
  textAlign?: "left" | "center" | "right";
  designState?: "auto" | "empty" | "loading" | "partial" | "error" | "forbidden";
  animation?: "none" | "fade" | "slide-up" | "scale" | "pulse";
  animationDuration?: number;
  animationDelay?: number;
}

export interface SceneDashboardState {
  side: SceneDashboardSide;
  width: number;
  backgroundColor?: string;
  backgroundOpacity?: number;
  blur?: number;
  borderRadius?: number;
  widgets: SceneDashboardWidgetState[];
}

export type SceneInteractionTrigger = "load" | "click" | "pointerEnter" | "pointerLeave" | "animationStart" | "animationEnd";

export type SceneInteractionTarget = {
  kind: "object";
  modelId: string;
  layerId?: string;
} | {
  kind: "widget";
  widgetId: string;
};

export type SceneInteractionActionType = "visibility" | "color" | "opacity" | "focus" | "animation" | "openUrl" | "navigateScene" | "cameraView" | "message" | "dashboard" | "setData";

export interface SceneInteractionActionState {
  id: string;
  type: SceneInteractionActionType;
  enabled: boolean;
  /** visibility: show/hide/toggle; animation: play/stop/toggle; color: #rrggbb; opacity: 0..1 */
  value?: string | number | boolean;
  /** openUrl 使用。 */
  url?: string;
  newTab?: boolean;
  /** 三维对象动作的显式目标；为空时使用触发事件的对象。 */
  target?: { kind: "object"; modelId: string; layerId?: string } | undefined;
  sceneId?: string;
  cameraViewId?: string;
  message?: string;
  dataKey?: string;
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
  cameraConstraints?: CameraConstraintsState;
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
  interactions?: SceneInteractionScriptState[];
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

export type SystemUserRole = "admin" | "editor" | "viewer";

export interface SystemUserRecord {
  id: string;
  username: string;
  displayName: string;
  role: SystemUserRole;
  projectIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StoredSystemUserRecord extends SystemUserRecord {
  passwordHash: string;
}

export interface AuditLogRecord {
  id: string;
  userId?: string;
  username?: string;
  action: string;
  resource: string;
  method: string;
  statusCode: number;
  ip?: string;
  detail?: string;
  createdAt: string;
}

export interface AiProviderSettings {
  baseUrl: string;
  model: string;
  protocol: "auto" | "responses" | "chat-completions";
  apiKeyConfigured: boolean;
  apiKey?: string;
  temperature: number;
  updatedAt?: string;
}

export interface ServiceHealthRecord {
  id: "api" | "web" | "media" | "vision" | "postgres" | "minio";
  name: string;
  status: "healthy" | "degraded" | "offline";
  endpoint: string;
  latencyMs?: number;
  message?: string;
  checkedAt: string;
}

export interface ServiceLogRecord {
  service: string;
  file: string;
  lines: string[];
  updatedAt?: string;
}

export interface AiAssistantResponse {
  text: string;
  dashboard?: SceneDashboardState;
  model: string;
}

export interface SystemBrandingSettings {
  systemName: string;
  browserTitle: string;
  loginSubtitle: string;
  copyright: string;
  logoUrl: string;
  iconUrl: string;
  primaryColor: string;
  defaultLocale: "zh-CN" | "en-US";
  defaultEntry: "manager" | "studio" | "data";
  defaultSceneBackground: string;
  defaultGridVisible: boolean;
  maintenanceEnabled: boolean;
  maintenanceMessage: string;
  updatedAt?: string;
}

export interface DatabaseDocument {
  projects: ProjectRecord[];
  scenes: SceneSnapshot[];
  publishedScenes?: PublishedSceneRecord[];
  applications?: ApplicationDocument[];
  publishedApplications?: PublishedApplicationRecord[];
  applicationPublicationPointers?: ApplicationPublicationPointer[];
  users?: StoredSystemUserRecord[];
  auditLogs?: AuditLogRecord[];
  aiSettings?: Omit<AiProviderSettings, "apiKeyConfigured"> & { apiKey?: string };
  branding?: SystemBrandingSettings;
}

export function createDefaultTransform(): ModelTransform {
  return {
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: 1, y: 1, z: 1 }
  };
}

export * from "./application.js";
export * from "./applicationMigration.js";
export * from "./resourceId.js";
