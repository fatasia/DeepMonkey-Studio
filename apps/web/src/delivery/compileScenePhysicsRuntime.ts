import type { SceneSnapshot, ScenePhysicsColliderState, Vector3Value } from "@bim-studio/contracts";
import type { DynamicPhysicsRuntime } from "@bim-studio/deep-engine/runtime-package";
import type { SceneRenderCompilation } from "./compileSceneRenderPacket";

export interface CompileScenePhysicsRuntimeOptions {
  readonly objectBindings: SceneRenderCompilation["objectBindings"];
  readonly coordinateOrigin: Vector3Value;
}

/** Compiles authored rigid bodies into deterministic commands whose colliders
 * are resolved from the already-frozen render packet rather than editor state.
 * kinematic 刚体保留作者位姿作为 Native 的初始位姿（Native 不消费角色控制器，见 B3-b 边界）。
 * 作者 collider（T17 来源规范）按判别联合下译：凸包/简化网格几何位于刚体局部空间，
 * 必须携带精度标记；省略 collider 时保持 render-bounds 现状。 */
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
      if (state.initialLinearVelocity && (state.type !== "dynamic"
        || !Object.values(state.initialLinearVelocity).every(value => Number.isFinite(value) && Math.abs(value) <= 1_000))) {
        throw new Error(`物理对象 ${item.modelId} 的初速度要求 dynamic 且各轴在 ±1000 m/s 内`);
      }
      const collider = compileCollider(state.collider, item.modelId, instanceIds);
      return { id: item.modelId, type: state.type as "fixed" | "dynamic" | "kinematic",
        initialPose: { translation: vector(item.transform.position), rotation: quaternion(item.transform.rotation) }, mass: state.mass,
        friction: state.friction, restitution: state.restitution,
        ...(state.character ? { character: cloneCharacter(state.character) } : {}),
        ...(state.initialLinearVelocity ? { initialLinearVelocity: vector(state.initialLinearVelocity) } : {}),
        collider };
    }).sort((left, right) => compare(left.id, right.id));
  if (!bodies.length) throw new Error("已启用物理场景但没有可编译的刚体");
  const bodyIds = new Set(bodies.map(body => body.id));
  const joints = [...(scene.physics.joints ?? [])].map(joint => {
    if (joint.kind !== "revolute" && joint.kind !== "prismatic") {
      throw new Error(`关节 ${joint.id} 的类型不受 Native 运行包支持`);
    }
    const solver = joint.solver ?? "impulse";
    if (joint.kind === "prismatic" && solver !== "impulse") {
      throw new Error(`关节 ${joint.id} 的 prismatic 仅支持 impulse 求解器`);
    }
    if (!bodyIds.has(joint.bodyId) || joint.connectedBodyId && !bodyIds.has(joint.connectedBodyId)) {
      throw new Error(`关节 ${joint.id} 引用了未编译的刚体`);
    }
    if (joint.connectedBodyId === joint.bodyId) throw new Error(`关节 ${joint.id} 不能连接同一刚体`);
    // T17 位置伺服:multibody 拒绝、motor.enabled 是总开关;gain fail-closed(零刚度伺服无意义,damping 非负)。
    const position = joint.motor.position;
    if (position && (position.enabled && (solver === "multibody" || !joint.motor.enabled)
      || !Number.isFinite(position.target) || !Number.isFinite(position.stiffness) || position.stiffness <= 0
      || !Number.isFinite(position.damping) || position.damping < 0)) {
      throw new Error(`关节 ${joint.id} 的位置伺服参数无效`);
    }
    if (solver === "multibody" && (joint.limits.enabled || joint.motor.enabled)) {
      throw new Error(`关节 ${joint.id} 的 multibody 限位或马达尚不受支持`);
    }
    return { ...joint, solver, connectedBodyId: joint.connectedBodyId ?? null,
      worldAnchor: [joint.worldAnchor.x - options.coordinateOrigin.x, joint.worldAnchor.y - options.coordinateOrigin.y,
        joint.worldAnchor.z - options.coordinateOrigin.z] as const,
      localAnchor: vector(joint.localAnchor), axis: vector(joint.axis) };
  }).sort((left, right) => compare(left.id, right.id));
  // T17 齿轮耦合:driver/follower 必须是既有 impulse 同类关节;ratio 非零、gain 有效。
  const jointById = new Map(joints.map(joint => [joint.id, joint] as const));
  const gears = [...(scene.physics.gears ?? [])].map(gear => {
    const driver = jointById.get(gear.driverJointId), follower = jointById.get(gear.followerJointId);
    if (!driver || !follower || gear.driverJointId === gear.followerJointId
      || driver.kind !== follower.kind || driver.solver !== "impulse" || follower.solver !== "impulse"
      || !Number.isFinite(gear.ratio) || gear.ratio === 0
      || !Number.isFinite(gear.stiffness) || gear.stiffness <= 0
      || !Number.isFinite(gear.damping) || gear.damping < 0) {
      throw new Error(`齿轮耦合 ${gear.id} 引用了无效或不匹配的关节`);
    }
    return { id: gear.id, driverJointId: gear.driverJointId, followerJointId: gear.followerJointId,
      ratio: gear.ratio, stiffness: gear.stiffness, damping: gear.damping };
  }).sort((left, right) => compare(left.id, right.id));
  return { schema: "deep-engine.physics-runtime", schemaVersion: 1, enabled: true,
    playing: scene.physics.playing, gravity: vector(scene.physics.gravity), bodies, joints,
    ...(gears.length ? { gears } : {}) };
}

/** 作者 collider → 运行包判别联合;fail-closed:几何缺失/越界/generated 缺精度标记一律拒绝。 */
function compileCollider(
  state: ScenePhysicsColliderState | undefined,
  modelId: string,
  instanceIds: readonly string[],
): DynamicPhysicsRuntime["bodies"][number]["collider"] {
  const precision = state?.precision === undefined ? undefined : {
    ...(state.precision.approximate === undefined ? {} : { approximate: state.precision.approximate }),
    ...(state.precision.reasons === undefined ? {} : { reasons: [...state.precision.reasons] }),
    ...(state.precision.tolerance === undefined ? {} : { tolerance: state.precision.tolerance }),
    ...(state.precision.hullVertexCount === undefined ? {} : { hullVertexCount: state.precision.hullVertexCount }),
    ...(state.precision.triangleCount === undefined ? {} : { triangleCount: state.precision.triangleCount }),
    ...(state.precision.topologyOk === undefined ? {} : { topologyOk: state.precision.topologyOk }),
    ...(state.precision.topologyIssueCodes === undefined ? {} : { topologyIssueCodes: [...state.precision.topologyIssueCodes] }),
    ...(state.precision.concaveSource === undefined ? {} : { concaveSource: state.precision.concaveSource }),
  };
  if (state === undefined || state.kind === "render-bounds") {
    return { kind: "render-bounds", instanceIds, ...(precision ? { precision } : {}) };
  }
  if (state.kind === "convex-hull") {
    const points = (state.points ?? []).map(point => vector(point));
    if (points.length < 4 || !points.every(point => point.every(Number.isFinite))) {
      throw new Error(`物理对象 ${modelId} 的凸包 collider 至少需要 4 个有限顶点`);
    }
    if (!precision) throw new Error(`物理对象 ${modelId} 的凸包 collider 缺少精度标记`);
    return { kind: "convex-hull", instanceIds, points, precision };
  }
  if (state.kind === "simplified-mesh") {
    const positions = (state.positions ?? []).map(point => vector(point));
    const indices = state.indices ?? [];
    if (positions.length < 3 || !positions.every(point => point.every(Number.isFinite))
      || indices.length < 3 || indices.length % 3 !== 0
      || !indices.every(index => Number.isInteger(index) && index >= 0 && index < positions.length)) {
      throw new Error(`物理对象 ${modelId} 的简化网格 collider 几何无效`);
    }
    if (!precision) throw new Error(`物理对象 ${modelId} 的简化网格 collider 缺少精度标记`);
    return { kind: "simplified-mesh", instanceIds, positions, indices: [...indices], precision };
  }
  const primitive = state.primitive;
  if (!primitive) throw new Error(`物理对象 ${modelId} 的 primitive collider 缺少显式几何`);
  if (primitive.shape === "cuboid") {
    const halfExtents = primitive.halfExtents;
    if (!halfExtents || ![halfExtents.x, halfExtents.y, halfExtents.z].every(value => Number.isFinite(value) && value > 0)) {
      throw new Error(`物理对象 ${modelId} 的 cuboid collider 需要正的半尺寸`);
    }
    return { kind: "primitive", instanceIds, primitive: { shape: "cuboid", halfExtents: vector(halfExtents) }, ...(precision ? { precision } : {}) };
  }
  if (primitive.shape === "sphere") {
    if (!Number.isFinite(primitive.radius) || (primitive.radius ?? 0) <= 0) {
      throw new Error(`物理对象 ${modelId} 的 sphere collider 需要正半径`);
    }
    return { kind: "primitive", instanceIds, primitive: { shape: "sphere", radius: primitive.radius! }, ...(precision ? { precision } : {}) };
  }
  if (!Number.isFinite(primitive.radius) || (primitive.radius ?? 0) <= 0
    || !Number.isFinite(primitive.halfHeight) || (primitive.halfHeight ?? 0) <= 0) {
    throw new Error(`物理对象 ${modelId} 的 cylinder collider 需要正半径与半高`);
  }
  return { kind: "primitive", instanceIds, primitive: { shape: "cylinder", radius: primitive.radius!, halfHeight: primitive.halfHeight! }, ...(precision ? { precision } : {}) };
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
