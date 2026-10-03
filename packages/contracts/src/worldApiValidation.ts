/**
 * World API v1 的 fail-closed 校验：未知键、非有限数、超限一律抛 WorldApiContractError，
 * 并带 `field` 路径供调用方（MCP / HTTP / SDK）原样回给智能体修正。
 * 只做形状与上限；场景命令逐类型的深度校验在运行时由 scene-sdk 完成（见 worldApi.ts 说明）。
 */

import type { JsonValue } from "./application.js";
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

function vec3(value: unknown, field: string, maxAbs = Infinity): WorldVec3 {
  if (!Array.isArray(value) || value.length !== 3) throw new WorldApiContractError(field, "必须是 [x, y, z] 三元数组");
  return [0, 1, 2].map((index) => finite(value[index], `${field}[${index}]`, -maxAbs, maxAbs)) as unknown as WorldVec3;
}

/** 供运行时复用的范围校验（同一份上限，避免 reset 与 step 口径漂移）。 */
export const worldNumber = finite;
export const worldVec3 = vec3;

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
    ...(input.mass !== undefined ? { mass: finite(input.mass, `${field}.mass`, WORLD_LIMITS.minMass, WORLD_LIMITS.maxMass) } : {}),
    ...(input.friction !== undefined ? { friction: finite(input.friction, `${field}.friction`, 0, WORLD_LIMITS.maxFriction) } : {}),
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
      return { type: "apply-impulse", objectId: id(input.objectId, `${field}.objectId`), impulse: vec3(input.impulse, `${field}.impulse`, WORLD_LIMITS.maxAbsImpulse) };
    }
    case "set-linear-velocity":
    case "set-angular-velocity": {
      const input = record(value, field, ["type", "objectId", "velocity"]);
      return { type: value.type, objectId: id(input.objectId, `${field}.objectId`), velocity: vec3(input.velocity, `${field}.velocity`, WORLD_LIMITS.maxAbsVelocity) };
    }
    default:
      throw new WorldApiContractError(`${field}.type`, `必须是 ${PHYSICS_ACTION_TYPES.join("、")} 之一`);
  }
}

/**
 * 纯 JSON 形状检查：限深度/节点数，拒绝非有限数、非纯对象与 __proto__ 键。
 * 深度先于一切递归，20 万层嵌套也不会栈溢出；__proto__ 在 canonicalJson 里会被静默丢弃，
 * 若放行会让 traceHash/动作指纹与回显内容不一致，所以在入口拒绝而不是改共享的指纹实现。
 */
function assertPlainJson(value: unknown, field: string, maxDepth: number, maxNodes: number): void {
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > maxNodes) throw new WorldApiContractError(field, `节点数超过 ${maxNodes}`);
    if (depth > maxDepth) throw new WorldApiContractError(field, `嵌套深度超过 ${maxDepth}`);
    if (node === null || typeof node === "string" || typeof node === "boolean") return;
    if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new WorldApiContractError(field, "不允许非有限数");
      return;
    }
    if (Array.isArray(node)) { node.forEach((item) => visit(item, depth + 1)); return; }
    const prototype = typeof node === "object" ? Object.getPrototypeOf(node) : undefined;
    if (isRecord(node) && (prototype === Object.prototype || prototype === null)) {
      for (const key of Object.keys(node)) {
        if (key === "__proto__") throw new WorldApiContractError(field, "不允许 __proto__ 键");
        visit(node[key], depth + 1);
      }
      return;
    }
    throw new WorldApiContractError(field, "只允许纯 JSON 值");
  };
  visit(value, 0);
}

/** 事件 data：小型纯 JSON（深度/节点/序列化字节三重上限）。 */
export function validateWorldEventData(value: unknown, field: string): JsonValue {
  assertPlainJson(value, field, WORLD_LIMITS.maxEventDataDepth, WORLD_LIMITS.maxEventDataNodes);
  if (JSON.stringify(value).length > WORLD_LIMITS.maxEventDataBytes) throw new WorldApiContractError(field, `序列化后超过 ${WORLD_LIMITS.maxEventDataBytes} 字节`);
  return value as JsonValue;
}
export function validateWorldAction(value: unknown, field = "action"): WorldAction {
  const input = record(value, field, ["commands", "physics", "events"]);
  const action: WorldAction = {};
  if (input.commands !== undefined) {
    action.commands = array(input.commands, `${field}.commands`, WORLD_LIMITS.maxCommandsPerAction).map((command, index) => {
      const path = `${field}.commands[${index}]`;
      if (!isRecord(command)) throw new WorldApiContractError(path, "必须是场景命令对象");
      id(command.id, `${path}.id`);
      assertPlainJson(command, path, 16, 2_048);
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
      return { name: id(event.name, `${path}.name`), ...(event.data !== undefined ? { data: validateWorldEventData(event.data, `${path}.data`) } : {}) };
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
        throw new WorldApiContractError(`${path}.kind`, `v1 仅登记 ${WORLD_RESERVED_SENSOR_KINDS.join("、")}（当前未实现采样）`);
      }
      return { id: id(sensor.id, `${path}.id`), kind: sensor.kind as WorldSensorSpec["kind"], ...(sensor.params !== undefined ? { params: sensor.params as never } : {}) };
    });
  }
  return request;
}

const SNAPSHOT_BODY_TYPES = ["none", "fixed", "dynamic", "kinematic"] as const;
const SNAPSHOT_SHAPES = ["cuboid", "ball", "cylinder", "cone", "capsule"] as const;

function validateColliderSpec(value: unknown, field: string): void {
  if (!isRecord(value) || !SNAPSHOT_SHAPES.includes(value.shape as never)) throw new WorldApiContractError(field, `shape 必须是 ${SNAPSHOT_SHAPES.join("、")} 之一`);
  const extent = (item: unknown, path: string) => finite(item, path, 1e-6, WORLD_LIMITS.maxColliderExtent);
  if (value.shape === "cuboid") {
    record(value, field, ["shape", "halfExtents"]);
    if (!Array.isArray(value.halfExtents) || value.halfExtents.length !== 3) throw new WorldApiContractError(`${field}.halfExtents`, "必须是 [x, y, z]");
    value.halfExtents.forEach((item, index) => extent(item, `${field}.halfExtents[${index}]`));
  } else if (value.shape === "ball") {
    record(value, field, ["shape", "radius"]);
    extent(value.radius, `${field}.radius`);
  } else {
    record(value, field, ["shape", "radius", "halfHeight"]);
    extent(value.radius, `${field}.radius`);
    extent(value.halfHeight, `${field}.halfHeight`);
  }
}

/** 快照对象表逐项校验：这是 restore 的资源上限防线，数值口径与 reset/step 完全一致。 */
function validateSnapshotObjects(value: unknown, ground: boolean, groundHandle: unknown): void {
  const objects = array(value, "snapshot.objects", WORLD_LIMITS.maxObjects);
  const ids = new Set<string>();
  const handles = new Set<number>();
  if (ground ? groundHandle === null || typeof groundHandle !== "number" : groundHandle !== null) {
    throw new WorldApiContractError("snapshot.groundHandle", "必须与 ground 标志一致（有地面为整数句柄，无地面为 null）");
  }
  // Rapier 句柄是把 (index, generation) 位编码进 f64 的不透明数（如 5e-324），不是整数，只校验有限且非负。
  if (typeof groundHandle === "number") handles.add(finite(groundHandle, "snapshot.groundHandle", 0));
  objects.forEach((item, index) => {
    const path = `snapshot.objects[${index}]`;
    const object = record(item, path, ["id", "kind", "source", "name", "visible", "body", "transform", "collider", "handle"]);
    const objectId = id(object.id, `${path}.id`);
    if (objectId.startsWith("@") || ids.has(objectId)) throw new WorldApiContractError(`${path}.id`, "不能以 @ 开头且必须唯一");
    ids.add(objectId);
    if (typeof object.kind !== "string" || object.kind.length > 64) throw new WorldApiContractError(`${path}.kind`, "必须是 ≤64 字符的字符串");
    if (object.source !== "primitive" && object.source !== "model") throw new WorldApiContractError(`${path}.source`, "必须是 primitive 或 model");
    if (typeof object.name !== "string" || object.name.length > WORLD_LIMITS.maxNameLength) throw new WorldApiContractError(`${path}.name`, `必须是 ≤${WORLD_LIMITS.maxNameLength} 字符的字符串`);
    if (typeof object.visible !== "boolean") throw new WorldApiContractError(`${path}.visible`, "必须是布尔值");
    const body = record(object.body, `${path}.body`, ["type", "mass", "friction", "restitution"]);
    if (!SNAPSHOT_BODY_TYPES.includes(body.type as never)) throw new WorldApiContractError(`${path}.body.type`, `必须是 ${SNAPSHOT_BODY_TYPES.join("、")} 之一`);
    finite(body.mass, `${path}.body.mass`, WORLD_LIMITS.minMass, WORLD_LIMITS.maxMass);
    finite(body.friction, `${path}.body.friction`, 0, WORLD_LIMITS.maxFriction);
    finite(body.restitution, `${path}.body.restitution`, 0, 1);
    const transform = record(object.transform, `${path}.transform`, ["position", "rotation", "scale"]);
    vec3(transform.position, `${path}.transform.position`, WORLD_LIMITS.maxStateMagnitude);
    vec3(transform.rotation, `${path}.transform.rotation`, 1e6);
    (vec3(transform.scale, `${path}.transform.scale`, WORLD_LIMITS.maxScale)).forEach((axis, axisIndex) => {
      if (Math.abs(axis) < WORLD_LIMITS.minScale) throw new WorldApiContractError(`${path}.transform.scale[${axisIndex}]`, `绝对值不能小于 ${WORLD_LIMITS.minScale}`);
    });
    if (object.collider === null) {
      if (body.type !== "none") throw new WorldApiContractError(`${path}.collider`, "带刚体的物体必须有碰撞体");
    } else validateColliderSpec(object.collider, `${path}.collider`);
    if ((body.type === "none") !== (object.handle === null)) throw new WorldApiContractError(`${path}.handle`, "仅 type=none 的物体句柄为 null");
    if (object.handle !== null) {
      const handle = finite(object.handle, `${path}.handle`, 0);
      if (handles.has(handle)) throw new WorldApiContractError(`${path}.handle`, "刚体句柄重复");
      handles.add(handle);
    }
  });
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
  vec3(value.gravity, "snapshot.gravity", WORLD_LIMITS.maxAbsGravity);
  if (typeof value.ground !== "boolean") throw new WorldApiContractError("snapshot.ground", "必须是布尔值");
  validateSnapshotObjects(value.objects, value.ground === true, value.groundHandle);
  const physics = record(value.physics, "snapshot.physics", ["encoding", "data", "byteLength", "sha256"]);
  if (physics.encoding !== "base64" || typeof physics.data !== "string") throw new WorldApiContractError("snapshot.physics", "必须是 base64 编码的物理字节");
  integer(physics.byteLength, "snapshot.physics.byteLength", 1, WORLD_LIMITS.maxSnapshotBytes);
  if (typeof physics.sha256 !== "string" || !HEX_64.test(physics.sha256)) throw new WorldApiContractError("snapshot.physics.sha256", "必须是 64 位小写 hex");
  // base64 长度先验：避免在校验前就解码超大载荷。
  if (physics.data.length > Math.ceil(WORLD_LIMITS.maxSnapshotBytes / 3) * 4) throw new WorldApiContractError("snapshot.physics.data", "超过快照字节上限");
  return value as unknown as WorldSnapshot;
}
