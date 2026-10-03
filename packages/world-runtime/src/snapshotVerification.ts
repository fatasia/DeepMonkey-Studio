import { WORLD_LIMITS, type WorldColliderSpec, type WorldSnapshot, type WorldVec3 } from "@bim-studio/contracts";
import { GROUND_FRICTION, GROUND_HALF_EXTENTS, type Rapier, type RigidBody, type World } from "./rapierRuntime.js";
import { DYNAMIC_ANGULAR_DAMPING, DYNAMIC_LINEAR_DAMPING, scaleCollider } from "./worldObjects.js";

const near = (actual: number, expected: number) => Math.abs(actual - expected) <= 1e-5 * Math.max(1, Math.abs(expected));
const healthy = (value: number) => Number.isFinite(value) && Math.abs(value) <= WORLD_LIMITS.maxStateMagnitude;
const healthyVec = (v: { x: number; y: number; z: number }) => healthy(v.x) && healthy(v.y) && healthy(v.z);

/** 积分参数按新建世界的默认值覆盖：快照里的求解迭代数/CCD 子步是可被伪造的"耗时旋钮"，不能信客户端。 */
export function normalizeIntegration(world: World, reference: World): void {
  const target = world.integrationParameters, source = reference.integrationParameters;
  target.numSolverIterations = source.numSolverIterations;
  target.numInternalPgsIterations = source.numInternalPgsIterations;
  target.minIslandSize = source.minIslandSize;
  target.maxCcdSubsteps = source.maxCcdSubsteps;
  target.lengthUnit = source.lengthUnit;
  target.normalizedAllowedLinearError = source.normalizedAllowedLinearError;
  target.normalizedPredictionDistance = source.normalizedPredictionDistance;
}

function colliderMismatch(rapier: Rapier, body: RigidBody, expected: WorldColliderSpec): string | undefined {
  if (body.numColliders() !== 1) return `刚体含 ${body.numColliders()} 个碰撞体（应为 1）`;
  const collider = body.collider(0);
  const { ShapeType } = rapier;
  switch (expected.shape) {
    case "cuboid": {
      const half = collider.halfExtents();
      if (collider.shapeType() !== ShapeType.Cuboid || !near(half.x, expected.halfExtents[0]) || !near(half.y, expected.halfExtents[1]) || !near(half.z, expected.halfExtents[2])) return "碰撞体与对象表不一致（cuboid）";
      break;
    }
    case "ball":
      if (collider.shapeType() !== ShapeType.Ball || !near(collider.radius(), expected.radius)) return "碰撞体与对象表不一致（ball）";
      break;
    default: {
      const type = expected.shape === "cylinder" ? ShapeType.Cylinder : expected.shape === "cone" ? ShapeType.Cone : ShapeType.Capsule;
      if (collider.shapeType() !== type || !near(collider.radius(), expected.radius) || !near(collider.halfHeight(), expected.halfHeight)) return `碰撞体与对象表不一致（${expected.shape}）`;
    }
  }
  if (collider.isSensor() || collider.collisionGroups() !== 0xffffffff || collider.solverGroups() !== 0xffffffff) return "碰撞体带有非默认的传感器/分组设置";
  return undefined;
}

/**
 * 校验 Rapier 反序列化出的世界与（已通过合同校验的）对象表逐项一致。
 * 这是 restore 的资源上限防线：刚体/碰撞体/关节数量、形状尺寸、阻尼、求解附加迭代等一旦偏离
 * 对象表就拒绝，所以快照里不可能夹带"额外 2500 个碰撞体"这类 reset 永远造不出来的重负载。
 * 返回问题描述，通过则返回 undefined。
 */
export function verifyRestoredWorld(rapier: Rapier, world: World, snapshot: WorldSnapshot): string | undefined {
  const simulated = snapshot.objects.filter((object) => object.handle !== null);
  const expectedBodies = simulated.length + (snapshot.ground ? 1 : 0);
  if (world.bodies.len() !== expectedBodies) return `刚体数 ${world.bodies.len()} 与对象表 ${expectedBodies} 不一致`;
  if (world.colliders.len() !== expectedBodies) return `碰撞体数 ${world.colliders.len()} 与刚体数 ${expectedBodies} 不一致`;
  if (world.impulseJoints.len() !== 0 || world.multibodyJoints.len() !== 0) return "世界含有关节（v1 不支持关节）";
  const live = new Map<number, RigidBody>();
  world.bodies.forEach((body: RigidBody) => live.set(body.handle, body));
  const { RigidBodyType } = rapier;
  const gravity = world.gravity;
  const expectedGravity = snapshot.gravity as WorldVec3;
  if (!near(gravity.x, expectedGravity[0]) || !near(gravity.y, expectedGravity[1]) || !near(gravity.z, expectedGravity[2])) return "重力与快照字段不一致";

  for (const object of simulated) {
    const body = live.get(object.handle as number);
    if (!body || !object.collider) return `物体 ${object.id} 的刚体句柄无效`;
    const type = object.body.type;
    const expectedType = type === "dynamic" ? RigidBodyType.Dynamic : type === "kinematic" ? RigidBodyType.KinematicPositionBased : RigidBodyType.Fixed;
    if (body.bodyType() !== expectedType || !body.isEnabled()) return `物体 ${object.id} 刚体类型与对象表不一致`;
    const dynamic = type === "dynamic";
    if (body.additionalSolverIterations() !== 0 || !near(body.gravityScale(), 1) || body.dominanceGroup() !== 0
      || !near(body.linearDamping(), dynamic ? DYNAMIC_LINEAR_DAMPING : 0) || !near(body.angularDamping(), dynamic ? DYNAMIC_ANGULAR_DAMPING : 0)
      || body.isCcdEnabled() !== dynamic) return `物体 ${object.id} 含有非默认的求解设置`;
    if (!healthyVec(body.translation()) || !healthyVec(body.linvel()) || !healthyVec(body.angvel())) return `物体 ${object.id} 位姿/速度非有限或量级失常`;
    const problem = colliderMismatch(rapier, body, scaleCollider(object.collider, object.transform.scale));
    if (problem) return `物体 ${object.id}：${problem}`;
    const collider = body.collider(0);
    if (!near(collider.friction(), object.body.friction) || !near(collider.restitution(), object.body.restitution)
      || (dynamic && !near(collider.mass(), object.body.mass))) return `物体 ${object.id} 摩擦/恢复/质量与对象表不一致`;
    live.delete(object.handle as number);
  }
  if (snapshot.ground) {
    const ground = live.get(snapshot.groundHandle as number);
    const problem = ground && colliderMismatch(rapier, ground, { shape: "cuboid", halfExtents: GROUND_HALF_EXTENTS });
    if (!ground || ground.bodyType() !== RigidBodyType.Fixed || problem || !near(ground.collider(0).friction(), GROUND_FRICTION)) return "地面刚体与预期不一致";
    live.delete(snapshot.groundHandle as number);
  }
  return live.size === 0 ? undefined : `存在 ${live.size} 个未登记刚体`;
}
