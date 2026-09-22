import type { ScenePhysicsJointState, Vector3Value } from "@bim-studio/contracts";
import type Rapier from "@dimforge/rapier3d-compat";
import type {
  MultibodyJoint,
  RevoluteImpulseJoint,
  RigidBody,
  World,
} from "@dimforge/rapier3d-compat";

export interface MountedRapierJoint {
  readonly solver: "impulse" | "multibody";
  readonly joint: RevoluteImpulseJoint | MultibodyJoint;
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
    if (!id || !bodyId || connectedBodyId === bodyId || source.kind !== "revolute" || ids.has(id)
      || (solver === "multibody" && (source.limits.enabled || source.motor.enabled))) return [];
    ids.add(id);
    const axis = vector(source.axis);
    const length = Math.hypot(axis.x, axis.y, axis.z);
    const normalizedAxis = length > 1e-6
      ? { x: axis.x / length, y: axis.y / length, z: axis.z / length }
      : { x: 0, y: 1, z: 0 };
    const firstLimit = clamp(source.limits.min, -Math.PI * 2, Math.PI * 2);
    const secondLimit = clamp(source.limits.max, -Math.PI * 2, Math.PI * 2);
    return [{
      id,
      kind: "revolute",
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
        enabled: Boolean(source.motor.enabled),
        targetVelocity: clamp(source.motor.targetVelocity, -100, 100),
        strength: clamp(source.motor.strength, 0, 1_000_000),
      },
    } satisfies ScenePhysicsJointState];
  });
  return validMultibodyTopology(normalized) ? normalized : normalized.filter(joint => joint.solver !== "multibody");
}

function validMultibodyTopology(joints: readonly ScenePhysicsJointState[]): boolean {
  const parentByBody = new Map<string, string>();
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
    return { solver: "impulse", joint: mountRapierRevoluteJoint(rapier, world, connectedBody, modelBody, state) };
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
  const connectedAnchor = state.connectedBodyId
    ? worldPointToBodyLocal(connectedBody, state.worldAnchor)
    : state.worldAnchor;
  const descriptor = rapier.JointData.revolute(connectedAnchor, state.localAnchor, state.axis);
  const joint = world.createImpulseJoint(descriptor, connectedBody, modelBody, true) as RevoluteImpulseJoint;
  if (state.limits.enabled) joint.setLimits(state.limits.min, state.limits.max);
  if (state.motor.enabled) {
    joint.configureMotorModel(rapier.MotorModel.ForceBased);
    joint.configureMotorVelocity(state.motor.targetVelocity, state.motor.strength);
  }
  return joint;
}

function worldPointToBodyLocal(body: RigidBody, point: Vector3Value): Vector3Value {
  const translation = body.translation(), rotation = body.rotation();
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
