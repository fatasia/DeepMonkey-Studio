/**
 * World API v1 合同：让 AI / 外部智能体以确定性、可验证的方式驱动场景世界。
 *
 * 生命周期：reset(seed, scene) → step(action, dt)* → observe(channels) / snapshot() / restore(snapshot)。
 * 本文件只有类型与常量；校验在 worldApiValidation.ts，运行时在 packages/world-runtime，
 * 三路暴露（MCP / HTTP / JS SDK）全部消费同一份合同，不另设并行协议。
 *
 * 确定性约定（可被单测证伪）：
 * - 时间只用整数 tick，固定 60Hz；`dt` 必须是 tick 的整数倍，否则明确拒绝，绝不静默取整。
 * - 同 seed + 同初始 scene + 同 action 序列 → 逐位一致的 observation 序列；
 *   调用如何拆分（一次 step 6 tick 或 6 次 step 1 tick）不影响结果。
 * - action 作用在本次 step 窗口的第一个 tick 之前；速度设定值持续到下一次被改写。
 *
 * 复用而非另造：`commands` 就是 scene-sdk 的场景命令 IR（SceneCommand，19 类）；
 * contracts 不能反向依赖 scene-sdk，所以这里只校验"形状与上限"，逐类型深度校验由运行时调用
 * scene-sdk 的 validateSceneCommand 完成。`events` 复用 SceneEvent.business.event 的形状。
 */

import type { JsonValue } from "./application.js";

export const WORLD_API_VERSION = "1" as const;
export type WorldApiVersion = typeof WORLD_API_VERSION;

/** 世界固定步频（Hz）；与 PhysicsWorldHost 的 60Hz 固定步长同源。 */
export const WORLD_FIXED_HZ = 60 as const;

/** 合同与运行时共享的硬上限；任何超限输入 fail-closed 拒绝。 */
export const WORLD_LIMITS = {
  /** seed 为 uint32。 */
  maxSeed: 0xffffffff,
  /** 单个世界可同时存在的物体数（含 type=none 的纯位姿物体）。 */
  maxObjects: 256,
  /** 单次 step 最多推进的 tick（10 s），防单次调用长时间占用事件循环。 */
  maxTicksPerStep: 600,
  /** 单个世界生命期内累计 tick 上限（1 h 仿真时间），防无限续跑占用会话。 */
  maxTotalTicks: 216_000,
  /** 与 SCENE_COMMAND_TRANSACTION_MAX_COMMANDS 对齐。 */
  maxCommandsPerAction: 64,
  maxPhysicsActionsPerAction: 128,
  maxEventsPerAction: 32,
  /** 单次 step 返回的接触/事件条数上限，超出置 truncated 而非静默丢弃。 */
  maxContactsPerStep: 1024,
  /** 快照物理字节上限（解码后）。 */
  maxSnapshotBytes: 16 * 1024 * 1024,
  maxIdLength: 200,
  maxSensorsPerObservation: 16,
  /** reset 时 initialPositionJitter 的上限（米）。 */
  maxInitialPositionJitter: 1,
  /** 数值量级上限：杜绝 1e308 之类把 Rapier 推成 NaN 或超长求解的输入。 */
  maxAbsPosition: 10_000,
  minScale: 0.01,
  maxScale: 20,
  maxAbsGravity: 1_000,
  maxAbsVelocity: 1_000,
  maxAbsImpulse: 10_000_000,
  /** 缩放后碰撞体任一半尺寸/半径/半高的上限（米）；与地面 5000 m 半宽同量级以内。 */
  maxColliderExtent: 500,
  minMass: 1e-3,
  maxMass: 1e6,
  maxFriction: 10,
  /** 物体名称长度上限；超出在 reset 时截断（名称只是标签）。 */
  maxNameLength: 128,
  /** 动作注入事件 data 的 JSON 上限：深度 / 节点数 / 序列化字节。 */
  maxEventDataDepth: 8,
  maxEventDataNodes: 256,
  maxEventDataBytes: 4_096,
  /** 运行时状态（位置/速度）的健康上限，仅用于 restore 与 step 后的有限性/量级体检。 */
  maxStateMagnitude: 1e9,
} as const;

export type WorldVec3 = readonly [number, number, number];
export type WorldQuat = readonly [number, number, number, number];

export const WORLD_OBSERVATION_CHANNELS = ["poses", "contacts", "events"] as const;
export type WorldObservationChannel = (typeof WORLD_OBSERVATION_CHANNELS)[number];

/**
 * 传感器扩展点：v1 只登记种类（schema 占位），不实现采样。请求这些种类会得到
 * `status: "unsupported"` 的占位读数，而不是错误或伪造数据。
 */
export const WORLD_RESERVED_SENSOR_KINDS = ["camera-rgb", "depth", "normal", "segmentation", "lidar"] as const;
export type WorldReservedSensorKind = (typeof WORLD_RESERVED_SENSOR_KINDS)[number];

export type WorldBodyType = "none" | "fixed" | "dynamic" | "kinematic";

export interface WorldResetOptions {
  /** 是否放置与 Viewer 一致的静态地面（y=0 顶面）；默认 true。 */
  ground?: boolean;
  /** 对动态刚体初始位置施加 seed 驱动的均匀抖动（米，±）；默认 0；仅用于让 seed 对 reset 结果可观测，不是域随机化框架。 */
  initialPositionJitter?: number;
}

/** reset 请求：scene 即 SceneSnapshot（只消费 primitives/models/physics 的物理相关字段）。 */
export interface WorldResetRequest {
  seed: number;
  scene: Record<string, unknown>;
  options?: WorldResetOptions;
}

export interface WorldSceneCommandInput {
  id: string;
  type: string;
  [key: string]: unknown;
}

export interface WorldBodyConfig {
  type: WorldBodyType;
  mass?: number;
  friction?: number;
  restitution?: number;
}

export type WorldPhysicsAction =
  | { type: "set-body"; objectId: string; body: WorldBodyConfig }
  | { type: "apply-impulse"; objectId: string; impulse: WorldVec3 }
  | { type: "set-linear-velocity"; objectId: string; velocity: WorldVec3 }
  | { type: "set-angular-velocity"; objectId: string; velocity: WorldVec3 };

export interface WorldInjectedEvent {
  name: string;
  data?: JsonValue;
}

/** 一次 step 的动作；命令 → 物理动作 → 事件按此顺序、各自按数组顺序生效，整体原子（任一项非法则整条拒绝）。 */
export interface WorldAction {
  commands?: WorldSceneCommandInput[];
  physics?: WorldPhysicsAction[];
  events?: WorldInjectedEvent[];
}

/** step 请求：dt（秒，必须是 1/60 的整数倍）与 ticks（整数）二选一。 */
export interface WorldStepRequest {
  action?: WorldAction;
  dt?: number;
  ticks?: number;
}

export interface WorldSensorSpec {
  id: string;
  kind: WorldReservedSensorKind;
  params?: Record<string, JsonValue>;
}

export interface WorldObserveRequest {
  /** 缺省返回全部通道。 */
  channels?: WorldObservationChannel[];
  sensors?: WorldSensorSpec[];
}

export interface WorldBodyObservation {
  id: string;
  kind: string;
  bodyType: WorldBodyType;
  visible: boolean;
  position: WorldVec3;
  /** 四元数 [x, y, z, w]。 */
  rotation: WorldQuat;
  linearVelocity: WorldVec3;
  angularVelocity: WorldVec3;
  sleeping: boolean;
}

/** 地面在接触对中的保留 id。 */
export const WORLD_GROUND_ID = "@ground" as const;

export interface WorldContactObservation {
  tick: number;
  a: string;
  b: string;
  started: boolean;
}

/** 行为层事件：碰撞事件按接收对象各一条（与 Viewer 的 collisionStart/End 派发同语义）+ 动作注入的 business.event。 */
export type WorldEventObservation =
  | { tick: number; type: "object.event"; name: "collisionStart" | "collisionEnd"; target: { kind: "object"; sceneId: string; objectId: string }; data: { other: string } }
  | { tick: number; type: "business.event"; name: string; sceneId: string; data?: JsonValue };

export type WorldSensorReading =
  | { status: "unsupported"; kind: WorldReservedSensorKind; reason: "not-implemented" };

export interface WorldObservation {
  observationVersion: WorldApiVersion;
  tick: number;
  /** tick / 60；仅便利字段，权威时间轴是 tick。 */
  timeSeconds: number;
  seed: number;
  /** 当前世界物理 + 对象注册表的 sha256（hex）；两次运行逐位一致时必然相同。 */
  stateHash: string;
  bodies?: WorldBodyObservation[];
  /** 自上一次 step 调用起累积的接触（本次 step 内所有 tick）。 */
  contacts?: WorldContactObservation[];
  events?: WorldEventObservation[];
  /** true 表示接触/事件条数触顶被截断。 */
  truncated?: boolean;
  sensors?: Record<string, WorldSensorReading>;
}

export interface WorldCommandResult {
  id: string;
  type: string;
  /** noop = 合法但对无头物理世界无效果的场景命令（材质/相机/光照等）。 */
  status: "applied" | "noop";
}

export interface WorldStepResult {
  ticksAdvanced: number;
  tickBefore: number;
  tickAfter: number;
  commandResults: WorldCommandResult[];
  /** sha256(上一链值 + tick + action + stateHash)；逐 step 形成可校验的轨迹链。 */
  traceHash: string;
  observation: WorldObservation;
}

export interface WorldSnapshotPhysics {
  encoding: "base64";
  data: string;
  byteLength: number;
  sha256: string;
}

/** 快照内保存的对象注册表条目（无头世界没有网格，因此这就是场景语义的权威副本）。 */
export interface WorldSnapshotObject {
  id: string;
  kind: string;
  source: "primitive" | "model";
  name: string;
  visible: boolean;
  body: { type: WorldBodyType; mass: number; friction: number; restitution: number };
  /**
   * 欧拉角（弧度，XYZ），与 SceneSnapshot 一致。type=none 时即权威位姿；
   * 已有刚体的对象这里只是生成时位姿，实时位姿以 physics 字节为准。
   */
  transform: { position: WorldVec3; rotation: WorldVec3; scale: WorldVec3 };
  /** 未缩放的基础碰撞体（局部空间，米），实际尺寸 = 基础形状 × transform.scale；null = 无可用碰撞体（不能挂刚体）。 */
  collider: WorldColliderSpec | null;
  /** Rapier 刚体句柄；type=none 时为 null。 */
  handle: number | null;
}

export type WorldColliderSpec =
  | { shape: "cuboid"; halfExtents: WorldVec3 }
  | { shape: "ball"; radius: number }
  | { shape: "cylinder"; halfHeight: number; radius: number }
  | { shape: "cone"; halfHeight: number; radius: number }
  | { shape: "capsule"; halfHeight: number; radius: number };

export interface WorldSnapshot {
  snapshotVersion: WorldApiVersion;
  seed: number;
  tick: number;
  /** sceneId 来自 reset 时的 SceneSnapshot.id；命令里的 sceneId 必须与之相同。 */
  sceneId: string;
  /** reset 时 SceneSnapshot 的语义哈希（canonical JSON → sha256）。 */
  sceneHash: string;
  /** 轨迹链当前值；restore 后继续 step 的 traceHash 与不中断运行一致。 */
  traceHash: string;
  /** seed 派生的 PRNG 当前状态（uint32）。 */
  rngState: number;
  gravity: WorldVec3;
  ground: boolean;
  objects: WorldSnapshotObject[];
  groundHandle: number | null;
  physics: WorldSnapshotPhysics;
  /** 对以上全部字段（不含自身）的 sha256；restore 先校验再装载。 */
  snapshotHash: string;
}

export interface WorldSessionInfo {
  worldId: string;
  seed: number;
  tick: number;
  sceneId: string;
  objectCount: number;
  createdAt: string;
  lastUsedAt: string;
}
