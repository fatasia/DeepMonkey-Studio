import type { Vector3Value } from "./geometry.js";

export type IndustrialPrefabKind =
  | "conveyor"
  | "robot-arm"
  | "person"
  | "agv"
  | "vehicle"
  | "access-control"
  | "display"
  | "fence"
  | "road"
  | "machine"
  | "utility"
  | "electrical"
  | "sensor"
  | "camera"
  | "storage";

export type IndustrialPrefabOperatingState = "idle" | "running" | "paused" | "fault" | "maintenance";
export type IndustrialPrefabParameterValue = string | number | boolean;
export type IndustrialPrefabRuntimeAction = "dispatch" | "pause" | "resume" | "stop" | "return" | "replay" | "clear-fault";

export type RoadSurface = "asphalt" | "concrete";
export type RoadMarking = "none" | "center" | "lanes";

/**
 * 首条道路作者合同；junction 交汇由路径点标记承担（见 SceneLinearPrefabPathPoint.junction），
 * 弯道圆角与复杂立交仍留给后续独立合同扩展。
 */
export interface StraightRoadPrefabParameters {
  lengthM: number;
  carriagewayWidthM: number;
  laneCount: number;
  shoulderWidthM: number;
  surface: RoadSurface;
  marking: RoadMarking;
  /**
   * 道路碰撞体厚度（米）。仅作者显式设置时出现；未设置时消费端使用缺省厚度，
   * 碰撞体顶面恒对齐车行道路面顶，保证角色/载具站立高度与视觉一致。
   */
  colliderThicknessM?: number;
}

export interface SceneLinearPrefabPathPoint {
  /** Stable author identity used by endpoint/spline editing and undo snapshots. */
  id: string;
  /** Position in the prefab root's local coordinate system. */
  position: Vector3Value;
  /**
   * 路口标记：该点为 T/十字等道路交汇中心，道路在此生成等宽方形路口盖板，
   * 消除支路端头与主路的错缝。仅道路消费；围栏等其余线性预制体忽略该标记。
   */
  junction?: boolean;
}

/** Shared structural path for fences and roads; separate from moving-object routes. */
export interface SceneLinearPrefabPathState {
  points: SceneLinearPrefabPathPoint[];
  interpolation: "linear" | "catmull-rom";
  closed: boolean;
  /** Projects authored points onto scene geometry before rebuilding the path. */
  snapToGround: boolean;
  /** Stable uint32 seed for deterministic gates, markings and future path decoration. */
  seed: number;
  /**
   * 相邻路径点坡度上限（度），缺省与导航 maxSlopeAngle 缺省口径一致（50°）。
   * 超限路径 fail-closed 整体拒绝：作者预览与发布编译同走该判定，不允许静默降级。
   */
  maxSlopeAngleDegrees?: number;
}

export interface SceneMotionRoutePoint {
  id: string;
  position: Vector3Value;
  /** 到点停留时间，单位秒。 */
  waitSeconds?: number;
  /** 仅覆盖到下一点的速度，未设置时使用路线默认速度。 */
  speedOverrideMps?: number;
}

export interface SceneMotionRouteState {
  enabled: boolean;
  /** 进入预览或发布浏览后自动开始运行。 */
  autoplay?: boolean;
  points: SceneMotionRoutePoint[];
  speedMps: number;
  accelerationMps2: number;
  loopMode: "once" | "loop" | "ping-pong";
  orientToPath: boolean;
  startOffsetSeconds: number;
  /** 同组移动体可在运行时进行轻量占用与间隔协调。 */
  trafficGroup?: string;
}

export interface SceneMediaSurfaceState {
  sourceKind: "dashboard-page" | "image" | "video" | "hls" | "webrtc" | "url";
  source?: string;
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  fit: "contain" | "cover" | "stretch";
  brightness: number;
}

/**
 * GLB 只负责视觉资源；预制体实例保存业务参数、运行状态和行为配置。
 * 参数键由定义版本约束，便于后续升级、实例覆盖与脚本自动补全。
 */
export interface IndustrialPrefabInstanceState {
  definitionId: string;
  definitionVersion: string;
  kind: IndustrialPrefabKind;
  parameters: Record<string, IndustrialPrefabParameterValue>;
  operatingState: IndustrialPrefabOperatingState;
  faultCode?: string;
  motionRoute?: SceneMotionRouteState;
  mediaSurface?: SceneMediaSurfaceState;
  /** Structural placement for path-capable static prefabs such as fences and roads. */
  placementPath?: SceneLinearPrefabPathState;
}

export type IndustrialPrefabParameterKind = "number" | "boolean" | "text" | "select" | "color";

export interface IndustrialPrefabParameterDefinition {
  key: string;
  name: string;
  englishName: string;
  kind: IndustrialPrefabParameterKind;
  defaultValue: IndustrialPrefabParameterValue;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  advanced?: boolean;
}

export interface IndustrialPrefabActionDefinition {
  id: string;
  name: string;
  englishName: string;
  /** 写操作由同一命令系统执行，便于撤销、审计和脚本复用。 */
  changesState: boolean;
}

export interface IndustrialPrefabDefinition {
  id: string;
  version: string;
  kind: IndustrialPrefabKind;
  name: string;
  englishName: string;
  description: string;
  englishDescription: string;
  parameters: IndustrialPrefabParameterDefinition[];
  actions: IndustrialPrefabActionDefinition[];
  dataPorts: string[];
  routeCapable: boolean;
  pathCapable: boolean;
  rigCapable: boolean;
}
