import {
  WORLD_LIMITS,
  type JsonValue,
  type WorldAction,
  type WorldBodyConfig,
  type WorldBodyType,
  type WorldCommandResult,
  type WorldSnapshotObject,
  type WorldVec3,
} from "@bim-studio/contracts";
import { SceneCommandValidationError, parseSceneCommand, type SceneCommand } from "@bim-studio/scene-sdk";
import { WorldRuntimeError } from "./worldMath.js";

export type WorldOp =
  | { op: "create"; id: string; name: string; kind: string }
  | { op: "delete"; id: string }
  | { op: "visibility"; id: string; visible: boolean }
  | { op: "transform"; id: string; position?: WorldVec3; rotation?: WorldVec3; scale?: WorldVec3 }
  | { op: "set-body"; id: string; body: WorldBodyConfig }
  | { op: "impulse" | "linear-velocity" | "angular-velocity"; id: string; vector: WorldVec3 }
  | { op: "event"; name: string; data?: JsonValue };

export interface WorldActionPlan {
  ops: WorldOp[];
  commandResults: WorldCommandResult[];
}

/** 对物理世界没有效果、但属于合法场景 IR 的命令：接受并如实标注 noop，不静默假装生效。 */
const NOOP_COMMANDS = new Set<SceneCommand["type"]>([
  "material.set", "selection.set", "camera.set", "camera.fly-to", "lighting.set", "environment.set",
  "animation.control", "animation.set-anchor", "data.apply", "component.update",
  "unity.properties.set", "unity.action.invoke", "unity.scene.switch",
]);

interface ShadowObject {
  source: "primitive" | "model";
  bodyType: WorldBodyType;
  hasCollider: boolean;
  scale: WorldVec3;
}

const same = (a: WorldVec3, b: WorldVec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/**
 * 在不改动世界的前提下校验并展开 action：命令 → 物理动作 → 事件。
 * 用影子表追踪本次 action 内的创建/删除/刚体类型变化，所以"先创建再摆位"合法，
 * 而任一项非法都会在任何状态变更之前抛出，保证 step 的原子性。
 */
export function planWorldAction(action: WorldAction, sceneId: string, objects: ReadonlyMap<string, WorldSnapshotObject>): WorldActionPlan {
  const shadow = new Map<string, ShadowObject>();
  for (const [id, object] of objects) {
    shadow.set(id, { source: object.source, bodyType: object.body.type, hasCollider: object.collider !== null, scale: object.transform.scale });
  }
  const fail = (message: string): never => { throw new WorldRuntimeError("invalid-action", message); };
  const need = (id: string): ShadowObject => shadow.get(id) ?? fail(`物体不存在：${id}`);
  const ops: WorldOp[] = [];
  const commandResults: WorldCommandResult[] = [];

  for (const [index, input] of (action.commands ?? []).entries()) {
    let command: SceneCommand;
    try {
      command = parseSceneCommand(input);
    } catch (error) {
      if (error instanceof SceneCommandValidationError) return fail(`commands[${index}] 不是合法的场景命令：${error.message}`);
      throw error;
    }
    const label = `commands[${index}](${command.type})`;
    const objectTarget = (target: { kind: string; sceneId: string; objectId?: string }): string => {
      if (target.kind !== "object" || !target.objectId) return fail(`${label} 在无头世界只支持 object 级目标`);
      if (target.sceneId !== sceneId) return fail(`${label} 的 sceneId 与世界场景 ${sceneId} 不一致`);
      return target.objectId;
    };
    switch (command.type) {
      case "object.create-primitive": {
        const id = objectTarget(command.target);
        if (id.startsWith("@") || shadow.has(id)) fail(`${label} 物体 id 非法或已存在：${id}`);
        if (shadow.size >= WORLD_LIMITS.maxObjects) throw new WorldRuntimeError("limit-exceeded", `${label} 超过物体上限 ${WORLD_LIMITS.maxObjects}`);
        shadow.set(id, { source: "primitive", bodyType: "none", hasCollider: true, scale: [1, 1, 1] });
        ops.push({ op: "create", id, name: command.name, kind: command.kind });
        break;
      }
      case "object.delete-primitive": {
        const id = objectTarget(command.target);
        if (need(id).source !== "primitive") fail(`${label} 只能删除基础体，${id} 是模型`);
        shadow.delete(id);
        ops.push({ op: "delete", id });
        break;
      }
      case "object.set-visibility": {
        const id = objectTarget(command.target);
        need(id);
        ops.push({ op: "visibility", id, visible: command.visible });
        break;
      }
      case "object.set-transform": {
        const id = objectTarget(command.target);
        const object = need(id);
        const scale = command.scale;
        if (scale && object.bodyType !== "none" && !same(scale, object.scale)) {
          fail(`${label} 已有刚体的物体不支持改缩放；请先创建/摆位再 set-body，或保持原缩放`);
        }
        if (scale) object.scale = scale;
        ops.push({
          op: "transform", id,
          ...(command.position ? { position: command.position } : {}),
          ...(command.rotation ? { rotation: command.rotation } : {}),
          ...(scale ? { scale } : {}),
        });
        break;
      }
      case "object.set-parent":
        return fail(`${label} v1 为扁平世界，不支持层级；请直接写世界坐标`);
      default:
        if (!NOOP_COMMANDS.has(command.type)) fail(`${label} 无头世界不支持该命令`);
    }
    commandResults.push({ id: command.id, type: command.type, status: NOOP_COMMANDS.has(command.type) ? "noop" : "applied" });
  }

  for (const [index, physics] of (action.physics ?? []).entries()) {
    const label = `physics[${index}](${physics.type})`;
    const object = need(physics.objectId);
    if (physics.type === "set-body") {
      const next = physics.body.type;
      if (next !== "none" && !object.hasCollider) fail(`${label} ${physics.objectId} 没有可用碰撞体`);
      if (next === "none" && object.bodyType !== "none") fail(`${label} 已有刚体的物体不能退回 none；请删除后重建`);
      object.bodyType = next;
      ops.push({ op: "set-body", id: physics.objectId, body: physics.body });
    } else {
      if (object.bodyType !== "dynamic") fail(`${label} 只能作用于动态刚体（${physics.objectId} 当前为 ${object.bodyType}）`);
      const vector = physics.type === "apply-impulse" ? physics.impulse : physics.velocity;
      ops.push({ op: physics.type === "apply-impulse" ? "impulse" : physics.type === "set-linear-velocity" ? "linear-velocity" : "angular-velocity", id: physics.objectId, vector });
    }
  }
  for (const event of action.events ?? []) ops.push({ op: "event", name: event.name, ...(event.data !== undefined ? { data: event.data } : {}) });
  return { ops, commandResults };
}
