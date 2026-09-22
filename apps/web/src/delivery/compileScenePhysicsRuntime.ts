import type { SceneSnapshot, Vector3Value } from "@bim-studio/contracts";
import type { DynamicPhysicsRuntime } from "@bim-studio/deep-engine/runtime-package";
import type { SceneRenderCompilation } from "./compileSceneRenderPacket";

export interface CompileScenePhysicsRuntimeOptions {
  readonly objectBindings: SceneRenderCompilation["objectBindings"];
  readonly coordinateOrigin: Vector3Value;
}

/** Compiles authored rigid bodies into deterministic commands whose colliders
 * are resolved from the already-frozen render packet rather than editor state.
 * kinematic 刚体保留作者位姿作为 Native 的初始位姿（Native 不消费角色控制器，见 B3-b 边界）。 */
export function compileScenePhysicsRuntime(
  scene: SceneSnapshot,
  options: CompileScenePhysicsRuntimeOptions,
): DynamicPhysicsRuntime | undefined {
  if (!scene.physics?.enabled) return;
  const bindings = new Map(options.objectBindings.map(binding => [binding.nodeId, binding.instanceIds]));
  const bodies = [...scene.models, ...scene.primitives]
    .filter(item => item.physics !== undefined && item.physics.type !== "none")
    .map(item => {
      const state = item.physics!;
      if (state.type !== "fixed" && state.type !== "dynamic" && state.type !== "kinematic") {
        throw new Error(`物理对象 ${item.modelId} 的刚体类型不受支持`);
      }
      const instanceIds = [...(bindings.get(item.modelId) ?? [])].sort(compare);
      if (!instanceIds.length) throw new Error(`物理对象 ${item.modelId} 没有可用于碰撞体的运行实例`);
      if (!Number.isFinite(state.mass) || state.mass <= 0 || !Number.isFinite(state.friction)
        || state.friction < 0 || state.friction > 2 || !Number.isFinite(state.restitution)
        || state.restitution < 0 || state.restitution > 1) {
        throw new Error(`物理对象 ${item.modelId} 的质量或碰撞系数无效`);
      }
      // 角色控制器只有 kinematic 刚体能承载；其他类型带该字段说明作者数据自相矛盾。
      if (state.character && state.type !== "kinematic") {
        throw new Error(`物理对象 ${item.modelId} 的角色控制器要求 kinematic 刚体`);
      }
      return { id: item.modelId, type: state.type as "fixed" | "dynamic" | "kinematic",
        initialPose: { translation: vector(item.transform.position), rotation: quaternion(item.transform.rotation) }, mass: state.mass,
        friction: state.friction, restitution: state.restitution,
        ...(state.character ? { character: cloneCharacter(state.character) } : {}),
        collider: { kind: "render-bounds" as const, instanceIds } };
    }).sort((left, right) => compare(left.id, right.id));
  if (!bodies.length) throw new Error("已启用物理场景但没有可编译的刚体");
  const bodyIds = new Set(bodies.map(body => body.id));
  const joints = [...(scene.physics.joints ?? [])].map(joint => {
    if (joint.kind !== "revolute") throw new Error(`关节 ${joint.id} 的类型不受 Native 运行包支持`);
    const solver = joint.solver ?? "impulse";
    if (!bodyIds.has(joint.bodyId) || joint.connectedBodyId && !bodyIds.has(joint.connectedBodyId)) {
      throw new Error(`关节 ${joint.id} 引用了未编译的刚体`);
    }
    if (joint.connectedBodyId === joint.bodyId) throw new Error(`关节 ${joint.id} 不能连接同一刚体`);
    if (solver === "multibody" && (joint.limits.enabled || joint.motor.enabled)) {
      throw new Error(`关节 ${joint.id} 的 multibody 限位或马达尚不受支持`);
    }
    return { ...joint, solver, connectedBodyId: joint.connectedBodyId ?? null,
      worldAnchor: [joint.worldAnchor.x - options.coordinateOrigin.x, joint.worldAnchor.y - options.coordinateOrigin.y,
        joint.worldAnchor.z - options.coordinateOrigin.z] as const,
      localAnchor: vector(joint.localAnchor), axis: vector(joint.axis) };
  }).sort((left, right) => compare(left.id, right.id));
  return { schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true,
    playing: scene.physics.playing, gravity: vector(scene.physics.gravity), bodies, joints };
}

function vector(value: Vector3Value): readonly [number, number, number] {
  return [value.x, value.y, value.z];
}
function quaternion(value: Vector3Value): readonly [number, number, number, number] {
  const cx = Math.cos(value.x / 2), sx = Math.sin(value.x / 2), cy = Math.cos(value.y / 2), sy = Math.sin(value.y / 2), cz = Math.cos(value.z / 2), sz = Math.sin(value.z / 2);
  return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
}
function cloneCharacter(state: NonNullable<import("@bim-studio/contracts").ScenePhysicsBodyState["character"]>): NonNullable<DynamicPhysicsRuntime["bodies"][number]["character"]> {
  return {
    ...(state.offset === undefined ? {} : { offset: state.offset }),
    ...(state.maxSlopeClimbAngle === undefined ? {} : { maxSlopeClimbAngle: state.maxSlopeClimbAngle }),
    ...(state.minSlopeSlideAngle === undefined ? {} : { minSlopeSlideAngle: state.minSlopeSlideAngle }),
    ...(state.autostep === undefined ? {} : { autostep: { ...state.autostep } }),
    ...(state.snapToGround === undefined ? {} : { snapToGround: { ...state.snapToGround } }),
  };
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
