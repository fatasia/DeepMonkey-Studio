import type { SceneGearConstraintState, ScenePhysicsJointState, Vector3Value } from "@bim-studio/contracts";
import type Rapier from "@dimforge/rapier3d-compat";
import type {
  JointData,
  MultibodyJoint,
  PrismaticImpulseJoint,
  RevoluteImpulseJoint,
  RigidBody,
  World,
} from "@dimforge/rapier3d-compat";

export interface MountedRapierJoint {
  readonly solver: "impulse" | "multibody";
  readonly joint: RevoluteImpulseJoint | PrismaticImpulseJoint | MultibodyJoint;
}

const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(finite(value), min), max);
const vector = (value: Vector3Value): Vector3Value => ({
  x: finite(value.x), y: finite(value.y), z: finite(value.z),
});

export function normalizePhysicsJoints(joints: readonly ScenePhysicsJointState[] | undefined): ScenePhysicsJointState[] {
  const ids = new Set<string>();
  const normalized = (joints ?? []).flatMap((source) => {
    const id = source.id.trim(), bodyId = source.bodyId.trim();
    const connectedBodyId = source.connectedBodyId?.trim();
    const solver = source.solver === "multibody" ? "multibody" : "impulse";
    // prismatic 走冲量求解器;multibody(缩并坐标)保持纯 revolute。
    const kindSupported = source.kind === "revolute" || (source.kind === "prismatic" && solver === "impulse");
    if (!id || !bodyId || connectedBodyId === bodyId || !kindSupported || ids.has(id)
      || (solver === "multibody" && (source.limits.enabled || source.motor.enabled || source.motor.position?.enabled))) return [];
    ids.add(id);
    const axis = vector(source.axis);
    const length = Math.hypot(axis.x, axis.y, axis.z);
    const normalizedAxis = length > 1e-6
      ? { x: axis.x / length, y: axis.y / length, z: axis.z / length }
      : { x: 0, y: 1, z: 0 };
    // revolute 限位为弧度(±2π);prismatic 为米,用与初速度一致的 ±100 m 幅度。
    const limitRange = source.kind === "prismatic" ? 100 : Math.PI * 2;
    const firstLimit = clamp(source.limits.min, -limitRange, limitRange);
    const secondLimit = clamp(source.limits.max, -limitRange, limitRange);
    return [{
      id,
      kind: source.kind,
      ...(solver === "multibody" ? { solver } : {}),
      bodyId,
      ...(connectedBodyId ? { connectedBodyId } : {}),
      worldAnchor: vector(source.worldAnchor),
      localAnchor: vector(source.localAnchor),
      axis: normalizedAxis,
      limits: {
        enabled: Boolean(source.limits.enabled),
        min: Math.min(firstLimit, secondLimit),
        max: Math.max(firstLimit, secondLimit),
      },
      motor: {
        enabled: Boolean(source.motor.enabled) || Boolean(source.motor.position?.enabled),
        targetVelocity: clamp(source.motor.targetVelocity, -100, 100),
        strength: clamp(source.motor.strength, 0, 1_000_000),
        ...(source.motor.position === undefined ? {} : {
          position: {
            enabled: Boolean(source.motor.position.enabled),
            target: clamp(source.motor.position.target,
              source.kind === "prismatic" ? -100 : -Math.PI * 2, source.kind === "prismatic" ? 100 : Math.PI * 2),
            stiffness: clamp(source.motor.position.stiffness, 0, 1_000_000),
            damping: clamp(source.motor.position.damping, 0, 1_000_000),
          },
        }),
      },
    } satisfies ScenePhysicsJointState];
  });
  return validMultibodyTopology(normalized) ? normalized : normalized.filter(joint => joint.solver !== "multibody");
}

/** T17 齿轮耦合归一:仅保留引用既有 impulse 同类关节、ratio/gain 有限有效的耦合。 */
export function normalizePhysicsGears(
  gears: readonly SceneGearConstraintState[] | undefined,
  joints: readonly ScenePhysicsJointState[],
): SceneGearConstraintState[] {
  const byId = new Map(joints.map(joint => [joint.id, joint]));
  const ids = new Set<string>();
  return (gears ?? []).filter(gear => {
    const id = gear.id.trim();
    const driver = byId.get(gear.driverJointId), follower = byId.get(gear.followerJointId);
    const valid = Boolean(id) && !ids.has(id) && Boolean(driver) && Boolean(follower)
      && driver!.id !== follower!.id && driver!.kind === follower!.kind
      && driver!.solver !== "multibody" && follower!.solver !== "multibody"
      && Number.isFinite(gear.ratio) && gear.ratio !== 0
      && Number.isFinite(gear.stiffness) && gear.stiffness > 0
      && Number.isFinite(gear.damping) && gear.damping >= 0;
    if (valid) ids.add(id);
    return valid;
  }).map(gear => ({
    id: gear.id.trim(), driverJointId: gear.driverJointId, followerJointId: gear.followerJointId,
    ratio: gear.ratio, stiffness: gear.stiffness, damping: gear.damping,
  }));
}

function validMultibodyTopology(joints: readonly ScenePhysicsJointState[]): boolean {  const parentByBody = new Map<string, string>();
  for (const joint of joints) {
    if (joint.solver !== "multibody") continue;
    if (parentByBody.has(joint.bodyId)) return false;
    parentByBody.set(joint.bodyId, joint.connectedBodyId ?? "$world");
  }
  for (const bodyId of parentByBody.keys()) {
    const visited = new Set<string>();
    let current: string | undefined = bodyId;
    while (current && current !== "$world") {
      if (visited.has(current)) return false;
      visited.add(current);
      current = parentByBody.get(current);
    }
  }
  return true;
}

export function mountRapierJoint(
  rapier: typeof Rapier,
  world: World,
  connectedBody: RigidBody,
  modelBody: RigidBody,
  state: ScenePhysicsJointState,
): MountedRapierJoint {
  if (state.solver !== "multibody") {
    return {
      solver: "impulse",
      joint: state.kind === "prismatic"
        ? mountRapierPrismaticJoint(rapier, world, connectedBody, modelBody, state)
        : mountRapierRevoluteJoint(rapier, world, connectedBody, modelBody, state),
    };
  }
  const connectedAnchor = state.connectedBodyId
    ? worldPointToBodyLocal(connectedBody, state.worldAnchor)
    : state.worldAnchor;
  const descriptor = rapier.JointData.revolute(connectedAnchor, state.localAnchor, state.axis);
  return { solver: "multibody", joint: world.createMultibodyJoint(descriptor, connectedBody, modelBody, true) };
}

export function removeMountedRapierJoint(world: World, runtime: MountedRapierJoint): void {
  if (!runtime.joint.isValid()) return;
  if (runtime.solver === "multibody") world.removeMultibodyJoint(runtime.joint as MultibodyJoint, true);
  else world.removeImpulseJoint(runtime.joint as RevoluteImpulseJoint, true);
}

export function mountRapierRevoluteJoint(
  rapier: typeof Rapier,
  world: World,
  connectedBody: RigidBody,
  modelBody: RigidBody,
  state: ScenePhysicsJointState,
): RevoluteImpulseJoint {
  const joint = createRapierUnitJoint(
    (connectedAnchor, localAnchor, axis) => rapier.JointData.revolute(connectedAnchor, localAnchor, axis),
    rapier, world, connectedBody, modelBody, state,
  ) as RevoluteImpulseJoint;
  return joint;
}

export function mountRapierPrismaticJoint(
  rapier: typeof Rapier,
  world: World,
  connectedBody: RigidBody,
  modelBody: RigidBody,
  state: ScenePhysicsJointState,
): PrismaticImpulseJoint {
  return createRapierUnitJoint(
    (connectedAnchor, localAnchor, axis) => rapier.JointData.prismatic(connectedAnchor, localAnchor, axis),
    rapier, world, connectedBody, modelBody, state,
  ) as PrismaticImpulseJoint;
}

/** revolute/prismatic 共享的冲量关节装载：锚点换算、限位与速度马达语义一致。 */
function createRapierUnitJoint(
  descriptor: (connectedAnchor: Vector3Value, localAnchor: Vector3Value, axis: Vector3Value) => JointData,
  rapier: typeof Rapier,
  world: World,
  connectedBody: RigidBody,
  modelBody: RigidBody,
  state: ScenePhysicsJointState,
): RevoluteImpulseJoint | PrismaticImpulseJoint {
  const connectedAnchor = state.connectedBodyId
    ? worldPointToBodyLocal(connectedBody, state.worldAnchor)
    : state.worldAnchor;
  const joint = world.createImpulseJoint(
    descriptor(connectedAnchor, state.localAnchor, state.axis), connectedBody, modelBody, true,
  ) as RevoluteImpulseJoint | PrismaticImpulseJoint;
  if (state.limits.enabled) joint.setLimits(state.limits.min, state.limits.max);
  if (state.motor.enabled || state.motor.position?.enabled) {
    // 位置伺服走加速度基模型(增益与刚体惯量解耦,与 Native 同口径);
    // 速度马达保持 ForceBased(与 T17 既有速度马达黄金同口径)。
    joint.configureMotorModel(state.motor.position?.enabled ? rapier.MotorModel.AccelerationBased : rapier.MotorModel.ForceBased);
    // T17 位置伺服:enabled 时 configureMotorPosition 覆盖速度目标(target 为关节坐标)。
    if (state.motor.position?.enabled) {
      joint.configureMotorPosition(state.motor.position.target, state.motor.position.stiffness, state.motor.position.damping);
    } else {
      joint.configureMotorVelocity(state.motor.targetVelocity, state.motor.strength);
    }
  }
  return joint;
}

function worldPointToBodyLocal(body: RigidBody, point: Vector3Value): Vector3Value {  const translation = body.translation(), rotation = body.rotation();
  const x = point.x - translation.x, y = point.y - translation.y, z = point.z - translation.z;
  // Rotate by the inverse unit quaternion. Rapier owns normalization of rigid-body rotations.
  const ix = rotation.w * x - rotation.y * z + rotation.z * y;
  const iy = rotation.w * y - rotation.z * x + rotation.x * z;
  const iz = rotation.w * z - rotation.x * y + rotation.y * x;
  const iw = rotation.x * x + rotation.y * y + rotation.z * z;
  return {
    x: ix * rotation.w + iw * rotation.x + iy * rotation.z - iz * rotation.y,
    y: iy * rotation.w + iw * rotation.y + iz * rotation.x - ix * rotation.z,
    z: iz * rotation.w + iw * rotation.z + ix * rotation.y - iy * rotation.x,
  };
}

/** T17 齿轮耦合端点:耦合器从该关节的 model body 世界姿态/平移读取关节坐标。 */
export interface RapierGearCouplingEndpoint {
  readonly kind: "revolute" | "prismatic";
  readonly axis: Vector3Value;
  readonly body: RigidBody;
  readonly joint: RevoluteImpulseJoint | PrismaticImpulseJoint;
}

export interface MountedRapierGearCoupling {
  /** 每个固定步 world.step 之前调用一次:读主动坐标、伺服从动位置马达。 */
  update(): void;
}

/**
 * T17 齿轮耦合:从动关节坐标 = ratio × 主动关节坐标(负 ratio = 外啮合反向)。
 * 两端 Rapier 均无原生齿轮约束,以从动侧位置马达伺服跟随实现,由宿主每步驱动;
 * 读角/unwrap 规则与 Native `GearCoupling` 逐位同构(轴投影 + 逐步最短角连续化,
 * 与 T17 机构黄金 unwrap 先例同语义)。driver 连接固定体时关节坐标=世界投影量。
 */
export function mountRapierGearCoupling(
  rapier: typeof Rapier,
  driver: RapierGearCouplingEndpoint,
  follower: RapierGearCouplingEndpoint,
  coupling: { ratio: number; stiffness: number; damping: number },
): MountedRapierGearCoupling {
  const axis = vector(driver.axis);
  const initial = driver.body.translation();
  let previousRaw: number | undefined;
  let continuous = 0;
  const dot = (a: Vector3Value, b: Vector3Value) => a.x * b.x + a.y * b.y + a.z * b.z;
  // 位置伺服用加速度基模型:增益与从动体惯量解耦(ForceBased 下小惯量轮的等效
  // ωn·dt 远超稳定界,实测过主值折叠点后极限环发散,从动轮被踹到 -27 rad/s)。
  follower.joint.configureMotorModel(rapier.MotorModel.AccelerationBased);
  return {
    update(): void {
      if (driver.kind === "revolute") {
        const raw = rotationAngleAroundAxis(driver.body.rotation(), axis);
        continuous = previousRaw === undefined ? 0 : continuous + wrapToPi(raw - previousRaw);
        previousRaw = raw;
      } else {
        const translation = driver.body.translation();
        continuous = dot({ x: translation.x - initial.x, y: translation.y - initial.y, z: translation.z - initial.z }, axis);
      }
      // 速度前馈:ratio × 主动轴角/线速度,抵消 PD 伺服跟踪斜坡目标的稳态滞后,
      // 使从动累计坐标比在稳态下逼近设定传动比(与 Native `GearCoupling` 同构)。
      const feedforward = coupling.ratio * (driver.kind === "revolute"
        ? dot(driver.body.angvel(), axis)
        : dot(driver.body.linvel(), axis));
      // 位置 target wrap 到主值域:Rapier 关节角按主值口径参与误差计算,连续多圈
      // target 会与内部口径失配产生巨误差脉冲(实测从动轮过 3π 即失控);主值域
      // target 与前馈速度组合后跟踪仍连续。
      const target = driver.kind === "revolute"
        ? wrapToPi(coupling.ratio * continuous)
        : coupling.ratio * continuous;
      follower.joint.configureMotor(target, feedforward, coupling.stiffness, coupling.damping);
    },
  };
}

/** 绕单位轴的有符号投影角;四元数 ±q 双覆盖由逐步 unwrap 吸收(±2π 假跳变)。 */
function rotationAngleAroundAxis(
  rotation: { w: number; x: number; y: number; z: number }, axis: Vector3Value,
): number {
  return 2 * Math.atan2(
    rotation.x * axis.x + rotation.y * axis.y + rotation.z * axis.z, rotation.w,
  );
}

function wrapToPi(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}
