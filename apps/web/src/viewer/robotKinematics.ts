import type {
  IndustrialPrefabInstanceState,
  RobotLoadCapabilityState,
  RobotPlanningEvidenceSource,
  RobotToolLoadState,
  SceneRigState,
  SceneRobotJointState,
  Vector3Value,
} from "@bim-studio/contracts";

export interface RobotBoneDescriptor {
  path: string;
  name: string;
  depth: number;
  linkLength: number;
}

export function normalizeRobotKinematicsState(
  robot: NonNullable<SceneRigState["robot"]>,
): NonNullable<SceneRigState["robot"]> {
  const loadCapability = normalizeLoadCapability(robot.loadCapability);
  const toolLoad = normalizeToolLoad(robot.toolLoad);
  return {
    enabled: Boolean(robot.enabled),
    baseBonePath: robot.baseBonePath,
    ...(robot.toolBonePath ? { toolBonePath: robot.toolBonePath } : {}),
    ...(robot.toolObjectId ? { toolObjectId: robot.toolObjectId } : {}),
    ...(robot.targetObjectIds?.length ? { targetObjectIds: [...new Set(robot.targetObjectIds)] } : {}),
    joints: robot.joints.slice(0, 16).map(normalizeJoint),
    ...(loadCapability ? { loadCapability } : {}),
    ...(toolLoad ? { toolLoad } : {}),
  };
}

/** 根据模型骨骼相对位移生成首版品牌无关关节链，零长度辅助骨不作为机械臂段。 */
export function createRobotKinematicsState(
  bones: RobotBoneDescriptor[],
  loadCapability?: RobotLoadCapabilityState,
): NonNullable<SceneRigState["robot"]> {
  const ordered = [...bones].sort((left, right) => left.depth - right.depth);
  const normalizedLoadCapability = normalizeLoadCapability(loadCapability);
  return {
    enabled: true,
    baseBonePath: ordered[0]?.path ?? "",
    ...(ordered.at(-1)?.path ? { toolBonePath: ordered.at(-1)!.path } : {}),
    joints: ordered
      .filter((bone) => bone.linkLength > 1e-4)
      .slice(0, 16)
      .map((bone) => normalizeJoint({
        bonePath: bone.path,
        name: bone.name,
        axis: "z",
        length: bone.linkLength,
        minAngleDeg: -180,
        maxAngleDeg: 180,
      })),
    ...(normalizedLoadCapability ? { loadCapability: normalizedLoadCapability } : {}),
  };
}

/** 复用资源预制体已有的额定负载，不从机器人名称或外形猜测能力。 */
export function robotLoadCapabilityFromPrefab(
  prefab: IndustrialPrefabInstanceState | undefined,
): RobotLoadCapabilityState | undefined {
  if (prefab?.kind !== "robot-arm") return undefined;
  const ratedPayloadKg = prefab.parameters.payloadKg;
  if (typeof ratedPayloadKg !== "number" || !Number.isFinite(ratedPayloadKg) || ratedPayloadKg <= 0) return undefined;
  return {
    ratedPayloadKg,
    source: "configured-prefab",
    reference: `${prefab.definitionId}@${prefab.definitionVersion}`,
  };
}

function normalizeJoint(joint: SceneRobotJointState): SceneRobotJointState {
  return {
    bonePath: joint.bonePath,
    name: joint.name,
    axis: ["x", "y", "z"].includes(joint.axis) ? joint.axis : "z",
    length: Math.max(0.001, Number.isFinite(joint.length) ? joint.length : 1),
    minAngleDeg: clampAngle(joint.minAngleDeg, -180),
    maxAngleDeg: clampAngle(joint.maxAngleDeg, 180),
  };
}

function normalizeLoadCapability(value: RobotLoadCapabilityState | undefined): RobotLoadCapabilityState | undefined {
  if (!value) return undefined;
  const normalized = {
    ...(positive(value.ratedPayloadKg) ? { ratedPayloadKg: value.ratedPayloadKg } : {}),
    ...(positive(value.maximumLoadCenterDistanceMeters)
      ? { maximumLoadCenterDistanceMeters: value.maximumLoadCenterDistanceMeters }
      : {}),
    ...(evidenceSource(value.source) ? { source: value.source } : {}),
    ...(value.reference?.trim() ? { reference: value.reference.trim() } : {}),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeToolLoad(value: RobotToolLoadState | undefined): RobotToolLoadState | undefined {
  if (!value) return undefined;
  const normalized = {
    ...(finiteVector(value.tcpPositionMeters) ? { tcpPositionMeters: { ...value.tcpPositionMeters } } : {}),
    ...(finiteVector(value.tcpOrientationEulerDeg) ? { tcpOrientationEulerDeg: { ...value.tcpOrientationEulerDeg } } : {}),
    ...(nonNegative(value.toolMassKg) ? { toolMassKg: value.toolMassKg } : {}),
    ...(nonNegative(value.carriedPayloadKg) ? { carriedPayloadKg: value.carriedPayloadKg } : {}),
    ...(finiteVector(value.combinedCenterOfMassMeters) ? { combinedCenterOfMassMeters: { ...value.combinedCenterOfMassMeters } } : {}),
    ...(evidenceSource(value.source) ? { source: value.source } : {}),
    ...(value.reference?.trim() ? { reference: value.reference.trim() } : {}),
  };
  return Object.keys(normalized).length ? normalized : undefined;
}

function clampAngle(value: number, fallback: number): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.max(-360, Math.min(360, finite));
}

function positive(value: number | undefined): value is number {
  return Number.isFinite(value) && value! > 0;
}

function nonNegative(value: number | undefined): value is number {
  return Number.isFinite(value) && value! >= 0;
}

function finiteVector(value: Vector3Value | undefined): value is Vector3Value {
  return Boolean(value && [value.x, value.y, value.z].every(Number.isFinite));
}

function evidenceSource(value: RobotPlanningEvidenceSource | undefined): value is RobotPlanningEvidenceSource {
  return value === "configured-prefab" || value === "author-confirmed" || value === "imported";
}
