/**
 * World API v1 的 fail-closed 校验：未知键、非有限数、超限一律抛 WorldApiContractError，
 * 并带 `field` 路径供调用方（MCP / HTTP / SDK）原样回给智能体修正。
 * 只做形状与上限；场景命令逐类型的深度校验在运行时由 scene-sdk 完成（见 worldApi.ts 说明）。
 */

import {
  WORLD_API_VERSION,
  WORLD_FIXED_HZ,
  WORLD_LIMITS,
  WORLD_OBSERVATION_CHANNELS,
  WORLD_RESERVED_SENSOR_KINDS,
  type WorldAction,
  type WorldBodyConfig,
  type WorldObservationChannel,
  type WorldObserveRequest,
  type WorldPhysicsAction,
  type WorldResetOptions,
  type WorldResetRequest,
  type WorldSceneCommandInput,
  type WorldSensorSpec,
  type WorldSnapshot,
  type WorldStepRequest,
  type WorldVec3,
} from "./worldApi.js";

export class WorldApiContractError extends Error {
  readonly code = "world-api-contract";
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "WorldApiContractError";
  }
}

const BODY_TYPES = ["none", "fixed", "dynamic", "kinematic"] as const;
const PHYSICS_ACTION_TYPES = ["set-body", "apply-impulse", "set-linear-velocity", "set-angular-velocity"] as const;
/** dt × 60 与最近整数的容差；覆盖 1/60 这类不可精确表示的小数，同时拒绝 0.02 之类的非整倍。 */
const TICK_MULTIPLE_EPSILON = 1e-6;
const HEX_64 = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (!isRecord(value)) throw new WorldApiContractError(field, "必须是对象");
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new WorldApiContractError(`${field}.${key}`, `未知字段（允许：${allowed.join("、")}）`);
  }
  return value;
}

function finite(value: unknown, field: string, min = -Infinity, max = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new WorldApiContractError(field, "必须是有限数");
  if (value < min || value > max) throw new WorldApiContractError(field, `必须在 [${min}, ${max}] 内`);
  return value;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new WorldApiContractError(field, "必须是整数");
  if (value < min || value > max) throw new WorldApiContractError(field, `必须在 [${min}, ${max}] 内`);
  return value;
}

function id(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > WORLD_LIMITS.maxIdLength) {
    throw new WorldApiContractError(field, `必须是 1..${WORLD_LIMITS.maxIdLength} 字符的字符串`);
  }
  return value;
}

function vec3(value: unknown, field: string): WorldVec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new WorldApiContractError(field, "必须是 [x, y, z] 三元数组");
  return [finite(value[0], `${field}[0]`), finite(value[1], `${field}[1]`), finite(value[2], `${field}[2]`)];
}

function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) throw new WorldApiContractError(field, "必须是数组");
  if (value.length > max) throw new WorldApiContractError(field, `最多 ${max} 项`);
  return value;
}

export function validateWorldSeed(value: unknown, field = "seed"): number {
  return integer(value, field, 0, WORLD_LIMITS.maxSeed);
}

export function validateWorldResetRequest(value: unknown): WorldResetRequest {
  const input = record(value, "reset", ["seed", "scene", "options"]);
  const seed = validateWorldSeed(input.seed);
  if (!isRecord(input.scene)) throw new WorldApiContractError("scene", "必须是 SceneSnapshot 对象");
  if (input.scene.schemaVersion !== 1) throw new WorldApiContractError("scene.schemaVersion", "必须为 1");
  id(input.scene.id, "scene.id");
  for (const key of ["primitives", "models"] as const) {
    if (input.scene[key] !== undefined) array(input.scene[key], `scene.${key}`, WORLD_LIMITS.maxObjects);
  }
  const options = input.options === undefined ? undefined : validateResetOptions(input.options);
  return { seed, scene: input.scene, ...(options ? { options } : {}) };
}

function validateResetOptions(value: unknown): WorldResetOptions {
  const input = record(value, "options", ["ground", "initialPositionJitter"]);
  if (input.ground !== undefined && typeof input.ground !== "boolean") throw new WorldApiContractError("options.ground", "必须是布尔值");
  return {
    ...(input.ground !== undefined ? { ground: input.ground as boolean } : {}),
    ...(input.initialPositionJitter !== undefined
      ? { initialPositionJitter: finite(input.initialPositionJitter, "options.initialPositionJitter", 0, WORLD_LIMITS.maxInitialPositionJitter) }
      : {}),
  };
}

export function validateWorldBodyConfig(value: unknown, field: string): WorldBodyConfig {
  const input = record(value, field, ["type", "mass", "friction", "restitution"]);
  if (!BODY_TYPES.includes(input.type as (typeof BODY_TYPES)[number])) {
    throw new WorldApiContractError(`${field}.type`, `必须是 ${BODY_TYPES.join("、")} 之一`);
  }
  return {
    type: input.type as WorldBodyConfig["type"],
    ...(input.mass !== undefined ? { mass: finite(input.mass, `${field}.mass`, 1e-3, 1e6) } : {}),
    ...(input.friction !== undefined ? { friction: finite(input.friction, `${field}.friction`, 0, 10) } : {}),
    ...(input.restitution !== undefined ? { restitution: finite(input.restitution, `${field}.restitution`, 0, 1) } : {}),
  };
}

function validatePhysicsAction(value: unknown, field: string): WorldPhysicsAction {
  if (!isRecord(value)) throw new WorldApiContractError(field, "必须是对象");
  switch (value.type) {
    case "set-body": {
      const input = record(value, field, ["type", "objectId", "body"]);
      return { type: "set-body", objectId: id(input.objectId, `${field}.objectId`), body: validateWorldBodyConfig(input.body, `${field}.body`) };
    }
    case "apply-impulse": {
      const input = record(value, field, ["type", "objectId", "impulse"]);
      return { type: "apply-impulse", objectId: id(input.objectId, `${field}.objectId`), impulse: vec3(input.impulse, `${field}.impulse`) };
    }
    case "set-linear-velocity":
    case "set-angular-velocity": {
      const input = record(value, field, ["type", "objectId", "velocity"]);
      return { type: value.type, objectId: id(input.objectId, `${field}.objectId`), velocity: vec3(input.velocity, `${field}.velocity`) };
    }
    default:
      throw new WorldApiContractError(`${field}.type`, `必须是 ${PHYSICS_ACTION_TYPES.join("、")} 之一`);
  }
}

export function validateWorldAction(value: unknown, field = "action"): WorldAction {
  const input = record(value, field, ["commands", "physics", "events"]);
  const action: WorldAction = {};
  if (input.commands !== undefined) {
    action.commands = array(input.commands, `${field}.commands`, WORLD_LIMITS.maxCommandsPerAction).map((command, index) => {
      const path = `${field}.commands[${index}]`;
      if (!isRecord(command)) throw new WorldApiContractError(path, "必须是场景命令对象");
      id(command.id, `${path}.id`);
      if (typeof command.type !== "string") throw new WorldApiContractError(`${path}.type`, "必须是字符串");
      return command as WorldSceneCommandInput;
    });
  }
  if (input.physics !== undefined) {
    action.physics = array(input.physics, `${field}.physics`, WORLD_LIMITS.maxPhysicsActionsPerAction)
      .map((item, index) => validatePhysicsAction(item, `${field}.physics[${index}]`));
  }
  if (input.events !== undefined) {
    action.events = array(input.events, `${field}.events`, WORLD_LIMITS.maxEventsPerAction).map((item, index) => {
      const path = `${field}.events[${index}]`;
      const event = record(item, path, ["name", "data"]);
      return { name: id(event.name, `${path}.name`), ...(event.data !== undefined ? { data: event.data as never } : {}) };
    });
  }
  return action;
}

/** dt（秒）→ tick 数；非 1/60 整倍数明确报错（确定性第一，不取整）。 */
export function worldTicksFromDt(dt: unknown, field = "dt"): number {
  const seconds = finite(dt, field);
  const ticks = seconds * WORLD_FIXED_HZ;
  const rounded = Math.round(ticks);
  if (rounded < 1 || Math.abs(ticks - rounded) > TICK_MULTIPLE_EPSILON) {
    throw new WorldApiContractError(field, `必须是固定步长 1/${WORLD_FIXED_HZ} s 的正整数倍（收到 ${seconds}）；也可直接传整数 ticks`);
  }
  return rounded;
}

export interface ValidatedWorldStep {
  action: WorldAction;
  ticks: number;
}

export function validateWorldStepRequest(value: unknown): ValidatedWorldStep {
  const input = record(value, "step", ["action", "dt", "ticks"]) as WorldStepRequest & Record<string, unknown>;
  if ((input.dt === undefined) === (input.ticks === undefined)) throw new WorldApiContractError("step", "dt 与 ticks 必须二选一");
  const ticks = input.ticks !== undefined ? integer(input.ticks, "ticks", 1, WORLD_LIMITS.maxTicksPerStep) : worldTicksFromDt(input.dt);
  if (ticks > WORLD_LIMITS.maxTicksPerStep) {
    throw new WorldApiContractError(input.ticks !== undefined ? "ticks" : "dt", `单次 step 最多 ${WORLD_LIMITS.maxTicksPerStep} tick`);
  }
  return { action: input.action === undefined ? {} : validateWorldAction(input.action), ticks };
}

export function validateWorldObserveRequest(value: unknown): WorldObserveRequest {
  const input = record(value ?? {}, "observe", ["channels", "sensors"]);
  const request: WorldObserveRequest = {};
  if (input.channels !== undefined) {
    const channels = array(input.channels, "channels", WORLD_OBSERVATION_CHANNELS.length);
    for (const [index, channel] of channels.entries()) {
      if (!WORLD_OBSERVATION_CHANNELS.includes(channel as never)) {
        throw new WorldApiContractError(`channels[${index}]`, `必须是 ${WORLD_OBSERVATION_CHANNELS.join("、")} 之一`);
      }
    }
    request.channels = [...new Set(channels)] as WorldObservationChannel[];
  }
  if (input.sensors !== undefined) {
    request.sensors = array(input.sensors, "sensors", WORLD_LIMITS.maxSensorsPerObservation).map((item, index): WorldSensorSpec => {
      const path = `sensors[${index}]`;
      const sensor = record(item, path, ["id", "kind", "params"]);
      if (!WORLD_RESERVED_SENSOR_KINDS.includes(sensor.kind as never)) {
        throw new WorldApiContractError(`${path}.kind`, `v1 仅登记 ${WORLD_RESERVED_SENSOR_KINDS.join("、")}（阶段 3 实现）`);
      }
      return { id: id(sensor.id, `${path}.id`), kind: sensor.kind as WorldSensorSpec["kind"], ...(sensor.params !== undefined ? { params: sensor.params as never } : {}) };
    });
  }
  return request;
}

/** 快照形状校验（不含哈希核验，哈希在运行时用 sha256 复算）。 */
export function validateWorldSnapshot(value: unknown): WorldSnapshot {
  if (!isRecord(value)) throw new WorldApiContractError("snapshot", "必须是对象");
  if (value.snapshotVersion !== WORLD_API_VERSION) throw new WorldApiContractError("snapshot.snapshotVersion", `仅支持版本 ${WORLD_API_VERSION}`);
  validateWorldSeed(value.seed, "snapshot.seed");
  integer(value.tick, "snapshot.tick", 0, WORLD_LIMITS.maxTotalTicks);
  id(value.sceneId, "snapshot.sceneId");
  for (const key of ["sceneHash", "traceHash", "snapshotHash"] as const) {
    if (typeof value[key] !== "string" || !HEX_64.test(value[key] as string)) throw new WorldApiContractError(`snapshot.${key}`, "必须是 64 位小写 hex");
  }
  integer(value.rngState, "snapshot.rngState", 0, WORLD_LIMITS.maxSeed);
  vec3(value.gravity, "snapshot.gravity");
  if (typeof value.ground !== "boolean") throw new WorldApiContractError("snapshot.ground", "必须是布尔值");
  array(value.objects, "snapshot.objects", WORLD_LIMITS.maxObjects);
  const physics = record(value.physics, "snapshot.physics", ["encoding", "data", "byteLength", "sha256"]);
  if (physics.encoding !== "base64" || typeof physics.data !== "string") throw new WorldApiContractError("snapshot.physics", "必须是 base64 编码的物理字节");
  integer(physics.byteLength, "snapshot.physics.byteLength", 1, WORLD_LIMITS.maxSnapshotBytes);
  if (typeof physics.sha256 !== "string" || !HEX_64.test(physics.sha256)) throw new WorldApiContractError("snapshot.physics.sha256", "必须是 64 位小写 hex");
  // base64 长度先验：避免在校验前就解码超大载荷。
  if (physics.data.length > Math.ceil(WORLD_LIMITS.maxSnapshotBytes / 3) * 4) throw new WorldApiContractError("snapshot.physics.data", "超过快照字节上限");
  return value as unknown as WorldSnapshot;
}
