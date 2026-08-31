import type { SceneRigState, SceneRobotJointState } from "@bim-studio/contracts";

export interface RobotBoneDescriptor {
  path: string;
  name: string;
  depth: number;
  linkLength: number;
}

export function normalizeRobotKinematicsState(
  robot: NonNullable<SceneRigState["robot"]>,
): NonNullable<SceneRigState["robot"]> {
  return {
    enabled: Boolean(robot.enabled),
    baseBonePath: robot.baseBonePath,
    ...(robot.toolBonePath ? { toolBonePath: robot.toolBonePath } : {}),
    ...(robot.toolObjectId ? { toolObjectId: robot.toolObjectId } : {}),
    ...(robot.targetObjectIds?.length ? { targetObjectIds: [...new Set(robot.targetObjectIds)] } : {}),
    joints: robot.joints.slice(0, 16).map(normalizeJoint),
  };
}

/** 根据模型骨骼相对位移生成首版品牌无关关节链，零长度辅助骨不作为机械臂段。 */
export function createRobotKinematicsState(
  bones: RobotBoneDescriptor[],
): NonNullable<SceneRigState["robot"]> {
  const ordered = [...bones].sort((left, right) => left.depth - right.depth);
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

function clampAngle(value: number, fallback: number): number {
  const finite = Number.isFinite(value) ? value : fallback;
  return Math.max(-360, Math.min(360, finite));
}
